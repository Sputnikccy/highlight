const STORAGE_KEY = "highlights";
const NOTE_MAX_LENGTH = 500;
const TAG_MAX_COUNT = 8;
const TAG_MAX_LENGTH = 24;
const EXPORT_SCHEMA_VERSION = 1;
const CONTEXT_SCHEMA_VERSION = 1;
const MESSAGE_CONTEXT_MAX_LENGTH = 704;
const QUESTION_CONTEXT_MAX_LENGTH = 500;
const CONTEXT_PREVIEW_LENGTH = 360;
const IMPORT_MAX_FILE_SIZE = 5 * 1024 * 1024;
const IMPORT_MAX_HIGHLIGHTS = 10000;
const SUPPORTED_HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);

const countElement = document.querySelector("#highlight-count");
const emptyStateElement = document.querySelector("#empty-state");
const emptyTitleElement = document.querySelector("#empty-title");
const emptyDescriptionElement = document.querySelector("#empty-description");
const listElement = document.querySelector("#highlight-list");
const searchInputElement = document.querySelector("#search-input");
const starredFilterElement = document.querySelector("#starred-filter");
const dataMenuElement = document.querySelector("#data-menu");
const importButtonElement = document.querySelector("#import-json");
const importFileElement = document.querySelector("#import-file");
const tagFiltersElement = document.querySelector("#tag-filters");
const tagFilterOptionsElement = document.querySelector("#tag-filter-options");
const dataNoticeElement = document.querySelector("#data-notice");
const dataNoticeMessageElement = document.querySelector("#data-notice-message");
const dataNoticeDismissElement = document.querySelector("#data-notice-dismiss");
const statusElement = document.querySelector("#status");

let highlights = [];
let searchQuery = "";
let starredOnly = false;
let selectedTag = "";
const collapsedGroups = new Set();

