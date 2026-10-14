# highlight

A persistent highlight and bookmark system for ChatGPT and the web.

## Current milestone

### V0.0.1 — Extension bootstrap

Goal: prove that our own JavaScript can run on a ChatGPT webpage.

Current files:

```text
extension/
├── manifest.json
└── content.js
```

When the extension is loaded in Chrome and a ChatGPT page is refreshed, the browser console should show:

```text
[Highlight] V0.0.1 loaded on ChatGPT
```

This version does **not** create highlights yet. It only verifies that the extension is successfully injected into ChatGPT.
