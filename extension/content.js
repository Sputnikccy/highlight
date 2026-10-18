const STORAGE_KEY = "highlights";
const HIGHLIGHT_NAME = "highlight-extension-selection";
const CONTEXT_LENGTH = 32;
const CONTEXT_SCHEMA_VERSION = 1;
const MESSAGE_CONTEXT_LENGTH = 700;
const QUESTION_CONTEXT_LENGTH = 500;
const RESTORE_DEBOUNCE_MS = 120;
const TITLE_SYNC_DEBOUNCE_MS = 500;
const CONTEXT_SYNC_DEBOUNCE_MS = 600;
const NAVIGATION_SEARCH_INTERVAL_MS = 450;
const NAVIGATION_STAGES = [
	{ timeoutMs: 20000, maxAttempts: 36 },
	{ timeoutMs: 25000, maxAttempts: 48 },
	{ timeoutMs: 30000, maxAttempts: 60 },
	{ timeoutMs: 15000, maxAttempts: 30 },
];

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
let pendingScrollHighlightId = null;
let scrollAttemptCount = 0;
let scrollRetryTimer = null;
let navigationTimeoutTimer = null;
let navigationSearchTimer = null;
let navigationSearchAttempt = 0;
let navigationStage = 0;
let titleSyncTimer = null;
let contextSyncTimer = null;

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

function normalizeContextText(value) {
	return String(value || "").replace(/\s+/g, " ").trim();
}

function truncateContextText(value, maxLength) {
	const text = normalizeContextText(value);
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function getMessageRole(root) {
	const roleElement = root.matches?.("[data-message-author-role]")
		? root
		: root.closest?.("[data-message-author-role]") || root.querySelector?.("[data-message-author-role]");
	const role = roleElement?.getAttribute("data-message-author-role")?.toLowerCase();
	return role === "user" || role === "assistant" ? role : null;
}

function getPreviousUserMessage(root) {
	const main = root.closest?.("main, [role='main']") || document.querySelector("main, [role='main']");
	if (!main) return null;
	let previous = null;
	for (const candidate of main.querySelectorAll('[data-message-author-role="user"]')) {
		if (candidate === root || candidate.contains(root)) continue;
		if (candidate.compareDocumentPosition(root) & Node.DOCUMENT_POSITION_FOLLOWING) {
			previous = candidate;
		}
	}
	return previous;
}

function createMessageContext(messageText, startOffset, endOffset) {
	const selectionLength = Math.max(0, endOffset - startOffset);
	const surroundingBudget = Math.max(0, MESSAGE_CONTEXT_LENGTH - Math.min(selectionLength, MESSAGE_CONTEXT_LENGTH));
	const beforeBudget = Math.floor(surroundingBudget / 2);
	const afterBudget = surroundingBudget - beforeBudget;
	const excerptStart = Math.max(0, startOffset - beforeBudget);
	const excerptEnd = Math.min(
		messageText.length,
		selectionLength >= MESSAGE_CONTEXT_LENGTH
			? startOffset + MESSAGE_CONTEXT_LENGTH
			: endOffset + afterBudget,
	);
	const excerpt = truncateContextText(
		messageText.slice(excerptStart, excerptEnd),
		MESSAGE_CONTEXT_LENGTH,
	);
	return `${excerptStart > 0 ? "…" : ""}${excerpt}${excerptEnd < messageText.length ? "…" : ""}`;
}

function buildHighlightContext(range, messageRoot) {
	const messageText = messageRoot.textContent || "";
	const startOffset = getTextOffset(messageRoot, range.startContainer, range.startOffset);
	const endOffset = getTextOffset(messageRoot, range.endContainer, range.endOffset);
	if (startOffset < 0 || endOffset < startOffset) return null;

	const messageRole = getMessageRole(messageRoot);
	const previousUserMessage = messageRole === "assistant" ? getPreviousUserMessage(messageRoot) : null;
	return {
		contextVersion: CONTEXT_SCHEMA_VERSION,
		messageRole,
		messageContext: createMessageContext(messageText, startOffset, endOffset),
		questionContext: previousUserMessage
			? truncateContextText(previousUserMessage.textContent, QUESTION_CONTEXT_LENGTH)
			: null,
	};
}

function getConversationId(url) {
	const match = new URL(url).pathname.match(/(?:^|\/)c\/([^/]+)/);
	return match ? match[1] : null;
}

function normalizeConversationTitle(value) {
	const title = String(value || "")
		.replace(/\s+/g, " ")
		.replace(/^\(\d+\)\s*/, "")
		.replace(/^ChatGPT\s*[-–—|]\s*/i, "")
		.replace(/\s*[-–—|]\s*ChatGPT\s*$/i, "")
		.trim();
	if (!title || /^(chatgpt|new chat)$/i.test(title)) return null;
	return title.slice(0, 200);
}

function getConversationTitle() {
	const pageTitle = normalizeConversationTitle(document.title);
	if (pageTitle) return pageTitle;

	const conversationId = getConversationId(window.location.href);
	if (!conversationId) return null;
	for (const link of document.querySelectorAll('a[href*="/c/"]')) {
		try {
			if (getConversationId(new URL(link.href, window.location.href).href) !== conversationId) continue;
			const title = normalizeConversationTitle(link.getAttribute("aria-label") || link.textContent);
			if (title) return title;
		} catch {
			// Ignore malformed navigation links and continue looking for a title.
		}
	}
	return null;
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
	const highlightContext = buildHighlightContext(range, messageRoot);

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
		conversationTitle: getConversationTitle(),
		messageLocator: getMessageLocator(messageRoot),
		...(highlightContext || {
			contextVersion: 0,
			messageRole: null,
			messageContext: null,
			questionContext: null,
		}),
		tags: [],
		note: "",
		starred: false,
		createdAt: new Date().toISOString(),
	};
}