function normalizeTag(value) {
	return String(value || "").replace(/\s+/g, " ").trim().replace(/^#+/, "").trim();
}

function getTagKey(value) {
	return normalizeTag(value).toLocaleLowerCase();
}

function getHighlightTags(highlight) {
	if (!Array.isArray(highlight.tags)) return [];
	const tags = [];
	const seen = new Set();
	for (const value of highlight.tags) {
		const tag = normalizeTag(value);
		const key = getTagKey(tag);
		if (!tag || seen.has(key)) continue;
		seen.add(key);
		tags.push(tag);
	}
	return tags;
}

function parseTags(value) {
	const tags = [];
	const seen = new Set();
	for (const entry of String(value || "").split(/[,，\n]+/)) {
		const tag = normalizeTag(entry);
		if (!tag) continue;
		if (tag.length > TAG_MAX_LENGTH) {
			throw new Error(`Keep each tag under ${TAG_MAX_LENGTH} characters`);
		}
		const key = getTagKey(tag);
		if (seen.has(key)) continue;
		if (tags.length >= TAG_MAX_COUNT) {
			throw new Error(`Use up to ${TAG_MAX_COUNT} tags per highlight`);
		}
		seen.add(key);
		tags.push(tag);
	}
	return tags;
}

function getAllTags() {
	const tagsByKey = new Map();
	for (const highlight of highlights) {
		for (const tag of getHighlightTags(highlight)) {
			const key = getTagKey(tag);
			if (!tagsByKey.has(key)) tagsByKey.set(key, tag);
		}
	}
	return Array.from(tagsByKey, ([key, label]) => ({ key, label }))
		.sort((left, right) => left.label.localeCompare(right.label));
}

function importedHighlightError(index, message) {
	return new Error(`Highlight ${index + 1}: ${message}`);
}

function normalizeImportedHighlight(value, index) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw importedHighlightError(index, "invalid record");
	}
	if (typeof value.id !== "string" || !value.id.trim() || value.id.length > 200) {
		throw importedHighlightError(index, "missing a valid ID");
	}
	if (typeof value.exactText !== "string" || !value.exactText.trim()) {
		throw importedHighlightError(index, "missing highlighted text");
	}

	let sourceUrl;
	try {
		sourceUrl = new URL(value.url);
	} catch {
		throw importedHighlightError(index, "has an invalid source URL");
	}
	if (sourceUrl.protocol !== "https:" || !SUPPORTED_HOSTS.has(sourceUrl.hostname)) {
		throw importedHighlightError(index, "source must be a supported ChatGPT URL");
	}

	if (!Number.isInteger(value.startOffset) || value.startOffset < 0) {
		throw importedHighlightError(index, "has an invalid start offset");
	}
	if (!Number.isInteger(value.endOffset) || value.endOffset < value.startOffset) {
		throw importedHighlightError(index, "has an invalid end offset");
	}

	const createdAt = new Date(value.createdAt);
	if (Number.isNaN(createdAt.getTime())) {
		throw importedHighlightError(index, "has an invalid saved date");
	}

	if (
		value.tags !== undefined &&
		(!Array.isArray(value.tags) || value.tags.some(tag => typeof tag !== "string"))
	) {
		throw importedHighlightError(index, "has invalid tags");
	}
	const tags = getHighlightTags({ tags: value.tags });
	if (tags.length > TAG_MAX_COUNT || tags.some(tag => tag.length > TAG_MAX_LENGTH)) {
		throw importedHighlightError(index, "contains unsupported tags");
	}
	if (value.note !== undefined && typeof value.note !== "string") {
		throw importedHighlightError(index, "has an invalid note");
	}
	if ((value.note || "").length > NOTE_MAX_LENGTH) {
		throw importedHighlightError(index, `note exceeds ${NOTE_MAX_LENGTH} characters`);
	}
	if (
		value.messageRole !== undefined &&
		value.messageRole !== null &&
		value.messageRole !== "user" &&
		value.messageRole !== "assistant"
	) {
		throw importedHighlightError(index, "has an invalid message role");
	}
	for (const [field, maxLength] of [
		["messageContext", MESSAGE_CONTEXT_MAX_LENGTH],
		["questionContext", QUESTION_CONTEXT_MAX_LENGTH],
	]) {
		if (value[field] !== undefined && value[field] !== null && typeof value[field] !== "string") {
			throw importedHighlightError(index, `has invalid ${field}`);
		}
		if ((value[field] || "").length > maxLength) {
			throw importedHighlightError(index, `${field} is too long`);
		}
	}

	const locator = value.messageLocator && typeof value.messageLocator === "object"
		? value.messageLocator
		: {};
	const optionalString = input => typeof input === "string" && input ? input : null;

	return {
		id: value.id.trim(),
		exactText: value.exactText,
		prefix: typeof value.prefix === "string" ? value.prefix : "",
		suffix: typeof value.suffix === "string" ? value.suffix : "",
		startOffset: value.startOffset,
		endOffset: value.endOffset,
		url: sourceUrl.href,
		conversationId: optionalString(value.conversationId),
		conversationTitle: optionalString(value.conversationTitle)?.slice(0, 200) || null,
		messageLocator: {
			tagName: optionalString(locator.tagName),
			messageId: optionalString(locator.messageId),
			testId: optionalString(locator.testId),
			authorRole: optionalString(locator.authorRole),
			id: optionalString(locator.id),
		},
		contextVersion: value.contextVersion === CONTEXT_SCHEMA_VERSION ? CONTEXT_SCHEMA_VERSION : 0,
		messageRole: value.messageRole === "user" || value.messageRole === "assistant" ? value.messageRole : null,
		messageContext: optionalString(value.messageContext),
		questionContext: optionalString(value.questionContext),
		tags,
		note: value.note || "",
		starred: value.starred === true,
		createdAt: createdAt.toISOString(),
	};
}

function parseImportPayload(text) {
	let payload;
	try {
		payload = JSON.parse(text);
	} catch {
		throw new Error("This file is not valid JSON");
	}
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error("Choose a Highlight JSON export");
	}
	if (payload.schemaVersion !== EXPORT_SCHEMA_VERSION) {
		throw new Error("This backup version is not supported");
	}
	if (!Array.isArray(payload.highlights)) {
		throw new Error("This backup does not contain a highlight library");
	}
	if (payload.highlights.length > IMPORT_MAX_HIGHLIGHTS) {
		throw new Error(`A backup can contain up to ${IMPORT_MAX_HIGHLIGHTS} highlights`);
	}
	return payload.highlights.map(normalizeImportedHighlight);
}

