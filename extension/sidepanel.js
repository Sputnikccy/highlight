const STORAGE_KEY = "highlights";

const countElement = document.querySelector("#highlight-count");
const emptyStateElement = document.querySelector("#empty-state");
const listElement = document.querySelector("#highlight-list");
const statusElement = document.querySelector("#status");

let highlights = [];

function formatDate(value) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "Saved highlight";
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(date);
}

function getConversationLabel(highlight) {
	if (highlight.conversationId) return `Conversation · ${formatDate(highlight.createdAt)}`;
	try {
		return `${new URL(highlight.url).hostname} · ${formatDate(highlight.createdAt)}`;
	} catch {
		return formatDate(highlight.createdAt);
	}
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
	metadata.textContent = getConversationLabel(highlight);

	const deleteButton = document.createElement("button");
	deleteButton.className = "delete-button";
	deleteButton.type = "button";
	deleteButton.textContent = "Delete";
	deleteButton.setAttribute("aria-label", `Delete highlight: ${highlight.exactText || "Untitled highlight"}`);
	deleteButton.addEventListener("click", () => deleteHighlight(highlight.id));

	footer.append(metadata, deleteButton);
	item.append(link, footer);
	return item;
}

function render() {
	const sortedHighlights = [...highlights].sort((left, right) =>
		String(right.createdAt || "").localeCompare(String(left.createdAt || "")),
	);

	countElement.textContent = String(sortedHighlights.length);
	emptyStateElement.hidden = sortedHighlights.length !== 0;
	listElement.replaceChildren(...sortedHighlights.map(createHighlightCard));
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
