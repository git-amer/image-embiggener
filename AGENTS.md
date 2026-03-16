This file is the extension design reference. Update it whenever functionality, behavior, UI layout, or architecture changes so future edits preserve the extension’s real behavior.

## Extension Shape

- `background.js` is the browser-action, badge, save-collision, download, and standalone-options-page coordinator. Badge/options message actions are fire-and-forget; save/collision actions return async responses to content scripts.
- `content.js` owns almost all runtime behavior on web pages: image scraping, progressive processing, gallery creation, filtering, popup viewing, saving, per-page logging, session settings, and badge updates.
- `content.css` styles both the page overlay gallery and the standalone `options.html` page because the options UI reuses extension classes.
- `options.html` and `options.js` are the single profile/default-settings editor, opened as the extension options page.
- `manifest.json` is Firefox Manifest V2 and depends on a browser action plus a background page.

## High-Level Runtime Model

- Clicking the toolbar icon sends `toggleGallery` from `background.js` to the content script in the active tab.
- The content script creates one shadow-DOM host per page (`#image-gallery-extension-host`) and reuses it for reopen cycles.
- Page content outside the overlay is hidden with the `amer-image-gallery-hide` class while the gallery is open; that class is injected into page-level CSS by `content.js` so it applies outside shadow DOM.
- While the overlay is open, `content.js` applies `amer-image-gallery-scroll-lock` on `html/body` to prevent background page scrolling and scroll-chaining artifacts.
- Session state lives in the content script until the tab reloads. This includes current filter settings, removed images, processed image metadata, current profile selection, whether the log panel is active, save-dialog visibility, and whether the header profile save button is dirty.
- Persistent settings live in `browser.storage.sync` as:
  - `defaultProfile`
  - `profiles`

## Image Discovery

- The scraper gathers candidate image URLs from:
  - `<img src>`
  - `<img srcset>` and `data-srcset`
  - `<source srcset>`
  - `<a href>` when the href looks like a direct image URL
  - inline `background-image` URLs
  - same-origin iframes recursively
- Relative and protocol-relative URLs are normalized with `new URL(..., window.location.href)`.
- Windows drive-path URLs like `D:/...` or `D:\...` discovered on `file://` pages are normalized to canonical `file:///D:/...` URLs before processing.
- Discovery and record parsing now preserve non-origin protocols (`file://`, `ftp://`) without forcing a `null/...` path prefix in log/path metadata.
- URL fragments are removed.
- Duplicate URLs are deduplicated before processing, but same-content images with different URLs are only detected later by hashing.

## Processing Pipeline

- Every unique discovered page URL is represented by a page record in `allDiscoveredImages`.
- When filename derivation is enabled and a larger filename probe succeeds for a page image, `allDiscoveredImages` also contains a second derived record for that larger URL unless the larger URL already exists on the page.
- Each record stores:
  - primary source URL for that record
  - originating discovered page URL
  - DOM order index
  - parsed path / filename / basename / extension
  - blob, object URL, mime type, file type
  - width, height, pixel count, byte size
  - SHA-1 hash for same-content duplicate detection
  - filter reasons, gallery membership, current gallery index, and current all-record sort index used by the log
- Images are fetched asynchronously with a concurrency limit.
- The gallery re-renders incrementally as image records finish processing, so thumbnails appear progressively instead of waiting for the full batch.
- Grid row sizing is initialized before the first progressive render, so partial loads still respect the current rows/cols settings.
- The gallery uses the fetched blob data through object URLs, so viewing and saving do not need to re-download the image from the site.
- Same-content duplicates are identified by hash. Only the first gallery-eligible image for a hash is shown in the gallery; later matches are marked as `duplicate` in the log view.
- Before fetching a discovered page image, the processor may probe for a likely original filename when the basename ends in an apparent pixel-size suffix.
- Original-filename probe cache keys are scoped by origin, directory, probe rule, matched basename stem, and extension so one successful probe does not leak across unrelated filenames.
- A probed original URL is only kept if the probe confirms an image response. Page records still keep their original page URL in the log, and if the larger target is usable the smaller page record is filtered by `bigger exists`.
- Current original-filename probe families try both `basename.ext` and `basename-original.ext` outputs for these inputs:
  - `_1920w` and `-1920w`
  - `_1300x900` and `-1300x900`
  - `_720p` and `-720p`
  - `_720` and `-720`

## Gallery View

- The main overlay is a grid view plus a single top controls bar.
- Controls currently include:
  - active profile name
  - save profile button
  - URL regex input for the current page/profile
  - grid column count
  - grid row count
  - minimum pixel size
  - sort mode
  - include regex
  - exclude regex
  - `Derive`
  - `Unhide`
  - `Save Images`
  - `Log`
  - `Options`
  - close button
