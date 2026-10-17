const STORAGE_KEY = "highlights";
const HIGHLIGHT_NAME = "highlight-extension-selection";
const CONTEXT_LENGTH = 32;
const RESTORE_DEBOUNCE_MS = 120;

let pendingSelection = null;
let allHighlights = [];
let activeHighlights = [];
let resolvedRanges = new Map();
let currentPageKey = "";
let restoreTimer = null;
let lastSaveFingerprint = "";
let lastSaveTime = 0;
let lastSavedHighlightId = null;
let saveQueue = Promise.resolve();
let initializationPromise;
let unavailableApiLogged = false;
let toastElement = null;
let toastTimer = null;
let toastHighlightId = null;

function elementFor(node) {
	return node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
}

function getRangeAncestors(range) {
	const startElement = elementFor(range.startContainer);
	const commonElement = elementFor(range.commonAncestorContainer);
	const ancestors = [];
	let current = startElement;

	while (current) {
		if (current.contains(range.endContainer)) ancestors.push(current);
		if (current === commonElement) break;
		current = current.parentElement;
	}

	current = commonElement?.parentElement;
	while (current) {
		if (current.contains(range.endContainer)) ancestors.push(current);
		current = current.parentElement;
	}
	return ancestors;
}

function isFallbackMessageBlock(element, main) {
	if (!element || element === main || !["DIV", "SECTION"].includes(element.tagName)) return false;
	if (!main.contains(element) || !element.textContent?.trim()) return false;

	const parent = element.parentElement;
	if (!parent || parent === main || !main.contains(parent)) return false;
	return Array.from(parent.children).some(sibling =>
		sibling !== element &&
		["DIV", "SECTION", "ARTICLE"].includes(sibling.tagName) &&
		(sibling.textContent?.trim().length || 0) >= 16,
	);
}

function findFallbackMessageRoot(ancestors, main) {
	return ancestors.find(ancestor => isFallbackMessageBlock(ancestor, main)) || null;
}

function findMessageRoot(range) {
	const ancestors = getRangeAncestors(range);
	const semanticRoot = ancestors.find(ancestor =>
		ancestor.hasAttribute("data-message-id") ||
		ancestor.hasAttribute("data-message-author-role"),
	);
	const turnRoot = ancestors.find(ancestor =>
		ancestor.matches('[data-testid^="conversation-turn"]'),
	);
	const articleRoot = ancestors.find(ancestor => ancestor.matches("article"));
	const main = ancestors.find(ancestor => ancestor.matches("main, [role='main']")) || null;
	const fallbackRoot = main ? findFallbackMessageRoot(ancestors, main) : null;
	return semanticRoot || turnRoot || articleRoot || fallbackRoot || null;
}

function getTextOffset(root, container, offset) {
	let textOffset = 0;
	let found = false;

	function visit(node) {
		if (node === container) {
			if (node.nodeType === Node.TEXT_NODE) {
				textOffset += offset;
			} else {
				for (let index = 0; index < offset; index += 1) {
					textOffset += node.childNodes[index]?.textContent?.length || 0;
				}
			}
			found = true;
			return;
		}

		for (const child of node.childNodes) {
			if (child === container || child.contains(container)) {
				visit(child);
				return;
			}
			textOffset += child.textContent?.length || 0;
		}
	}

	visit(root);
	return found ? textOffset : -1;
}

function getMessageLocator(root) {
	return {
		tagName: root.tagName.toLowerCase(),
		messageId: root.getAttribute("data-message-id"),
		testId: root.getAttribute("data-testid"),
		authorRole: root.getAttribute("data-message-author-role"),
		id: root.id || null,
	};
}

function getConversationId(url) {
	const match = new URL(url).pathname.match(/(?:^|\/)c\/([^/]+)/);
	return match ? match[1] : null;
}

