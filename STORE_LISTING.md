# Chrome Web Store Listing — Highlight V1.0

## Name

Highlight

## Summary

Save, organize, and return to important passages in your ChatGPT conversations.

## Detailed description

Highlight turns the most useful parts of your ChatGPT conversations into a personal, searchable Library.

Select any passage in ChatGPT, right-click, and choose **Highlight**. The selected words remain highlighted after refresh and are saved to a persistent Chrome side panel. Choose a Library card later to reopen the source conversation and return to the saved passage.

Key features:

- Persistent highlights that leave ChatGPT's original page structure untouched
- A searchable Library organized by conversation
- Notes, tags, stars, filters, sorting, and bulk actions
- Saved message context with the highlighted words clearly marked
- Progressive navigation through long conversations
- Markdown and JSON export, plus JSON backup restore
- Local-only storage with no Highlight account, backend, analytics, advertising, or cloud sync

Highlight currently supports `chatgpt.com` and the legacy `chat.openai.com` host. Restoring a saved location depends on the source conversation still containing sufficiently similar text.

## Single purpose

Save, organize, and reliably revisit user-selected passages from ChatGPT conversations.

## Permission explanations

- `contextMenus`: adds the user-invoked Highlight and Remove highlight commands.
- `sidePanel`: presents the Highlight Library alongside ChatGPT.
- `storage`: keeps highlights and interface preferences on the user's device.
- ChatGPT page access: reads the selected passage and nearby message context, renders saved highlights, and returns the user to a saved passage. It is limited to `chatgpt.com` and `chat.openai.com`.

## Privacy practices disclosure

Highlight handles user-selected website content, related message context, source conversation URLs, user-created notes and tags, and local interface preferences. This data is used only for Highlight's visible features and stays in `chrome.storage.local`. It is not transmitted to the developer or third parties.

Before submission, publish `PRIVACY.md` at a stable public URL and enter that URL in the Chrome Web Store Privacy practices tab.

## Suggested category

Productivity

## Screenshot plan

Prepare full-bleed screenshots at 1280 × 800 pixels:

1. Select a ChatGPT passage and choose Highlight from the context menu.
2. Browse highlights grouped by their source conversations in the Library.
3. Expand a context card with the saved passage marked in yellow.
4. Search, filter, star, tag, and add a note.
5. Choose a Library card and return to the exact saved passage.

Use current V1.0 UI only and avoid exposing real personal conversation content.

## Promotional asset plan

- Store icon: `extension/icons/highlight-128.png`
- Small promotional tile: 440 × 280 pixels
- Optional marquee image: 1400 × 560 pixels
- Keep the dark charcoal, white H, and yellow highlight-line identity consistent across every asset.
