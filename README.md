# Image Embiggener

Firefox extension that discovers images on the current page (including `srcset`, background images, links, and same-origin iframes), processes them into a sortable gallery, and lets you inspect, filter, log, and save them.

## Main Features

- Toolbar click toggles an on-page shadow-DOM gallery overlay.
- Progressive image processing with duplicate-hash detection and optional filename-based larger-image derivation.
- Filter controls for size, include/exclude regex, sort mode, and derive toggle.
- Full-page single-image viewer with keyboard navigation, zoom/pan, rotate/flip, and `Ctrl+S` save.
- Log view with sortable records, per-row thumbnail previews, `Hidden` toggles, filter/status diagnostics, and clickable highlight matching.
- Save dialog with original/custom naming, live `old -> new` preview, duplicate/collision highlighting, and background-managed downloads (`Save`, `Save & Explore`, `Save & View`).
- Profile-based settings loaded from `browser.storage.sync`, plus standalone `options.html` for editing defaults and per-site profiles.

## Hotkeys (Gallery Open)

- `l`: toggle log view
- `o`: open options page
- `s`: toggle save dialog
- `d`: toggle derive
- `Esc`: close save dialog, then popup, then log, then gallery (in that order)