function createImportPlan(importedHighlights, existingHighlights) {
	const knownIds = new Set(
		existingHighlights
			.map(highlight => highlight?.id)
			.filter(id => typeof id === "string" && id),
	);
	const additions = [];
	let duplicates = 0;
	for (const highlight of importedHighlights) {
		if (knownIds.has(highlight.id)) {
			duplicates += 1;
			continue;
		}
		knownIds.add(highlight.id);
		additions.push(highlight);
	}
	return { additions, duplicates };
}

function showDataNotice(message, tone = "success") {
	dataNoticeMessageElement.textContent = message;
	dataNoticeElement.dataset.tone = tone;
	dataNoticeElement.hidden = false;
	statusElement.textContent = message;
}

async function importJsonFile(file) {
	if (!file) return;
	if (file.size > IMPORT_MAX_FILE_SIZE) {
		throw new Error("Choose a JSON backup smaller than 5 MB");
	}

	const importedHighlights = parseImportPayload(await file.text());
	const stored = await chrome.storage.local.get(STORAGE_KEY);
	const storedHighlights = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
	const { additions, duplicates } = createImportPlan(importedHighlights, storedHighlights);

	if (additions.length === 0) {
		if (duplicates) {
			showDataNotice(
				`Import complete · No new highlights · ${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped`,
			);
		} else {
			showDataNotice("This backup is empty", "neutral");
		}
		return;
	}

	const confirmed = window.confirm(
		`Import ${additions.length} highlight${additions.length === 1 ? "" : "s"}? ` +
		"Your current library will be kept and duplicates will be skipped.",
	);
	if (!confirmed) return;

	await chrome.storage.local.set({ [STORAGE_KEY]: [...storedHighlights, ...additions] });
	const duplicateMessage = duplicates
		? ` · ${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped`
		: "";
	showDataNotice(
		`${additions.length} highlight${additions.length === 1 ? "" : "s"} imported${duplicateMessage}`,
	);
}

function formatDate(value) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "Saved highlight";
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(date);
}

function getConversationKey(highlight) {
	if (highlight.conversationId) return `conversation:${highlight.conversationId}`;
	try {
		const url = new URL(highlight.url);
		return `page:${url.origin}${url.pathname}`;
	} catch {
		return "page:unknown";
	}
}

function getConversationTitle(group, index) {
	const storedTitle = group.highlights.find(highlight => highlight.conversationTitle?.trim())
		?.conversationTitle.trim();
	return storedTitle || `Conversation ${index + 1}`;
}

function matchesSearch(highlight) {
	if (!searchQuery) return true;
	const searchableText = [
		highlight.exactText,
		highlight.note,
		highlight.conversationTitle,
		highlight.messageContext,
		highlight.questionContext,
		...(Array.isArray(highlight.tags) ? highlight.tags : []),
	]
		.filter(Boolean)
		.join(" ")
		.toLocaleLowerCase();
	return searchableText.includes(searchQuery);
}

function getVisibleHighlights() {
	return highlights
		.filter(highlight => {
			const matchesTag = !selectedTag || getHighlightTags(highlight).some(tag => getTagKey(tag) === selectedTag);
			return (!starredOnly || highlight.starred === true) && matchesTag && matchesSearch(highlight);
		})
		.sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
}

function renderTagFilters(allTags) {
	tagFiltersElement.hidden = allTags.length === 0;
	if (allTags.length === 0) {
		tagFilterOptionsElement.replaceChildren();
		return;
	}

	const createFilterButton = (label, key) => {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "tag-filter";
		button.textContent = label;
		button.setAttribute("aria-pressed", String(selectedTag === key));
		button.addEventListener("click", () => {
			selectedTag = key;
			render();
		});
		return button;
	};

	tagFilterOptionsElement.replaceChildren(
		createFilterButton("All", ""),
		...allTags.map(tag => createFilterButton(`#${tag.label}`, tag.key)),
	);
}