- The action buttons stay in this order: `Derive`, `Unhide`, `Save Images`, `Log`, `Options`, close.
- `Derive` is a sticky toggle button that defaults on and controls whether filename-based larger-file probing is attempted. Its title text is `Attempt to discover larger files based on filename.`
- `Save Images` and `Log` are toggle buttons and invert colors while their dialog/panel is open.
- `Options` opens the standalone extension options page (`options.html`) in a browser tab through `background.js`.
- The grid is rendered from `allImageData`, which is the currently visible gallery subset after filtering, removal, and duplicate collapse.
- Gallery sorting supports:
  - original DOM order
  - path
  - filename
  - pixel count descending
- Mouse wheel scrolling in the grid advances by rows instead of native pixel scrolling.
- Arrow Up / Down and Page Up / Down also move by rows while the gallery is focused.
- Hovering an image shows an info overlay with dimensions, query parameters, a bold `#`-prefixed gallery index, path, filename, and duplicate count tooltip.
- Hovering the controls bar forces all image info overlays open for easier scanning.

## Filtering Rules

- A gallery image must satisfy all of the following:
  - not manually removed
  - passes include regex, if set and valid
  - does not match exclude regex, if set and valid
  - width is at least `minWidth`
  - height is at least `minHeight`
  - is not filtered by `bigger exists` because a larger derived or page-discovered variant passes the other gallery filters
  - is not a same-content duplicate of an earlier gallery-eligible image
- Filter reasons used by the log view are:
  - `removed`
  - `include`
  - `exclude`
  - `width`
  - `height`
  - `bigger exists`
  - `duplicate`
- Images with fetch/decode failures are excluded from the gallery, but they are shown in the log with an `error` status rather than a filter reason.
- Invalid include/exclude regex patterns are treated as disabled filters, and the corresponding header input is highlighted in red with an `Invalid regex: ...` tooltip instead of logging console warnings.

## Manual Removal

- Pressing Backspace while hovering a gallery tile removes that image from the current gallery session.
- Removed images are tracked by discovered source URL in `removedImageUrls`.
- `Unhide` clears that set and rebuilds the gallery from the already processed records.
- Removal only lasts until the page reloads.

## Save Images

- `Save Images` opens a modal dialog inside the gallery overlay.
- The dialog includes:
  - a filename textbox
  - buttons: `Save & View`, `Save & Explore`, `Save All`, `Cancel`
  - a file list showing the original website filenames that would be used if the textbox is empty or ends with a path separator
  - an error area under the list