function buildAnchor(range, preferredRoot = null) {
	const exactText = range.toString();
	if (!exactText.trim()) return null;

	const messageRoot = preferredRoot?.contains(range.startContainer) && preferredRoot.contains(range.endContainer)
		? preferredRoot
		: findMessageRoot(range);
	if (!messageRoot) return null;

	const messageText = messageRoot.textContent || "";
	const startOffset = getTextOffset(messageRoot, range.startContainer, range.startOffset);
	const endOffset = getTextOffset(messageRoot, range.endContainer, range.endOffset);
	if (startOffset < 0 || endOffset < startOffset) return null;

	return {
		id: typeof crypto.randomUUID === "function"
			? crypto.randomUUID()
			: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
		exactText,
		prefix: messageText.slice(Math.max(0, startOffset - CONTEXT_LENGTH), startOffset),
		suffix: messageText.slice(endOffset, endOffset + CONTEXT_LENGTH),
		startOffset,
		endOffset,
		url: window.location.href,
		conversationId: getConversationId(window.location.href),
		messageLocator: getMessageLocator(messageRoot),
		tags: [],
		starred: false,
		createdAt: new Date().toISOString(),
	};
}

function capturePendingSelection() {
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0) return;

	const range = selection.getRangeAt(0);
	const exactText = range.toString();
	if (!exactText.trim()) return;
	if (
		pendingSelection?.selectedText === exactText &&
		pendingSelection.range.startContainer === range.startContainer &&
		pendingSelection.range.startOffset === range.startOffset &&
		pendingSelection.range.endContainer === range.endContainer &&
		pendingSelection.range.endOffset === range.endOffset
	) {
		return;
	}

	const pendingRange = range.cloneRange();
	const pendingMessageRoot = findMessageRoot(pendingRange);
	let mode = "highlight";
	let highlightId = null;
	const messageLocator = pendingMessageRoot ? getMessageLocator(pendingMessageRoot) : null;
	try {
		highlightId = findContainingHighlight(pendingRange);
		if (highlightId) mode = "remove";
	} catch (error) {
		console.error("[Highlight] context mode detection failed", error);
	}

	pendingSelection = {
		range: pendingRange,
		selectedText: exactText,
		messageRoot: pendingMessageRoot,
		messageLocator,
		mode,
		highlightId,
	};
	notifyBackgroundContextMode(mode, highlightId);
}

function clearPendingSelection(expectedSnapshot = null) {
	if (expectedSnapshot && pendingSelection !== expectedSnapshot) return;
	const hadSelection = Boolean(pendingSelection);
	pendingSelection = null;
	if (hadSelection) notifyBackgroundContextMode("highlight");
}

function notifyBackgroundContextMode(mode, highlightId) {
	chrome.runtime.sendMessage({
		type: "CONTEXT_MODE_CHANGED",
		mode,
		...(highlightId ? { highlightId } : {}),
	}, () => {
		if (chrome.runtime.lastError) {
			console.error("[Highlight] context mode update failed", chrome.runtime.lastError.message);
		}
	});
}

function getPageKey() {
	return `${window.location.origin}/${getConversationId(window.location.href) || window.location.pathname}`;
}

function belongsToCurrentPage(anchor) {
	try {
		const savedUrl = new URL(anchor.url);
		if (savedUrl.origin !== window.location.origin) return false;

		const conversationId = getConversationId(window.location.href);
		if (conversationId) return anchor.conversationId === conversationId;
		return !anchor.conversationId && savedUrl.pathname === window.location.pathname;
	} catch {
		return false;
	}
}

function refreshActiveHighlights() {
	const nextPageKey = getPageKey();
	if (nextPageKey === currentPageKey) return;

	currentPageKey = nextPageKey;
	activeHighlights = allHighlights.filter(belongsToCurrentPage);
	resolvedRanges.clear();
	renderHighlights();
}