async function syncConversationTitle() {
	const conversationId = getConversationId(window.location.href);
	const conversationTitle = getConversationTitle();
	if (!conversationId || !conversationTitle) return false;

	const stored = await chrome.storage.local.get(STORAGE_KEY);
	const storedHighlights = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
	let changed = false;
	const nextHighlights = storedHighlights.map(highlight => {
		if (highlight.conversationId !== conversationId || highlight.conversationTitle === conversationTitle) {
			return highlight;
		}
		changed = true;
		return { ...highlight, conversationTitle };
	});
	if (changed) await chrome.storage.local.set({ [STORAGE_KEY]: nextHighlights });
	return changed;
}

function scheduleConversationTitleSync() {
	clearTimeout(titleSyncTimer);
	titleSyncTimer = setTimeout(() => {
		syncConversationTitle().catch(error => {
			console.warn("[Highlight] conversation title sync failed", error);
		});
	}, TITLE_SYNC_DEBOUNCE_MS);
}

async function syncResolvedHighlightContext() {
	const contextUpdates = new Map();
	for (const highlight of activeHighlights) {
		if (highlight.contextVersion === CONTEXT_SCHEMA_VERSION) continue;
		const range = resolvedRanges.get(highlight.id);
		if (!range?.startContainer.isConnected || !range.endContainer.isConnected) continue;
		const messageRoot = findMessageRoot(range);
		if (!messageRoot) continue;
		const context = buildHighlightContext(range, messageRoot);
		if (context) contextUpdates.set(highlight.id, context);
	}
	if (contextUpdates.size === 0) return false;

	const stored = await chrome.storage.local.get(STORAGE_KEY);
	const storedHighlights = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
	let changed = false;
	const nextHighlights = storedHighlights.map(highlight => {
		const context = contextUpdates.get(highlight.id);
		if (!context || highlight.contextVersion === CONTEXT_SCHEMA_VERSION) return highlight;
		changed = true;
		return { ...highlight, ...context };
	});
	if (changed) await chrome.storage.local.set({ [STORAGE_KEY]: nextHighlights });
	return changed;
}

