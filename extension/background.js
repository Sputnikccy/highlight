const MENU_ID = "highlight-selection";
const CHATGPT_URL_PATTERNS = [
	"https://chatgpt.com/*",
	"https://chat.openai.com/*",
];
const menuModes = new Map();
let contextMenuRegistered = false;
let contextMenuRegistrationInProgress = false;

function ensureContextMenu() {
	if (contextMenuRegistered || contextMenuRegistrationInProgress) return;
	contextMenuRegistrationInProgress = true;

	const finishRegistration = error => {
		contextMenuRegistrationInProgress = false;
		if (error) {
			console.error("[Highlight] context menu registration failed", error.message || error);
			return;
		}
		contextMenuRegistered = true;
	};

	const createMenu = () => {
		try {
			chrome.contextMenus.create({
				id: MENU_ID,
				title: "Highlight",
				contexts: ["selection"],
				documentUrlPatterns: CHATGPT_URL_PATTERNS,
			}, () => finishRegistration(chrome.runtime.lastError));
		} catch (error) {
			finishRegistration(error);
		}
	};

	try {
		chrome.contextMenus.update(MENU_ID, { title: "Highlight" }, () => {
			const error = chrome.runtime.lastError;
			if (!error) {
				finishRegistration(null);
			} else if (/cannot find|does not exist|not found/i.test(error.message)) {
				createMenu();
			} else {
				finishRegistration(error);
			}
		});
	} catch (error) {
		finishRegistration(error);
	}
}

function updateContextMenuTitle(mode) {
	const title = mode === "remove" ? "Remove highlight" : "Highlight";
	try {
		chrome.contextMenus.update(MENU_ID, { title }, () => {
			if (chrome.runtime.lastError) {
				console.warn("[Highlight] context menu update failed", chrome.runtime.lastError.message);
			}
		});
	} catch (error) {
		console.warn("[Highlight] context menu update failed", error);
	}
}

function handleContextMenuClick(info, tab) {
	if (info.menuItemId !== MENU_ID) return;
	if (!tab || tab.id === undefined) {
		console.error("[Highlight] context menu click has no tab");
		return;
	}

	const menuMode = menuModes.get(tab.id) || { mode: "highlight" };
	menuModes.delete(tab.id);
	const message = menuMode.mode === "remove" && menuMode.highlightId
		? { type: "REMOVE_HIGHLIGHT", highlightId: menuMode.highlightId }
		: { type: "HIGHLIGHT_SELECTION" };
	chrome.tabs.sendMessage(tab.id, message, response => {
		if (chrome.runtime.lastError) {
			console.error("[Highlight] transport failed", chrome.runtime.lastError.message);
			return;
		}
		if (!response?.ok) {
			console.error("[Highlight] command failed", {
				stage: response?.stage || "transport-response",
				error: response?.error || "NO_COMMAND_RESPONSE",
			});
			return;
		}
	});
}

function handleContextModeChanged(message, sender, sendResponse) {
	if (message?.type !== "CONTEXT_MODE_CHANGED" || sender.tab?.id === undefined) return;
	const mode = message.mode === "remove" && typeof message.highlightId === "string"
		? { mode: "remove", highlightId: message.highlightId }
		: { mode: "highlight" };
	menuModes.set(sender.tab.id, mode);
	updateContextMenuTitle(mode.mode);
	sendResponse({ ok: true });
}

chrome.contextMenus.onClicked.addListener(handleContextMenuClick);
chrome.runtime.onMessage.addListener(handleContextModeChanged);
chrome.runtime.onInstalled.addListener(ensureContextMenu);
chrome.runtime.onStartup.addListener(ensureContextMenu);

ensureContextMenu();