function getMessageRoots() {
	const roots = Array.from(document.querySelectorAll(
		'article, [data-message-id], [data-message-author-role], [data-testid^="conversation-turn"]',
	));
	const main = document.querySelector("main, [role='main']");
	if (main) {
		for (const candidate of main.querySelectorAll("div, section")) {
			if (isFallbackMessageBlock(candidate, main)) roots.push(candidate);
		}
	}
	return Array.from(new Set(roots));
}

function getLocatorScore(root, locator) {
	if (!locator) return 0;
	let score = root.tagName.toLowerCase() === locator.tagName ? 0.5 : 0;
	const clues = [
		["data-message-id", locator.messageId, 8],
		["data-testid", locator.testId, 6],
		["data-message-author-role", locator.authorRole, 2],
		["id", locator.id, 6],
	];

	for (const [attribute, value, weight] of clues) {
		if (value && root.getAttribute(attribute) === value) score += weight;
	}
	return score;
}

function getTextOccurrences(text, anchor) {
	const occurrences = new Set();
	const offsetEnd = anchor.startOffset + anchor.exactText.length;
	if (text.slice(anchor.startOffset, offsetEnd) === anchor.exactText) {
		occurrences.add(anchor.startOffset);
	}

	let index = text.indexOf(anchor.exactText);
	while (index !== -1) {
		occurrences.add(index);
		index = text.indexOf(anchor.exactText, index + 1);
	}
	return Array.from(occurrences);
}

function matchingSuffixLength(expected, actual) {
	let length = 0;
	while (
		length < expected.length &&
		length < actual.length &&
		expected[expected.length - length - 1] === actual[actual.length - length - 1]
	) {
		length += 1;
	}
	return length;
}

function matchingPrefixLength(expected, actual) {
	let length = 0;
	while (length < expected.length && length < actual.length && expected[length] === actual[length]) {
		length += 1;
	}
	return length;
}

function getContextScore(text, index, anchor) {
	const before = text.slice(Math.max(0, index - anchor.prefix.length), index);
	const after = text.slice(index + anchor.exactText.length, index + anchor.exactText.length + anchor.suffix.length);
	return matchingSuffixLength(anchor.prefix, before) + matchingPrefixLength(anchor.suffix, after);
}

function getTextPosition(root, offset) {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let consumed = 0;
	let lastTextNode = null;
	let node;

	while ((node = walker.nextNode())) {
		const length = node.textContent.length;
		if (length === 0) continue;
		if (offset <= consumed + length) {
			return { node, offset: offset - consumed };
		}
		consumed += length;
		lastTextNode = node;
	}

	if (lastTextNode && offset === consumed) {
		return { node: lastTextNode, offset: lastTextNode.textContent.length };
	}
	return null;
}

function rangeFromOffsets(root, startOffset, endOffset) {
	const start = getTextPosition(root, startOffset);
	const end = getTextPosition(root, endOffset);
	if (!start || !end) return null;

	const range = document.createRange();
	range.setStart(start.node, start.offset);
	range.setEnd(end.node, end.offset);
	return range;
}

function resolveAnchor(anchor, messageRoots) {
	if (!anchor.exactText) return null;

	const candidates = messageRoots
		.map(root => ({ root, text: root.textContent || "", locatorScore: getLocatorScore(root, anchor.messageLocator) }))
		.filter(candidate => candidate.text.includes(anchor.exactText));
	if (candidates.length === 0) return null;

	const locatedCandidates = candidates.filter(candidate => candidate.locatorScore > 0);
	const searchCandidates = locatedCandidates.length > 0 ? locatedCandidates : candidates;
	const matches = [];

	for (const candidate of searchCandidates) {
		for (const index of getTextOccurrences(candidate.text, anchor)) {
			matches.push({
				...candidate,
				index,
				contextScore: getContextScore(candidate.text, index, anchor),
				distance: Math.abs(index - anchor.startOffset),
			});
		}
	}

	matches.sort((left, right) =>
		right.contextScore - left.contextScore ||
		right.locatorScore - left.locatorScore ||
		left.distance - right.distance,
	);

	for (const match of matches) {
		const range = rangeFromOffsets(
			match.root,
			match.index,
			match.index + anchor.exactText.length,
		);
		if (range?.toString() === anchor.exactText) return range;
	}
	return null;
}

