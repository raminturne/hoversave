# HoverSave — Chrome extension

Hover any image on any page and press a hotkey to save it to your chosen folder.
No right-click, no "Save image as…", no extra tabs.

- **Hotkey**: configurable single key (default `S`).
- **Save folder**: pick a folder once, the extension writes images straight to it.
  - The popup has a **"Use my Pictures folder"** button that opens the system picker
    starting in your Pictures library.
  - You can also pick any other folder ("Choose another folder…").
  - If no folder is picked, the extension falls back to Chrome's default Downloads.
- **Indicator**: a small floating tooltip follows your cursor while an image is hovered
  and confirms the save with a green flash (or red on error).
- **Works on**: regular `<img>` tags, `<input type="image">`, and CSS `background-image`
  on the hovered element.
- **Permissions**: `storage`, `downloads`, `<all_urls>` (so the service worker can
  fetch any image directly, including cross-origin).

## Install (unpacked, dev mode)

1. Open `chrome://extensions` (or `edge://extensions` for Edge).
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and pick the `hoversave-extension` folder.
4. Pin **HoverSave** from the puzzle menu so it's easy to find.
5. Click the icon → choose **Use my Pictures folder** (or another folder).
6. Open `test.html` (or any page with images), hover an image, press `S`.

> Chrome 120+ recommended. The extension uses the File System Access API
> (`showDirectoryPicker` + `FileSystemDirectoryHandle`) which is the only way
> to write to an arbitrary user-chosen folder from a browser extension.

## Files

```
hoversave-extension/
  manifest.json     # MV3 manifest
  background.js     # service worker: fetch + save to chosen folder
  content.js        # runs on every page, detects hover + hotkey
  content.css       # styles for the floating indicator
  popup.html        # settings popup
  popup.js          # popup logic
  popup.css         # popup styles
  icons/icon{16,48,128}.png
  test.html         # local test page
```

## How it works

- `content.js` listens for `mouseover` on every element, walks up to the
  nearest `<img>` or an element with a `background-image`, and shows a tooltip.
- On the configured key, it sends `{type: 'hoversave:save', url, …}` to the
  service worker.
- `background.js` stores a `FileSystemDirectoryHandle` in IndexedDB (key
  `directoryHandle`). On save it:
  1. Verifies `readwrite` permission.
  2. Fetches the image (cross-origin, since the manifest grants `<all_urls>`).
  3. Picks a unique filename: derives the base from the URL, preserves the
     extension (or falls back to the blob MIME), and appends `_N` or a timestamp
     on collision.
  4. Writes via `createWritable()`.
- If no folder is configured (or permission was lost), it falls back to
  `chrome.downloads.download()` → Chrome's default Downloads.

## Notes / edge cases

- Some sites hotlink-protect their images. The service worker fetch respects
  the same network rules as a logged-in browser; if the site rejects the
  request, you'll see a red error in the tooltip.
- Inline `data:` images are supported as long as they start with `data:image/`.
- The extension deliberately does **not** fire while you're typing in an
  `<input>` / `<textarea>` / `contenteditable` element.
- The hotkey is a single character, no modifiers. The popup is intentionally
  minimal — folder, hotkey, on/off.