function groupHighlights(visibleHighlights) {
	const groups = new Map();
	for (const highlight of visibleHighlights) {
		const key = getConversationKey(highlight);
		if (!groups.has(key)) groups.set(key, { key, highlights: [] });
		groups.get(key).highlights.push(highlight);
	}
	return Array.from(groups.values());
}

async function openHighlight(highlight) {
	try {
		const response = await chrome.runtime.sendMessage({
			type: "OPEN_HIGHLIGHT",
			highlightId: highlight.id,
			url: highlight.url,
		});
		if (!response?.ok) throw new Error(response?.error || "HIGHLIGHT_OPEN_FAILED");
		statusElement.textContent = "Opening source highlight";
	} catch (error) {
		console.error("[Highlight] could not open source highlight", error);
		statusElement.textContent = "Could not open source highlight";
	}
}

async function updateHighlight(highlightId, update) {
	const stored = await chrome.storage.local.get(STORAGE_KEY);
	const storedHighlights = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
	let changed = false;
	const nextHighlights = storedHighlights.map(highlight => {
		if (highlight.id !== highlightId) return highlight;
		changed = true;
		return { ...highlight, ...update(highlight) };
	});
	if (changed) await chrome.storage.local.set({ [STORAGE_KEY]: nextHighlights });
	return changed;
}

async function toggleStarred(highlight) {
	try {
		const starred = highlight.starred !== true;
		if (await updateHighlight(highlight.id, () => ({ starred }))) {
			statusElement.textContent = starred ? "Highlight starred" : "Highlight unstarred";
		}
	} catch (error) {
		console.error("[Highlight] could not update starred state", error);
		statusElement.textContent = "Could not update highlight";
	}
}

