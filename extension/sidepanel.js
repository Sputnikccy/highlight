const STORAGE_KEY = "highlights";
const NOTE_MAX_LENGTH = 500;
const TAG_MAX_COUNT = 8;
const TAG_MAX_LENGTH = 24;

const countElement = document.querySelector("#highlight-count");
const emptyStateElement = document.querySelector("#empty-state");
const emptyTitleElement = document.querySelector("#empty-title");
const emptyDescriptionElement = document.querySelector("#empty-description");
const listElement = document.querySelector("#highlight-list");
const searchInputElement = document.querySelector("#search-input");
const starredFilterElement = document.querySelector("#starred-filter");
const exportMenuElement = document.querySelector("#export-menu");
const tagFiltersElement = document.querySelector("#tag-filters");
const tagFilterOptionsElement = document.querySelector("#tag-filter-options");
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
			const changed = await updateHighlight(highlight.id, () => ({ note }));
			if (!changed) editor.remove();
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
			const changed = await updateHighlight(highlight.id, () => ({ tags }));
			if (!changed) editor.remove();
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
		? JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), highlights }, null, 2)
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
	exportMenuElement.open = false;
	statusElement.textContent = `Exported ${highlights.length} highlights as ${isJson ? "JSON" : "Markdown"}`;
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