function renderHighlights() {
	if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined") {
		if (!unavailableApiLogged) {
			console.warn("[Highlight] Custom Highlight API unavailable");
			unavailableApiLogged = true;
		}
		return false;
	}

	const ranges = Array.from(resolvedRanges.values()).filter(range =>
		range.startContainer.isConnected && range.endContainer.isConnected,
	);
	if (ranges.length === 0) {
		CSS.highlights.delete(HIGHLIGHT_NAME);
		return false;
	}

	try {
		CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges));
		return true;
	} catch (error) {
		console.error("[Highlight] render failed", error);
		return false;
	}
}

function dismissToast() {
	clearTimeout(toastTimer);
	toastTimer = null;
	toastHighlightId = null;
	toastElement?.remove();
	toastElement = null;
}

function showActionToast(message, actionLabel, highlightId, action) {
	dismissToast();
	if (!document.body) return;

	const toast = document.createElement("div");
	toast.className = "highlight-extension-toast";
	toast.setAttribute("role", "status");
	toast.setAttribute("aria-live", "polite");
	const label = document.createElement("span");
	label.textContent = message;
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = actionLabel;
	button.addEventListener("click", async event => {
		event.stopPropagation();
		try {
			if (await action()) dismissToast();
		} catch (error) {
			console.error("[Highlight] remove failed", error);
		}
	});
	toast.append(label, button);
	document.body.append(toast);
	toastElement = toast;
	toastHighlightId = highlightId;
	toastTimer = setTimeout(dismissToast, 5000);
}

async function removeHighlight(highlightId) {
	const stored = await chrome.storage.local.get(STORAGE_KEY);
	const highlights = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
	const updatedHighlights = highlights.filter(highlight => highlight.id !== highlightId);
	if (updatedHighlights.length === highlights.length) return false;

	await chrome.storage.local.set({ [STORAGE_KEY]: updatedHighlights });
	allHighlights = updatedHighlights;
	activeHighlights = allHighlights.filter(belongsToCurrentPage);
	resolvedRanges.delete(highlightId);
	if (lastSavedHighlightId === highlightId) {
		lastSavedHighlightId = null;
		lastSaveFingerprint = "";
		lastSaveTime = 0;
	}
	renderHighlights();
	if (toastHighlightId === highlightId) dismissToast();
	return true;
}

function findContainingHighlight(pendingRange) {
	const matches = [];
	for (const [id, existingRange] of resolvedRanges) {
		if (!existingRange.startContainer.isConnected || !existingRange.endContainer.isConnected) continue;
		try {
			const containsStart = existingRange.compareBoundaryPoints(Range.START_TO_START, pendingRange) <= 0;
			const containsEnd = existingRange.compareBoundaryPoints(Range.END_TO_END, pendingRange) >= 0;
			if (containsStart && containsEnd) matches.push(id);
		} catch (error) {
			console.warn("[Highlight] live range comparison failed", id, error);
		}
	}
	if (matches.length > 1) {
		console.warn("[Highlight] ambiguous live highlight match", matches.length);
		return null;
	}
	if (matches.length === 0) {
		return null;
	}
	return matches[0];
}