- The modal is `80vh` tall and `min(1500px, 90vw)` wide.
- Save scope is exactly the current gallery contents in current gallery order. Filtered-out images, manually removed images, and same-content duplicates that are not visible in the gallery are not saved.
- Save naming rules:
  - textbox input is trimmed with `trim()`
  - if empty, save with original filenames
  - if it ends with `/` or `\`, treat the textbox as a folder path and still save with original filenames
  - otherwise treat the textbox as a base filename that may include subfolders, then append ` 001`, ` 002`, etc.
  - file extension is derived from the original processed image type
- On the first pointer-down inside the textbox, if it is still empty, it auto-fills with the first gallery image filename and selects the basename portion so the user can edit from the original filename.
- Saves go through `background.js` using `browser.downloads.download`.
- All saved files are prefixed with `Image Embiggener/`, so downloads land inside that folder under Firefox’s configured download location.
- `background.js` checks the planned `Image Embiggener/...` paths against existing download history before starting. If any target path collides, nothing is saved and the error area lists the conflicting relative paths.
- `Save & Explore` calls `browser.downloads.show()` on the first saved file after downloads finish.
- `Save & View` calls `browser.downloads.open()` on the first saved file after downloads finish.
- Files are downloaded sequentially in current gallery order, so modified times stay aligned with gallery order.
- The modal closes on success or cancel. It stays open and displays an error if saving fails.
- Duplicate original filenames in the dialog list are highlighted red and disable the three save actions.

## Log View

- `Log` toggles the main panel between gallery grid and a per-page image table while leaving the header controls visible.
- Pressing Escape in log view returns to the gallery instead of closing the whole overlay.
- The log table shows every processed page record plus every processed derived record created from filename probing.
- The log panel has a 20px outer margin.
- Wheel scrolling in log mode is captured by the log panel (including margins around the table) and no longer chains through to the underlying web page.
- Columns:
  - 1-based index of every processed record in the current gallery sort order, including filtered rows
  - path excluding filename
  - filename
  - file type
  - width
  - height
  - filter/status result
- Filter column behavior:
  - green check mark when the image is currently in the gallery
  - light blue `derived` cell with a check mark when the record is a derived larger-file record that is in the gallery and that derived URL is not otherwise present on the page
  - pastel red cell with comma-separated reasons when it is not
  - warm red `error` cell when the image could not be fetched or decoded
- Clicking a column header toggles sorting for that column.
- Clicking a `derived` filter cell underlines `derived` and highlights the originating filename cell in pastel yellow; clicking it again clears the highlight.
- Clicking a `duplicate` filter cell highlights all filename cells in the same duplicate-hash group.
- Clicking a path, filename, type, width, or height cell highlights matching cells in the same pastel yellow. Filename matching ignores file extensions.

## Single Image View

- Clicking a gallery thumbnail opens a full-page overlay popup.
- Popup navigation:
  - click left/right nav zones
  - scroll while hovering nav zones
  - Left / Right arrows
  - Shift+Left / Shift+Right jump backward/forward by one tenth of the gallery
  - Up / Down arrows jump to first/last image
  - Home / End
  - Page Up / Page Down
  - Number keys `0-9` (main row or numpad) jump to `0%-90%` positions in the current gallery list
- Popup zoom and transform controls:
  - wheel zooms
  - middle click toggles fit/original zoom
  - mouse movement pans based on cursor position
  - `x` mirrors horizontally
  - `y` mirrors vertically
  - `r` rotates clockwise
  - `w` rotates counter-clockwise
  - `e` resets transforms
  - `Ctrl+S` saves the currently open image through the background download bridge
- Popup chrome behavior:
  - the top info bar slides up when the cursor is in the bottom quarter of the viewport, even if the pointer is over checkerboard background rather than the image pixels
  - when the chrome hides, the main image area expands upward to fill the freed header space
  - next/previous nav overlays drop to `opacity: 0.001` in that state so they stay functional but visually disappear
- Popup info bar shows progress, dimensions, zoom percentage, and a parsed/styled URL display.

## Escape Handling

- Escape order is intentional:
  - close save dialog first
  - else close single-image popup
  - else if log view is open, return to gallery
  - else close the gallery overlay

## Badge Behavior

- Before the gallery is opened for the first time in a tab, the badge stays blank.
- After the first full gallery open, closing the gallery immediately restarts the mutation observer and keeps rebuilding full processed state in the background, so the badge stays aligned with the exact current gallery count even while the overlay is closed.
- When the gallery is open, the same rescans rebuild processed state and the badge reflects the actual current gallery count.

## Profiles And Options

- On session initialization the content script loads the most specific matching saved profile by regex length.
- If no profile matches, it falls back to `defaultProfile`.
- Session settings are copied from storage into the page-local `settings` object and then evolve independently until reload.
- Gallery profile UI supports:
  - showing the active profile name
  - renaming an existing profile by double-clicking
  - creating a new profile from the current page
  - saving current in-page settings back to sync storage
- When no saved profile matches, clicking the placeholder profile name fills it with the current site name, makes it editable immediately, and suggests a page-specific URL regex.
- The header save button is disabled by default and turns pastel green when current in-page profile state differs from saved state.
- Clicking `Options` in the gallery asks `background.js` to call `browser.runtime.openOptionsPage()`, so the editor opens in the dedicated `options.html` tab rather than inside the page overlay.
- The standalone options page supports:
  - editing the default profile
  - editing saved profiles
  - sorting profiles by index or URL
  - deleting profiles
  - adding a new empty profile
  - toggling `Derive` per profile/default settings
  - mouse-wheel adjustments on numeric/select controls
  - auto-saving edits back to `browser.storage.sync`
- The standalone options page presents profiles in a table-style layout with column headers for profile fields, and its header row contains the page title plus `Sorting by ...` and `Add New Profile` actions.
- The standalone options page footer help text links the word `Regex` to `https://regex101.com/`.

## Styling And Rendering Notes

- The gallery is entirely inside shadow DOM, so any new UI added to the overlay must either live in `getShadowHTML()` or be appended into that shadow root.
- The popup and grid use checkerboard backgrounds injected by `getShadowHTML()`.
- `content.css` styles both the shadow UI and the standalone options page, so changes there can affect both contexts.

## Design Debt / Orphaned Code

- `content.js` is a large monolith with scraping, persistence, rendering, popup logic, and download orchestration all mixed together. Suggested fix: split it into smaller modules or at least clearly separated sections for state, data processing, gallery UI, popup UI, and storage.
- The extension is still Manifest V2 and uses `browserAction`. Suggested fix: migrate to Manifest V3 / `action` before Firefox deprecations become a blocker.
- The standalone options page still has its own separate implementation in `options.js`/`options.html` rather than sharing code with the in-page profile controls in `content.js`. Suggested fix: refactor both paths to share one renderer or storage/editing helper layer.
- Exact closed-gallery badge counts now require background rescans to keep processing records, which is more accurate but still keeps the monolithic content-script architecture doing a lot of work on page mutations. Suggested fix: split processing from rendering and add smarter caching/invalidation.
- Save filenames are sanitized conservatively, but there is still no user-facing preview of the final serialized names when a custom base filename is entered. Suggested fix: add a second live preview list that shows the exact final output names for the current textbox value.

---
# Always Implement

* update changelog.md with changes made.
* keep agents.md outline updated with strucutural changes to the project.
	* functionality of the project should be recorded in detail such that future AI changes do not destroy any existing functionality.

---
# Agenda

- still doesn't work on file:/// and i don't see any errors in the console logs. the path cells in log now shows the proper path, i.e. file:///d:... and the filter cells still show error.