function scheduleHighlightContextSync() {
	clearTimeout(contextSyncTimer);
	contextSyncTimer = setTimeout(() => {
		syncResolvedHighlightContext().catch(error => {
			console.warn("[Highlight] context sync failed", error);
		});
	}, CONTEXT_SYNC_DEBOUNCE_MS);
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
	const prefix = anchor.prefix || "";
	const suffix = anchor.suffix || "";
	const before = text.slice(Math.max(0, index - prefix.length), index);
	const after = text.slice(index + anchor.exactText.length, index + anchor.exactText.length + suffix.length);
	return matchingSuffixLength(prefix, before) + matchingPrefixLength(suffix, after);
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

function normalizeComparableText(value) {
	return String(value || "").replace(/\s+/g, " ").trim();
}

function rangeMatchesAnchor(range, anchor) {
	return range?.toString() === anchor.exactText ||
		normalizeComparableText(range?.toString()) === normalizeComparableText(anchor.exactText);
}

function escapeRegularExpression(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getDocumentTextMatches(text, anchor, allowWhitespaceChanges) {
	const matches = [];
	if (!allowWhitespaceChanges) {
		let index = text.indexOf(anchor.exactText);
		while (index !== -1) {
			matches.push({ index, length: anchor.exactText.length });
			index = text.indexOf(anchor.exactText, index + 1);
		}
		return matches;
	}

	const tokens = anchor.exactText.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return matches;
	const expression = new RegExp(tokens.map(escapeRegularExpression).join("\\s+"), "gu");
	let match;
	while ((match = expression.exec(text))) {
		matches.push({ index: match.index, length: match[0].length });
		if (match[0].length === 0) expression.lastIndex += 1;
	}
	return matches;
}

function resolveAnchorInDocument(anchor, allowWhitespaceChanges = false) {
	if (!anchor?.exactText) return null;
	const root = document.querySelector("main, [role='main']");
	if (!root) return null;
	const text = root.textContent || "";
	const prefix = anchor.prefix || "";
	const suffix = anchor.suffix || "";
	const matches = getDocumentTextMatches(text, anchor, allowWhitespaceChanges)
		.map(match => {
			const before = text.slice(Math.max(0, match.index - prefix.length), match.index);
			const after = text.slice(match.index + match.length, match.index + match.length + suffix.length);
			return {
				...match,
				contextScore: matchingSuffixLength(prefix, before) + matchingPrefixLength(suffix, after),
			};
		})
		.sort((left, right) => right.contextScore - left.contextScore);

	if (
		matches.length > 1 &&
		matches[0].contextScore === 0 &&
		matches[0].contextScore === matches[1].contextScore
	) {
		return null;
	}

	for (const match of matches) {
		const range = rangeFromOffsets(root, match.index, match.index + match.length);
		if (rangeMatchesAnchor(range, anchor)) return range;
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

function showActionToast(message, actionLabel, highlightId, action, options = {}) {
	dismissToast();
	if (!document.body) return;
	const timeoutMs = options.timeoutMs === undefined ? 5000 : options.timeoutMs;

	const toast = document.createElement("div");
	toast.className = "highlight-extension-toast";
	toast.setAttribute("role", "status");
	toast.setAttribute("aria-live", "polite");
	const label = document.createElement("span");
	label.textContent = message;
	const actions = document.createElement("span");
	actions.className = "highlight-extension-toast-actions";
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = actionLabel;
	button.addEventListener("click", async event => {
		event.stopPropagation();
		try {
			if (await action()) dismissToast();
		} catch (error) {
			console.error("[Highlight] toast action failed", error);
		}
	});
	actions.append(button);
	if (options.dismissible) {
		const dismissButton = document.createElement("button");
		dismissButton.type = "button";
		dismissButton.className = "highlight-extension-toast-dismiss";
		dismissButton.textContent = "×";
		dismissButton.setAttribute("aria-label", "Dismiss");
		dismissButton.addEventListener("click", event => {
			event.stopPropagation();
			dismissToast();
		});
		actions.append(dismissButton);
	}
	toast.append(label, actions);
	document.body.append(toast);
	toastElement = toast;
	toastHighlightId = highlightId;
	if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
		toastTimer = setTimeout(dismissToast, timeoutMs);
	}
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
	removeDisconnectedRanges();
	refreshActiveHighlights();
	const unresolved = activeHighlights.filter(anchor => !resolvedRanges.has(anchor.id));
	if (unresolved.length === 0) {
		scheduleHighlightContextSync();
		tryScrollToPendingHighlight();
		return;
	}

	const messageRoots = getMessageRoots();
	let changed = false;

	for (const anchor of unresolved) {
		const range = resolveAnchor(anchor, messageRoots);
		if (range) {
			resolvedRanges.set(anchor.id, range);
			changed = true;
		}
	}

	if (
		pendingScrollHighlightId &&
		navigationStage >= 2 &&
		!hasConnectedResolvedRange(pendingScrollHighlightId)
	) {
		const pendingAnchor = activeHighlights.find(anchor => anchor.id === pendingScrollHighlightId);
		const fallbackRange = resolveAnchorInDocument(pendingAnchor, navigationStage >= 3);
		if (fallbackRange) {
			resolvedRanges.set(pendingScrollHighlightId, fallbackRange);
			changed = true;
		}
	}

	if (changed) renderHighlights();
	scheduleHighlightContextSync();
	tryScrollToPendingHighlight();
}

function getScrollableAncestor(element) {
	let current = element;
	while (current && current !== document.body) {
		const style = window.getComputedStyle(current);
		if (
			/(auto|scroll|overlay)/.test(style.overflowY) &&
			current.scrollHeight > current.clientHeight + 1
		) {
			return current;
		}
		current = current.parentElement;
	}

	const scrollingElement = document.scrollingElement || document.documentElement;
	return scrollingElement.scrollHeight > scrollingElement.clientHeight + 1
		? scrollingElement
		: null;
}

function getConversationScrollContainer() {
	const messageRoots = getMessageRoots();
	const reference = messageRoots[messageRoots.length - 1] || document.querySelector("main, [role='main']");
	return reference ? getScrollableAncestor(reference) : null;
}

function scrollRangeToCenter(range, behavior) {
	const target = elementFor(range.startContainer);
	if (!target) return false;

	const scroller = getScrollableAncestor(target);
	const rect = range.getBoundingClientRect();
	if (!scroller || (!rect.width && !rect.height)) {
		target.scrollIntoView({ behavior, block: "center", inline: "nearest" });
		return true;
	}

	const scrollingElement = document.scrollingElement || document.documentElement;
	if (scroller === scrollingElement) {
		window.scrollBy({
			top: rect.top + (rect.height / 2) - (window.innerHeight / 2),
			behavior,
		});
		return true;
	}

	const scrollerRect = scroller.getBoundingClientRect();
	scroller.scrollBy({
		top: rect.top + (rect.height / 2) - scrollerRect.top - (scroller.clientHeight / 2),
		behavior,
	});
	return true;
}

function hasConnectedResolvedRange(highlightId) {
	const range = resolvedRanges.get(highlightId);
	return Boolean(range?.startContainer.isConnected && range.endContainer.isConnected);
}

function loadEarlierConversationContent() {
	if (!pendingScrollHighlightId || hasConnectedResolvedRange(pendingScrollHighlightId)) return;
	const stageConfig = NAVIGATION_STAGES[navigationStage] || NAVIGATION_STAGES[0];
	if (navigationSearchAttempt >= stageConfig.maxAttempts) return;

	navigationSearchAttempt += 1;
	const scroller = getConversationScrollContainer();
	if (scroller) {
		if (navigationStage < 2) {
			const distance = Math.max(scroller.clientHeight * 0.9, 700);
			scroller.scrollTop = Math.max(0, scroller.scrollTop - distance);
		} else {
			scroller.scrollTop = 0;
		}
		scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
	}

	clearTimeout(navigationSearchTimer);
	navigationSearchTimer = setTimeout(() => {
		removeDisconnectedRanges();
		restoreHighlights();
		if (pendingScrollHighlightId && !hasConnectedResolvedRange(pendingScrollHighlightId)) {
			loadEarlierConversationContent();
		}
	}, NAVIGATION_SEARCH_INTERVAL_MS);
}

function tryScrollToPendingHighlight() {
	if (!pendingScrollHighlightId) return false;
	const range = resolvedRanges.get(pendingScrollHighlightId);
	if (!range?.startContainer.isConnected) return false;

	if (!scrollRangeToCenter(range, scrollAttemptCount === 0 ? "smooth" : "auto")) return false;
	scrollAttemptCount += 1;
	clearTimeout(scrollRetryTimer);
	if (scrollAttemptCount < 8) {
		scrollRetryTimer = setTimeout(() => {
			removeDisconnectedRanges();
			restoreHighlights();
		}, 400);
	} else {
		clearTimeout(navigationTimeoutTimer);
		clearTimeout(navigationSearchTimer);
		navigationTimeoutTimer = null;
		navigationSearchTimer = null;
		pendingScrollHighlightId = null;
		scrollAttemptCount = 0;
		navigationSearchAttempt = 0;
		navigationStage = 0;
		const url = new URL(window.location.href);
		if (url.hash.startsWith("#highlight=")) {
			url.hash = "";
			history.replaceState(history.state, "", url.href);
		}
	}
	return true;
}

function setPendingScrollHighlight(highlightId, stage = 0) {
	clearTimeout(scrollRetryTimer);
	clearTimeout(navigationTimeoutTimer);
	clearTimeout(navigationSearchTimer);
	pendingScrollHighlightId = highlightId;
	scrollAttemptCount = 0;
	navigationSearchAttempt = 0;
	navigationStage = Math.min(Math.max(stage, 0), NAVIGATION_STAGES.length - 1);
	navigationSearchTimer = setTimeout(loadEarlierConversationContent, NAVIGATION_SEARCH_INTERVAL_MS);
	const stageConfig = NAVIGATION_STAGES[navigationStage];
	navigationTimeoutTimer = setTimeout(() => {
		if (pendingScrollHighlightId !== highlightId || hasConnectedResolvedRange(highlightId)) return;
		clearTimeout(navigationSearchTimer);
		navigationSearchTimer = null;
		navigationTimeoutTimer = null;
		pendingScrollHighlightId = null;
		scrollAttemptCount = 0;
		navigationSearchAttempt = 0;

		if (navigationStage === 0) {
			showActionToast(
				"Step 1 complete · target not in loaded messages",
				"Search earlier",
				highlightId,
				async () => {
					setPendingScrollHighlight(highlightId, 1);
					scheduleRestore();
					return true;
				},
				{ timeoutMs: null, dismissible: true },
			);
		} else if (navigationStage === 1) {
			showActionToast(
				"Step 2 complete · more history searched",
				"Continue to oldest",
				highlightId,
				async () => {
					setPendingScrollHighlight(highlightId, 2);
					scheduleRestore();
					return true;
				},
				{ timeoutMs: null, dismissible: true },
			);
		} else if (navigationStage === 2) {
			showActionToast(
				"Step 3 complete · exact anchor still missing",
				"Match by text",
				highlightId,
				async () => {
					setPendingScrollHighlight(highlightId, 3);
					scheduleRestore();
					return true;
				},
				{ timeoutMs: null, dismissible: true },
			);
		} else {
			navigationStage = 0;
			showActionToast(
				"Source text may have changed",
				"Dismiss",
				highlightId,
				async () => true,
				{ timeoutMs: null },
			);
		}
	}, stageConfig.timeoutMs);
}

function getHighlightIdFromUrl() {
	const hash = window.location.hash.slice(1);
	if (!hash.startsWith("highlight=")) return null;
	const highlightId = decodeURIComponent(hash.slice("highlight=".length));
	return highlightId || null;
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
			!rangeMatchesAnchor(range, anchor)
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

		if (pageChanged) scheduleConversationTitleSync();
		if (pageChanged || disconnected || (relevantMutation && hasUnresolved)) scheduleRestore();
	});
	observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
	window.addEventListener("popstate", () => {
		scheduleRestore();
		scheduleConversationTitleSync();
	});
	window.addEventListener("hashchange", () => {
		scheduleRestore();
		scheduleConversationTitleSync();
	});

	const titleElement = document.querySelector("title");
	if (titleElement) {
		new MutationObserver(scheduleConversationTitleSync).observe(titleElement, {
			childList: true,
			characterData: true,
			subtree: true,
		});
	}
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
	const navigationHighlightId = getHighlightIdFromUrl();
	if (navigationHighlightId) setPendingScrollHighlight(navigationHighlightId);
	restoreHighlights();
	scheduleConversationTitleSync();
}

function handleStorageChanged(changes, areaName) {
	if (areaName !== "local" || !changes[STORAGE_KEY]) return;

	const nextHighlights = changes[STORAGE_KEY].newValue;
	allHighlights = Array.isArray(nextHighlights) ? nextHighlights : [];
	activeHighlights = allHighlights.filter(belongsToCurrentPage);
	const activeIds = new Set(activeHighlights.map(highlight => highlight.id));
	for (const highlightId of resolvedRanges.keys()) {
		if (!activeIds.has(highlightId)) resolvedRanges.delete(highlightId);
	}
	renderHighlights();
	restoreHighlights();
}

document.addEventListener("selectionchange", capturePendingSelection);
document.addEventListener("mousedown", capturePendingSelection, true);
document.addEventListener("mouseup", capturePendingSelection, true);
document.addEventListener("contextmenu", capturePendingSelection, true);
chrome.storage.onChanged.addListener(handleStorageChanged);
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (message?.type === "SCROLL_TO_HIGHLIGHT" && typeof message.highlightId === "string") {
		setPendingScrollHighlight(message.highlightId);
		Promise.resolve(initializationPromise)
			.then(() => {
				restoreHighlights();
				sendResponse({
					ok: true,
					status: pendingScrollHighlightId ? "pending" : "located",
				});
			})
			.catch(error => {
				console.error("[Highlight] navigation failed", error);
				sendResponse({ ok: false, error: error.message || "HIGHLIGHT_NAVIGATION_FAILED" });
			});
		return true;
	}

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
