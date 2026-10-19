# Highlight Privacy Policy

Effective date: October 19, 2026

Highlight is a Chrome extension with one purpose: let users save, organize, and return to selected passages in their ChatGPT conversations.

## Data Highlight handles

Highlight processes only the information needed to provide that purpose:

- text the user explicitly chooses to highlight;
- nearby message and question context used to restore and explain the highlight;
- the source conversation URL, identifier, and title;
- saved timestamps, notes, tags, and starred state;
- local interface preferences, such as whether the welcome guide has been seen.

Depending on what a user chooses to save, this information may include website content, user-generated content, or personal communications.

## How the data is used

The extension uses this information to render highlights, restore them after a page reload, organize them in the Highlight Library, search and export the Library, and reopen the source conversation at the saved passage.

## Storage and transmission

Highlight stores its data in `chrome.storage.local` on the user's device. Highlight does not operate a backend service and does not transmit saved highlights, conversation content, browsing activity, or usage analytics to the developer or to third parties.

When a user explicitly exports the Library, Chrome downloads a Markdown or JSON file to the location chosen by the user. Exported files are not encrypted by Highlight, so users should protect them like any other personal file.

## Sharing and advertising

Highlight does not sell, share, or use user data for advertising, credit, insurance, or other unrelated purposes. The developer does not have access to locally stored Highlight data.

Highlight's use of information complies with the Chrome Web Store User Data Policy, including its Limited Use requirements.

## Permissions

- **Context menus** provide the user-invoked Highlight and Remove highlight commands.
- **Side panel** displays the saved Highlight Library.
- **Storage** saves highlights and interface preferences locally.
- **Access to ChatGPT pages** reads only the user-selected text and the nearby conversation content needed to create, restore, and revisit highlights. The extension runs only on `chatgpt.com` and the legacy `chat.openai.com` host.

## User control and retention

Users can remove individual or selected highlights from the Library, remove a visible highlight from its source page, or uninstall the extension to remove its local Chrome storage. Users can also export and re-import their own backup files.

Saved data remains on the device until the user deletes it or removes the extension. Highlight does not retain a separate server copy.

## Changes and contact

If Highlight's data practices change, this policy and the in-product disclosure will be updated before the new behavior is released. Privacy questions can be submitted through the project's support page listed in the Chrome Web Store.
