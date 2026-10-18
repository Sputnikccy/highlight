# Highlight V1.0 Release Checklist

## Code and package

- [ ] Confirm the branch is based on the latest `main` and the worktree contains only intended V1.0 changes.
- [ ] Confirm `extension/manifest.json` is Manifest V3 and version `1.0.0`.
- [ ] Run JavaScript syntax checks for `background.js`, `content.js`, and `sidepanel.js`.
- [ ] Validate the manifest JSON and every declared icon path.
- [ ] Run `git diff --check` and review the complete diff.
- [ ] Reload the unpacked extension and confirm the Extensions page shows zero errors.
- [ ] Create the release ZIP from the contents of `extension/` without `.DS_Store` or development-only files.

## First-use and accessibility

- [ ] Open the Library with a fresh extension storage state and confirm the welcome guide appears once.
- [ ] Close the guide with **Got it**, the close button, and Escape; confirm focus remains usable.
- [ ] Reopen the guide from **Data → How Highlight works**.
- [ ] Confirm the guide accurately says data is local and no server, analytics, or cloud sync exists.
- [ ] Navigate the complete Library with Tab and Shift+Tab and confirm every focus indicator is visible.
- [ ] Confirm light mode, dark mode, a narrow side panel, and reduced-motion mode remain usable.
- [ ] Confirm loading, empty, no-results, success, and storage-error states are readable.

## Highlight regression

- [ ] Create one highlight and immediately Undo it.
- [ ] Create multiple highlights in one conversation and confirm all restore after refresh.
- [ ] Remove a highlight from the source page and confirm it does not return.
- [ ] Remove a highlight from the Library and confirm the source page updates.
- [ ] Open highlights near the top, middle, and bottom of a long conversation.
- [ ] Complete each progressive location step and confirm its prompt remains available until dismissed or continued.
- [ ] Confirm restored anchors repair their saved metadata without creating duplicates.

## Library regression

- [ ] Search highlight text, notes, tags, conversation titles, and context.
- [ ] Test all views, both sort orders, tag filters, stars, notes, and context expansion.
- [ ] Enter selection mode and test select-all-results, star, unstar, tag, and delete.
- [ ] Confirm selection applies to all matching results, not only the current rendered batch.
- [ ] Test **Show more** with more than 50 matching highlights.
- [ ] Export Markdown and JSON; import the JSON; confirm duplicates are skipped.
- [ ] Confirm visible error notices remain until dismissed.

## Chrome Web Store

- [ ] Publish `PRIVACY.md` at a stable public URL and add it to the Privacy practices tab.
- [ ] Ensure dashboard privacy answers match the extension, listing, and privacy policy exactly.
- [ ] Add the 128 × 128 PNG store icon.
- [ ] Add at least one full-bleed 1280 × 800 or 640 × 400 screenshot; five are planned in `STORE_LISTING.md`.
- [ ] Add a 440 × 280 small promotional tile.
- [ ] Add the listing summary, detailed description, Productivity category, support URL, and language.
- [ ] Explain every requested permission and certify the Chrome Web Store Limited Use requirements.
- [ ] Verify the developer account's required security and distribution settings before submission.

## Git release

- [ ] Commit only after the Chrome regression passes.
- [ ] Push the V1.0 branch and open a pull request into `main`.
- [ ] Review and merge the pull request.
- [ ] Create a `v1.0.0` tag and GitHub release only after `main` is verified.
