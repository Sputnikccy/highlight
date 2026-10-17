# Highlight

A Manifest V3 Chrome extension for persistent text highlights in ChatGPT conversations.

## V0.1

- Select text in a ChatGPT message and use **Highlight** from the context menu.
- Store multiple highlights in `chrome.storage.local` and restore them after refresh.
- Select text inside an existing highlight to use **Remove highlight**.
- Click a highlight to reveal a remove action.
- Undo a newly created highlight from the confirmation toast.
- Render with the CSS Custom Highlight API, leaving ChatGPT's text DOM unchanged.

Saved highlights use the selected text, nearby prefix and suffix context, character offsets, conversation URL, and message hints. DOM `Range` objects are used only while the page is open and are never persisted.

## Install for development

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select the `extension` directory.
4. Open or refresh a conversation on `chatgpt.com`.

## Project structure

```text
extension/
├── background.js  # Context-menu registration and command routing
├── content.js     # Selection capture, persistence, restoration, and removal
├── manifest.json  # Manifest V3 configuration (version 0.1.0)
└── styles.css     # Highlight and toast presentation
```

## Known limitations

- V0.1 supports `chatgpt.com` and the legacy `chat.openai.com` host only.
- Restoration depends on ChatGPT message text and structure remaining sufficiently similar.
- Ambiguous selections that match more than one saved highlight are not removed automatically.
- There is no library UI, search, tagging workflow, sync, or export yet.
