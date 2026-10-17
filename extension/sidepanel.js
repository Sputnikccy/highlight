const STORAGE_KEY = "highlights";

const countElement = document.querySelector("#highlight-count");
const emptyStateElement = document.querySelector("#empty-state");
const emptyTitleElement = document.querySelector("#empty-title");
const emptyDescriptionElement = document.querySelector("#empty-description");
const listElement = document.querySelector("#highlight-list");
const searchInputElement = document.querySelector("#search-input");
const starredFilterElement = document.querySelector("#starred-filter");
const statusElement = document.querySelector("#status");

let highlights = [];
let searchQuery = "";
let starredOnly = false;

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

function matchesSearch(highlight) {
	if (!searchQuery) return true;
	const searchableText = [highlight.exactText, ...(Array.isArray(highlight.tags) ? highlight.tags : [])]
		.filter(Boolean)
		.join(" ")
		.toLocaleLowerCase();
	return searchableText.includes(searchQuery);
}

function getVisibleHighlights() {
	return highlights
		.filter(highlight => (!starredOnly || highlight.starred === true) && matchesSearch(highlight))
		.sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
}

function groupHighlights(visibleHighlights) {
	const groups = new Map();
	for (const highlight of visibleHighlights) {
		const key = getConversationKey(highlight);
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(highlight);
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
	const starred = highlight.starred !== true;
	if (await updateHighlight(highlight.id, () => ({ starred }))) {
		statusElement.textContent = starred ? "Highlight starred" : "Highlight unstarred";
	}
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

	const footer = document.createElement("div");
	footer.className = "card-footer";

	const metadata = document.createElement("span");
	metadata.className = "metadata";
	metadata.textContent = formatDate(highlight.createdAt);

	const actions = document.createElement("div");
	actions.className = "card-actions";

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

	actions.append(starButton, deleteButton);
	footer.append(metadata, actions);
	item.append(link, footer);
	return item;
}

function createConversationGroup(group, index) {
	const section = document.createElement("section");
	section.className = "conversation-group";

	const header = document.createElement("header");
	header.className = "group-header";
	const title = document.createElement("h2");
	title.textContent = `Conversation ${index + 1}`;
	const count = document.createElement("span");
	count.className = "group-count";
	count.textContent = `${group.length} ${group.length === 1 ? "highlight" : "highlights"}`;
	header.append(title, count);

	const items = document.createElement("ul");
	items.className = "group-items";
	items.append(...group.map(createHighlightCard));
	section.append(header, items);
	return section;
}

function render() {
	const visibleHighlights = getVisibleHighlights();
	const groups = groupHighlights(visibleHighlights);
	const filtersActive = Boolean(searchQuery) || starredOnly;

	countElement.textContent = filtersActive
		? `${visibleHighlights.length}/${highlights.length}`
		: String(highlights.length);
	emptyStateElement.hidden = visibleHighlights.length !== 0;
	if (visibleHighlights.length === 0) {
		emptyTitleElement.textContent = filtersActive ? "No matching highlights" : "No highlights yet";
		emptyDescriptionElement.textContent = filtersActive
			? "Try another search or clear the starred filter."
			: "Select text in a ChatGPT conversation, then choose Highlight from the context menu.";
	}
	listElement.replaceChildren(...groups.map(createConversationGroup));
}

async function deleteHighlight(highlightId) {
	const stored = await chrome.storage.local.get(STORAGE_KEY);
	const storedHighlights = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
	const nextHighlights = storedHighlights.filter(highlight => highlight.id !== highlightId);
	if (nextHighlights.length === storedHighlights.length) return;

	await chrome.storage.local.set({ [STORAGE_KEY]: nextHighlights });
	statusElement.textContent = "Highlight deleted";
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
