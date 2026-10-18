# Highlight

A Manifest V3 Chrome extension for persistent text highlights in ChatGPT conversations.

## V0.6 in development

- Restore a Highlight Library from its JSON backup without replacing existing local data.
- Validate imported records before storage and reject unsupported or malformed files.
- Skip duplicate highlight IDs and show a persistent import or export result.

## V0.5

- Add, edit, and remove tags on each saved highlight.
- Filter the Highlight Library by tag or click a tag on a card to view related highlights.
- Include tags in Markdown and JSON exports.

## V0.4

- Save the real ChatGPT conversation title with new highlights and backfill older highlights when their source conversation is revisited.
- Collapse and expand conversation groups in the Highlight Library.
- Add a short note to each highlight and include notes and conversation titles in search.
- Export the complete local library as Markdown or JSON.
- Load earlier parts of long conversations in progressive stages, center the exact saved range, and keep each continuation prompt visible until the user chooses the next search strategy or dismisses it.

## V0.3

- Search saved highlight text and existing tags.
- Star important highlights and filter the library to starred items.
- Group highlights by their source conversation.

## V0.2

- Open the Highlight Library from the extension toolbar icon.
- Browse all saved highlights in a persistent Chrome side panel.
- Open the source conversation and scroll to the saved text, or delete a highlight from the library.
- Keep the library and visible ChatGPT highlights synchronized through `chrome.storage.local`.

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
├── manifest.json  # Manifest V3 configuration
├── sidepanel.css  # Library presentation
├── sidepanel.html # Highlight Library structure
├── sidepanel.js   # Library data and interactions
└── styles.css     # Highlight and toast presentation
```

## Known limitations

- V0.1 supports `chatgpt.com` and the legacy `chat.openai.com` host only.
- Restoration depends on ChatGPT message text and structure remaining sufficiently similar.
- Ambiguous selections that match more than one saved highlight are not removed automatically.
- Conversation groups fall back to generic names when no saved conversation title is available.
- Existing highlights receive their conversation title only after the source conversation is revisited.
- The library does not yet include cloud sync or automatic cross-device synchronization.
- Moving highlights between browsers or devices still requires manual JSON export and import.
- Restoration can still fail if ChatGPT changes or removes the saved text; progressive search cannot recover content that no longer exists in the page.
