# Changelog

## 2026-03-14

- Removed the duplicate in-gallery options editor, changed the gallery `Options` button to open the standalone `options.html` tab via `browser.runtime.openOptionsPage()`, and updated project docs to treat that standalone page as the single options surface.
- Restyled the legacy standalone options page to read like a table instead of separate boxed rows, moved `Add New Profile` beside the sort control in the header, and linked the footer `Regex` help text to `https://regex101.com/`.
- Added gallery-wide image saving with a `Save Images` dialog, filename/folder rules, duplicate original-name detection, and background-driven save / explore / view actions using Firefox downloads APIs.
- Added per-page image logging with sortable columns for path, filename, type, width, height, and filter result, plus a `Reset Removed` action for manually hidden images.
- Refactored gallery image processing so every discovered unique URL is processed into reusable metadata/blob state, allowing the gallery, save dialog, log table, and duplicate detection to share one source of truth.
- Changed popup behavior so the top info bar slides away and the nav overlays nearly disappear when the cursor moves into the bottom quarter of the image.
- Updated `manifest.json` permissions and replaced `background.js` with a download coordinator that manages object URLs and post-save explore/view actions.
- Rewrote `AGENTS.md` to describe the extension’s current design, runtime behavior, UI features, and known design/orphan-code issues.
- Restored progressive gallery rendering so images appear in order as processing completes instead of waiting for the whole batch.
- Moved options editing into an in-overlay panel, made `Save Images` / `Log` / `Options` true toggle buttons, and reordered the header action buttons to `Unhide`, `Save Images`, `Log`, `Options`, close.
- Made new-profile site names editable again from the header, added a dirty-state pastel-green profile save button, and documented the new behavior in `AGENTS.md`.
- Updated single-image popup chrome hiding to key off the bottom quarter of the viewport, including checkerboard background, and expand the image area upward when the infobar hides.
- Added a 1-based gallery index to grid overlays and the log table, plus a wider save dialog and a 20px margin around the log/options panels.
- Changed save-image behavior so the first textbox click adopts the first original filename, background collision checks abort the whole batch on filename clashes, and downloads preserve gallery order.
- Left the badge blank until the first real gallery open in a tab, then resumed the post-open approximate closed-gallery counting behavior.
- Added original-file probing for common size-suffixed filenames such as `_1920w`, `-1300x900`, `_720p`, and `-720`, with per-site per-scheme caching to avoid repeated nonsense requests.
- Verification note: runtime testing in Firefox and JavaScript CLI syntax checking were not available in this workspace, so validation was limited to static review of the edited files.