function openNoteEditor(item, highlight) {
	item.querySelector(".tag-editor")?.remove();
	const existingEditor = item.querySelector(".note-editor");
	if (existingEditor) {
		existingEditor.querySelector("textarea")?.focus();
		return;
	}

	const editor = document.createElement("form");
	editor.className = "note-editor";

	const label = document.createElement("label");
	label.textContent = "Note";
	const textarea = document.createElement("textarea");
	textarea.value = highlight.note || "";
	textarea.maxLength = NOTE_MAX_LENGTH;
	textarea.rows = 3;
	textarea.placeholder = "Why is this highlight important?";
	label.append(textarea);

	const actions = document.createElement("div");
	actions.className = "note-editor-actions";
	const cancelButton = document.createElement("button");
	cancelButton.type = "button";
	cancelButton.textContent = "Cancel";
	cancelButton.addEventListener("click", () => editor.remove());
	const saveButton = document.createElement("button");
	saveButton.type = "submit";
	saveButton.className = "primary-button";
	saveButton.textContent = "Save note";
	actions.append(cancelButton, saveButton);
	editor.append(label, actions);

	editor.addEventListener("submit", async event => {
		event.preventDefault();
		saveButton.disabled = true;
		try {
			const note = textarea.value.trim();
			await updateHighlight(highlight.id, () => ({ note }));
			editor.remove();
			statusElement.textContent = note ? "Note saved" : "Note removed";
		} catch (error) {
			console.error("[Highlight] could not save note", error);
			statusElement.textContent = "Could not save note";
			saveButton.disabled = false;
		}
	});

	item.insertBefore(editor, item.querySelector(".card-footer"));
	textarea.focus();
	textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

function openTagEditor(item, highlight) {
	item.querySelector(".note-editor")?.remove();
	const existingEditor = item.querySelector(".tag-editor");
	if (existingEditor) {
		existingEditor.querySelector("input")?.focus();
		return;
	}

	const editor = document.createElement("form");
	editor.className = "tag-editor";

	const label = document.createElement("label");
	label.textContent = "Tags";
	const input = document.createElement("input");
	input.type = "text";
	input.value = getHighlightTags(highlight).join(", ");
	input.placeholder = "research, idea";
	input.autocomplete = "off";
	input.setAttribute("aria-describedby", `tag-help-${highlight.id}`);
	input.addEventListener("input", () => input.setCustomValidity(""));
	label.append(input);

	const help = document.createElement("span");
	help.id = `tag-help-${highlight.id}`;
	help.className = "editor-help";
	help.textContent = `Separate tags with commas · ${TAG_MAX_COUNT} maximum`;

	const actions = document.createElement("div");
	actions.className = "tag-editor-actions";
	const cancelButton = document.createElement("button");
	cancelButton.type = "button";
	cancelButton.textContent = "Cancel";
	cancelButton.addEventListener("click", () => editor.remove());
	const saveButton = document.createElement("button");
	saveButton.type = "submit";
	saveButton.className = "primary-button";
	saveButton.textContent = "Save tags";
	actions.append(cancelButton, saveButton);
	editor.append(label, help, actions);

	editor.addEventListener("submit", async event => {
		event.preventDefault();
		let tags;
		try {
			tags = parseTags(input.value);
			input.setCustomValidity("");
		} catch (error) {
			input.setCustomValidity(error.message);
			input.reportValidity();
			return;
		}

		saveButton.disabled = true;
		try {
			await updateHighlight(highlight.id, () => ({ tags }));
			editor.remove();
			statusElement.textContent = tags.length ? "Tags saved" : "Tags removed";
		} catch (error) {
			console.error("[Highlight] could not save tags", error);
			statusElement.textContent = "Could not save tags";
			saveButton.disabled = false;
		}
	});

	item.insertBefore(editor, item.querySelector(".card-footer"));
	input.focus();
	input.setSelectionRange(input.value.length, input.value.length);
}

function findContextHighlight(text, exactText) {
	const selectedText = String(exactText || "").replace(/\s+/g, " ").trim();
	if (!selectedText) return null;

	const matches = [];
	let index = text.indexOf(selectedText);
	while (index !== -1) {
		matches.push({ start: index, end: index + selectedText.length });
		index = text.indexOf(selectedText, index + 1);
	}
	if (matches.length) {
		const center = text.length / 2;
		return matches.reduce((best, match) =>
			Math.abs((match.start + match.end) / 2 - center) < Math.abs((best.start + best.end) / 2 - center)
				? match
				: best,
		);
	}

	const visibleStart = text.startsWith("…") ? 1 : 0;
	const visibleEnd = text.endsWith("…") ? text.length - 1 : text.length;
	const visibleText = text.slice(visibleStart, visibleEnd).trim();
	if (visibleText.length >= 20 && selectedText.includes(visibleText)) {
		const start = text.indexOf(visibleText, visibleStart);
		return { start, end: start + visibleText.length };
	}
	return null;
}

function createFocusedContext(text, exactText) {
	const match = findContextHighlight(text, exactText);
	if (!match || text.length <= CONTEXT_PREVIEW_LENGTH) return { text, match };

	const selectedLength = match.end - match.start;
	let start;
	let end;
	if (selectedLength >= CONTEXT_PREVIEW_LENGTH) {
		start = match.start;
		end = Math.min(text.length, start + CONTEXT_PREVIEW_LENGTH);
	} else {
		const surroundingLength = CONTEXT_PREVIEW_LENGTH - selectedLength;
		start = Math.max(0, match.start - Math.floor(surroundingLength / 2));
		end = Math.min(text.length, Math.max(match.end, start + CONTEXT_PREVIEW_LENGTH));
		start = Math.max(0, Math.min(start, end - CONTEXT_PREVIEW_LENGTH));
	}

	const prefix = start > 0 ? "…" : "";
	const suffix = end < text.length ? "…" : "";
	return {
		text: `${prefix}${text.slice(start, end)}${suffix}`,
		match: {
			start: prefix.length + match.start - start,
			end: prefix.length + Math.min(match.end, end) - start,
		},
	};
}

function appendContextText(element, text, exactText = "") {
	const presentation = exactText ? createFocusedContext(text, exactText) : { text, match: null };
	if (!presentation.match) {
		element.textContent = presentation.text;
		return;
	}

	const { start, end } = presentation.match;
	element.append(document.createTextNode(presentation.text.slice(0, start)));
	const mark = document.createElement("mark");
	mark.className = "context-highlight";
	mark.textContent = presentation.text.slice(start, end);
	element.append(mark, document.createTextNode(presentation.text.slice(end)));
}

function createContextDetails(highlight) {
	const messageContext = typeof highlight.messageContext === "string" ? highlight.messageContext.trim() : "";
	const questionContext = typeof highlight.questionContext === "string" ? highlight.questionContext.trim() : "";
	if (!messageContext && !questionContext) return null;

	const roleLabel = highlight.messageRole === "assistant"
		? "Assistant"
		: highlight.messageRole === "user"
			? "You"
			: "Message";
	const details = document.createElement("details");
	details.className = "context-details";
	const summary = document.createElement("summary");
	summary.textContent = `Context · ${roleLabel}`;
	details.append(summary);

	const body = document.createElement("div");
	body.className = "context-body";
	const appendContext = (labelText, text, exactText = "") => {
		if (!text) return;
		const section = document.createElement("div");
		section.className = "context-section";
		const label = document.createElement("p");
		label.className = "context-label";
		label.textContent = labelText;
		const content = document.createElement("p");
		content.className = "context-text";
		appendContextText(content, text, exactText);
		section.append(label, content);
		body.append(section);
	};

	appendContext("Your question", questionContext);
	appendContext(
		highlight.messageRole === "assistant" ? "Assistant response" : highlight.messageRole === "user" ? "Your message" : "Message",
		messageContext,
		highlight.exactText,
	);
	details.append(body);
	return details;
}

function createHighlightCard(highlight) {
	const item = document.createElement("li");
	item.className = "highlight-card";

	const link = document.createElement("a");
	link.className = "highlight-link";
	link.href = highlight.url;
	link.target = "_blank";
	link.rel = "noreferrer";
	link.title = "Open source conversation";
	link.addEventListener("click", event => {
		event.preventDefault();
		openHighlight(highlight);
	});

	const quote = document.createElement("p");
	quote.className = "quote";
	quote.textContent = highlight.exactText || "Untitled highlight";
	link.append(quote);
	item.append(link);

	if (highlight.note) {
		const note = document.createElement("p");
		note.className = "note-preview";
		note.textContent = highlight.note;
		item.append(note);
	}

	const tags = getHighlightTags(highlight);
	if (tags.length) {
		const tagList = document.createElement("div");
		tagList.className = "card-tags";
		tagList.setAttribute("aria-label", "Highlight tags");
		for (const tag of tags) {
			const tagButton = document.createElement("button");
			tagButton.type = "button";
			tagButton.className = "tag-chip";
			tagButton.textContent = `#${tag}`;
			tagButton.title = `Show highlights tagged ${tag}`;
			tagButton.addEventListener("click", () => {
				selectedTag = getTagKey(tag);
				render();
			});
			tagList.append(tagButton);
		}
		item.append(tagList);
	}

	const contextDetails = createContextDetails(highlight);
	if (contextDetails) item.append(contextDetails);

	const footer = document.createElement("div");
	footer.className = "card-footer";

	const metadata = document.createElement("span");
	metadata.className = "metadata";
	metadata.textContent = formatDate(highlight.createdAt);

	const actions = document.createElement("div");
	actions.className = "card-actions";

	const noteButton = document.createElement("button");
	noteButton.className = "note-button";
	noteButton.type = "button";
	noteButton.textContent = highlight.note ? "Edit" : "Note";
	noteButton.setAttribute("aria-label", highlight.note ? "Edit note" : "Add note");
	noteButton.addEventListener("click", () => openNoteEditor(item, highlight));

	const tagButton = document.createElement("button");
	tagButton.className = "tag-button";
	tagButton.type = "button";
	tagButton.textContent = tags.length ? "Edit tags" : "Tags";
	tagButton.setAttribute("aria-label", tags.length ? "Edit tags" : "Add tags");
	tagButton.addEventListener("click", () => openTagEditor(item, highlight));

	const starButton = document.createElement("button");
	starButton.className = "star-button";
	starButton.type = "button";
	starButton.textContent = highlight.starred === true ? "★" : "☆";
	starButton.setAttribute("aria-label", highlight.starred === true ? "Remove from starred" : "Add to starred");
	starButton.setAttribute("aria-pressed", String(highlight.starred === true));
	starButton.addEventListener("click", () => toggleStarred(highlight));

	const deleteButton = document.createElement("button");
	deleteButton.className = "delete-button";
	deleteButton.type = "button";
	deleteButton.textContent = "Delete";
	deleteButton.setAttribute("aria-label", `Delete highlight: ${highlight.exactText || "Untitled highlight"}`);
	deleteButton.addEventListener("click", () => deleteHighlight(highlight.id));

	actions.append(noteButton, tagButton, starButton, deleteButton);
	footer.append(metadata, actions);
	item.append(footer);
	return item;
}

function createConversationGroup(group, index) {
	const section = document.createElement("section");
	section.className = "conversation-group";

	const itemsId = `conversation-group-${index}`;
	const collapsed = collapsedGroups.has(group.key);
	const header = document.createElement("button");
	header.className = "group-header";
	header.type = "button";
	header.setAttribute("aria-expanded", String(!collapsed));
	header.setAttribute("aria-controls", itemsId);

	const titleContainer = document.createElement("span");
	titleContainer.className = "group-title";
	const disclosure = document.createElement("span");
	disclosure.className = "group-disclosure";
	disclosure.textContent = collapsed ? "›" : "⌄";
	disclosure.setAttribute("aria-hidden", "true");
	const title = document.createElement("span");
	title.className = "group-title-text";
	title.textContent = getConversationTitle(group, index);
	title.title = title.textContent;
	titleContainer.append(disclosure, title);

	const count = document.createElement("span");
	count.className = "group-count";
	count.textContent = `${group.highlights.length} ${group.highlights.length === 1 ? "highlight" : "highlights"}`;
	header.append(titleContainer, count);

	const items = document.createElement("ul");
	items.id = itemsId;
	items.className = "group-items";
	items.hidden = collapsed;
	items.append(...group.highlights.map(createHighlightCard));

	header.addEventListener("click", () => {
		const willCollapse = !items.hidden;
		items.hidden = willCollapse;
		header.setAttribute("aria-expanded", String(!willCollapse));
		disclosure.textContent = willCollapse ? "›" : "⌄";
		if (willCollapse) collapsedGroups.add(group.key);
		else collapsedGroups.delete(group.key);
	});

	section.append(header, items);
	return section;
}

function render() {
	const allTags = getAllTags();
	if (selectedTag && !allTags.some(tag => tag.key === selectedTag)) selectedTag = "";
	renderTagFilters(allTags);
	const visibleHighlights = getVisibleHighlights();
	const groups = groupHighlights(visibleHighlights);
	const filtersActive = Boolean(searchQuery) || starredOnly || Boolean(selectedTag);

	countElement.textContent = filtersActive
		? `${visibleHighlights.length}/${highlights.length}`
		: String(highlights.length);
	emptyStateElement.hidden = visibleHighlights.length !== 0;
	if (visibleHighlights.length === 0) {
		emptyTitleElement.textContent = filtersActive ? "No matching highlights" : "No highlights yet";
		emptyDescriptionElement.textContent = filtersActive
			? "Try another search or clear the active filters."
			: "Select text in a ChatGPT conversation, then choose Highlight from the context menu.";
	}
	listElement.replaceChildren(...groups.map(createConversationGroup));
}

async function deleteHighlight(highlightId) {
	try {
		const stored = await chrome.storage.local.get(STORAGE_KEY);
		const storedHighlights = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
		const nextHighlights = storedHighlights.filter(highlight => highlight.id !== highlightId);
		if (nextHighlights.length === storedHighlights.length) return;

		await chrome.storage.local.set({ [STORAGE_KEY]: nextHighlights });
		statusElement.textContent = "Highlight deleted";
	} catch (error) {
		console.error("[Highlight] could not delete highlight", error);
		statusElement.textContent = "Could not delete highlight";
	}
}

function markdownQuote(value) {
	return String(value || "").split("\n").map(line => `> ${line}`).join("\n");
}

function createMarkdownExport() {
	const exportedAt = new Date().toISOString();
	const groups = groupHighlights([...highlights].sort((left, right) =>
		String(right.createdAt || "").localeCompare(String(left.createdAt || "")),
	));
	const sections = ["# Highlight Library", "", `Exported: ${exportedAt}`];

	groups.forEach((group, index) => {
		sections.push("", `## ${getConversationTitle(group, index)}`);
		for (const highlight of group.highlights) {
			sections.push("", markdownQuote(highlight.exactText || "Untitled highlight"));
			if (highlight.messageRole) {
				sections.push("", `Role: ${highlight.messageRole === "assistant" ? "Assistant" : "You"}`);
			}
			if (highlight.questionContext) sections.push(`Question: ${highlight.questionContext}`);
			if (highlight.messageContext) sections.push(`Context: ${highlight.messageContext}`);
			if (highlight.note) sections.push("", `Note: ${highlight.note}`);
			const tags = getHighlightTags(highlight);
			if (tags.length) sections.push(`Tags: ${tags.map(tag => `#${tag}`).join(" ")}`);
			sections.push("", `Saved: ${formatDate(highlight.createdAt)}`);
			if (highlight.url) sections.push(`Source: ${highlight.url}`);
		}
	});
	return `${sections.join("\n")}\n`;
}

function downloadExport(format) {
	const date = new Date().toISOString().slice(0, 10);
	const isJson = format === "json";
	const content = isJson
		? JSON.stringify({ schemaVersion: EXPORT_SCHEMA_VERSION, exportedAt: new Date().toISOString(), highlights }, null, 2)
		: createMarkdownExport();
	const blob = new Blob([content], { type: isJson ? "application/json" : "text/markdown" });
	const downloadUrl = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = downloadUrl;
	link.download = `highlight-library-${date}.${isJson ? "json" : "md"}`;
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(downloadUrl), 0);
	dataMenuElement.open = false;
	showDataNotice(`Exported ${highlights.length} highlights as ${isJson ? "JSON" : "Markdown"}`);
}

async function initialize() {
	const stored = await chrome.storage.local.get(STORAGE_KEY);
	highlights = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
	render();
}

searchInputElement.addEventListener("input", event => {
	searchQuery = event.target.value.trim().toLocaleLowerCase();
	render();
});

starredFilterElement.addEventListener("click", () => {
	starredOnly = !starredOnly;
	starredFilterElement.setAttribute("aria-pressed", String(starredOnly));
	starredFilterElement.textContent = starredOnly ? "★ Starred" : "☆ Starred";
	render();
});

document.querySelectorAll("[data-export-format]").forEach(button => {
	button.addEventListener("click", () => downloadExport(button.dataset.exportFormat));
});

importButtonElement.addEventListener("click", () => {
	dataMenuElement.open = false;
	showDataNotice("Choose a Highlight JSON backup to import", "neutral");
	importFileElement.value = "";
	importFileElement.click();
});

importFileElement.addEventListener("change", async () => {
	try {
		const file = importFileElement.files?.item(0);
		if (!file) return;
		showDataNotice("Checking backup…", "neutral");
		await importJsonFile(file);
	} catch (error) {
		showDataNotice(`Import failed · ${error.message}`, "error");
	} finally {
		importFileElement.value = "";
	}
});

dataNoticeDismissElement.addEventListener("click", () => {
	dataNoticeElement.hidden = true;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
	if (areaName !== "local" || !changes[STORAGE_KEY]) return;
	highlights = Array.isArray(changes[STORAGE_KEY].newValue)
		? changes[STORAGE_KEY].newValue
		: [];
	render();
});

initialize().catch(error => {
	console.error("[Highlight] library initialization failed", error);
	statusElement.textContent = "Could not load highlights";
});