function getCaretPoint(x, y) {
	if (document.caretPositionFromPoint) {
		const position = document.caretPositionFromPoint(x, y);
		return position ? { node: position.offsetNode, offset: position.offset } : null;
	}
	const range = document.caretRangeFromPoint?.(x, y);
	return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

function findHighlightAtPoint(x, y) {
	const point = getCaretPoint(x, y);
	if (!point) return null;
	const matches = [];
	for (const [id, range] of resolvedRanges) {
		if (
			range.startContainer.isConnected &&
			range.endContainer.isConnected &&
			allHighlights.some(highlight => highlight.id === id) &&
			range.comparePoint(point.node, point.offset) === 0
		) {
			matches.push(id);
		}
	}
	return matches.length === 1 ? matches[0] : null;
}

document.addEventListener("click", event => {
	if (toastElement?.contains(event.target)) return;
	const highlightId = findHighlightAtPoint(event.clientX, event.clientY);
	if (!highlightId) return;
	showActionToast("Highlighted text", "Remove highlight", highlightId, () => removeHighlight(highlightId));
});

function restoreHighlights() {
	refreshActiveHighlights();
	const unresolved = activeHighlights.filter(anchor => !resolvedRanges.has(anchor.id));
	if (unresolved.length === 0) return;

	const messageRoots = getMessageRoots();
	let changed = false;

	for (const anchor of unresolved) {
		const range = resolveAnchor(anchor, messageRoots);
		if (range) {
			resolvedRanges.set(anchor.id, range);
			changed = true;
		}
	}

	if (changed) renderHighlights();
}

function scheduleRestore() {
	clearTimeout(restoreTimer);
	restoreTimer = setTimeout(restoreHighlights, RESTORE_DEBOUNCE_MS);
}

function isWithinMessage(node) {
	const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
	return Boolean(element?.closest('article, [data-message-id], [data-message-author-role], [data-testid^="conversation-turn"]'));
}

function containsMessage(node) {
	if (node.nodeType !== Node.ELEMENT_NODE) return isWithinMessage(node);
	return isWithinMessage(node) || Boolean(node.querySelector(
		'article, [data-message-id], [data-message-author-role], [data-testid^="conversation-turn"]',
	)) || Boolean(node.closest("main, [role='main']"));
}

function removeDisconnectedRanges() {
	let changed = false;
	for (const [id, range] of resolvedRanges) {
		const anchor = activeHighlights.find(highlight => highlight.id === id);
		if (
			!range.startContainer.isConnected ||
			!range.endContainer.isConnected ||
			!anchor ||
			range.toString() !== anchor.exactText
		) {
			resolvedRanges.delete(id);
			changed = true;
		}
	}
	if (changed) renderHighlights();
	return changed;
}

function startRestoreObserver() {
	const observer = new MutationObserver(records => {
		const pageChanged = getPageKey() !== currentPageKey;
		const disconnected = removeDisconnectedRanges();
		const relevantMutation = records.some(record =>
			isWithinMessage(record.target) || Array.from(record.addedNodes).some(containsMessage),
		);
		const hasUnresolved = activeHighlights.some(anchor => !resolvedRanges.has(anchor.id));

		if (pageChanged || disconnected || (relevantMutation && hasUnresolved)) scheduleRestore();
	});
	observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
	window.addEventListener("popstate", scheduleRestore);
	window.addEventListener("hashchange", scheduleRestore);
}

function commandError(stage, error) {
	const commandFailure = new Error(error instanceof Error ? error.message : String(error));
	commandFailure.stage = stage;
	return commandFailure;
}

async function saveSelection(pending) {
	if (
		!pending?.range ||
		!pending.selectedText?.trim() ||
		!pending.range.startContainer.isConnected ||
		!pending.range.endContainer.isConnected ||
		pending.range.toString() !== pending.selectedText ||
		!pending.range.toString().trim()
	) {
		throw commandError("pending-selection", "NO_PENDING_SELECTION");
	}
	const range = pending.range.cloneRange();

	let anchor;
	try {
		anchor = buildAnchor(range, pending.messageRoot);
	} catch (error) {
		throw commandError("anchor", error);
	}
	if (!anchor) {
		throw commandError("anchor", "MESSAGE_ROOT_NOT_FOUND");
	}

	const fingerprint = JSON.stringify([
		anchor.url,
		anchor.messageLocator,
		anchor.startOffset,
		anchor.endOffset,
		anchor.exactText,
	]);
	if (fingerprint === lastSaveFingerprint && Date.now() - lastSaveTime < 1500) {
		return {
			highlightId: lastSavedHighlightId,
			status: "already-saved",
		};
	}

	let highlights;
	try {
		const stored = await chrome.storage.local.get(STORAGE_KEY);
		highlights = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
		highlights.push(anchor);
		await chrome.storage.local.set({ [STORAGE_KEY]: highlights });
	} catch (error) {
		throw commandError("storage", error);
	}
	allHighlights = highlights;
	activeHighlights = allHighlights.filter(belongsToCurrentPage);
	try {
		resolvedRanges.set(anchor.id, range.cloneRange());
	} catch (error) {
		throw commandError("live-range", error);
	}
	const rendered = renderHighlights();
	if (!rendered) {
		const apiAvailable = typeof CSS !== "undefined" && CSS.highlights && typeof Highlight !== "undefined";
		throw commandError("render", apiAvailable ? "CSS_HIGHLIGHT_RENDER_FAILED" : "CUSTOM_HIGHLIGHT_API_UNAVAILABLE");
	}
	lastSaveFingerprint = fingerprint;
	lastSaveTime = Date.now();
	lastSavedHighlightId = anchor.id;
	clearPendingSelection(pending);
	showActionToast("✓ Highlighted", "Undo", anchor.id, () => removeHighlight(anchor.id));
	return {
		highlightId: anchor.id,
		status: "saved-and-rendered",
	};
}

function queueSaveSelection() {
	if (
		!pendingSelection?.range ||
		!pendingSelection.selectedText?.trim() ||
		pendingSelection.range.toString() !== pendingSelection.selectedText
	) {
		return Promise.reject(commandError("pending-selection", "NO_PENDING_SELECTION"));
	}
	const pending = pendingSelection;
	const command = saveQueue
		.then(() => initializationPromise)
		.then(() => saveSelection(pending));
	saveQueue = command.catch(() => {});
	return command;
}

async function initialize() {
	startRestoreObserver();
	const stored = await chrome.storage.local.get(STORAGE_KEY);
	allHighlights = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
	restoreHighlights();
}

document.addEventListener("selectionchange", capturePendingSelection);
document.addEventListener("mousedown", capturePendingSelection, true);
document.addEventListener("mouseup", capturePendingSelection, true);
document.addEventListener("contextmenu", capturePendingSelection, true);
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (message?.type !== "HIGHLIGHT_SELECTION" && message?.type !== "REMOVE_HIGHLIGHT") return;

	const command = message.type === "HIGHLIGHT_SELECTION"
		? queueSaveSelection()
		: Promise.resolve().then(async () => {
			const selected = pendingSelection;
			const mode = selected
				? { mode: selected.mode, highlightId: selected.highlightId }
				: { mode: "highlight" };
			if (mode.mode !== "remove" || mode.highlightId !== message.highlightId) {
				throw new Error("HIGHLIGHT_SELECTION_NOT_REMOVABLE");
			}
			const removed = await removeHighlight(message.highlightId);
			if (!removed) throw new Error("HIGHLIGHT_NOT_FOUND");
			clearPendingSelection(selected);
			return { highlightId: message.highlightId, status: "removed" };
		});
	command
		.then(result => sendResponse({ ok: true, ...result }))
		.catch(error => {
			console.error("[Highlight] command failed", error);
			sendResponse({
				ok: false,
				stage: error.stage || "command",
				error: error.message || "HIGHLIGHT_COMMAND_FAILED",
			});
		});
	return true;
});

initializationPromise = initialize().catch(error => {
	console.error("[Highlight] initialization failed", error);
});
