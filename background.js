// background.js — service worker. Receives save requests, fetches the image,
// and either writes it to the user-chosen folder (File System Access API) or
// falls back to chrome.downloads (which lands in Chrome's default Downloads).
//
// The directory handle itself is written/read straight from IndexedDB (see
// idb-shared.js) — it must never be relayed through chrome.runtime.sendMessage,
// which strips FileSystemHandle objects down to lifeless plain objects.

import { HANDLE_KEY, idbGet, idbPut, idbDelete } from './idb-shared.js';

// ---------- Filename helpers ----------
const EXT_RE = /\.(jpe?g|png|gif|webp|bmp|svg|avif|ico|tiff?|heic|heif|jfif)(\?|#|$)/i;
const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
  'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp',
  'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/x-icon': 'ico',
  'image/tiff': 'tiff', 'image/heic': 'heic', 'image/heif': 'heif'
};

function extFromUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(EXT_RE);
    if (m) return m[1].toLowerCase().replace('jpeg', 'jpg').replace('tif', 'tiff');
  } catch {}
  return null;
}

function extFromMime(blob) {
  if (blob && blob.type && MIME_EXT[blob.type]) {
    return MIME_EXT[blob.type];
  }
  return null;
}

function baseNameFromUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    let last = parts[parts.length - 1] || 'image';
    last = decodeURIComponent(last).split('?')[0].split('#')[0];
    // strip ext
    last = last.replace(EXT_RE, '');
    // sanitize
    last = last.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim();
    if (!last) last = 'image';
    return last.slice(0, 80);
  } catch {
    return 'image';
  }
}

function timestampSuffix() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function buildFileName(url, mimeExt) {
  let base = baseNameFromUrl(url);
  let ext = extFromUrl(url) || mimeExt || 'jpg';
  // Don't duplicate
  if (new RegExp(`\\.${ext}$`, 'i').test(base)) {
    return { base, ext };
  }
  return { base, ext };
}

// ---------- Save logic ----------
async function ensureHandlePermission(handle) {
  if (!handle || typeof handle.queryPermission !== 'function') {
    throw new Error('Saved folder reference is invalid. Open the extension popup and re-pick the folder.');
  }
  const perm = await handle.queryPermission({ mode: 'readwrite' });
  if (perm === 'granted') return true;
  // Cannot re-prompt from the background — the user must click the popup
  // and re-grant. Surface a clear error so the save falls back to Downloads
  // and the indicator shows the reason.
  if (perm === 'prompt') {
    throw new Error('Folder permission needs renewal. Open the extension popup and re-pick the folder.');
  }
  throw new Error('Folder access was blocked. Open the extension popup and re-pick the folder.');
}

async function uniqueName(handle, base, ext) {
  let candidate = `${base}.${ext}`;
  let counter = 1;
  // Try a few candidates, also fall back to timestamp if too many
  while (counter < 1000) {
    try {
      await handle.getFileHandle(candidate, { create: false });
      // exists
    } catch (e) {
      if (e && e.name === 'NotFoundError') return candidate;
      throw e;
    }
    counter += 1;
    candidate = `${base}_${counter}.${ext}`;
  }
  return `${base}_${timestampSuffix()}.${ext}`;
}

async function saveToFolder(handle, url) {
  await ensureHandlePermission(handle);

  // Fetch the image. host_permissions: <all_urls> lets the SW fetch cross-origin.
  const resp = await fetch(url, { credentials: 'include', redirect: 'follow' });
  if (!resp.ok) {
    throw new Error(`Fetch failed: HTTP ${resp.status}`);
  }
  const blob = await resp.blob();
  const mimeExt = extFromMime(blob);
  const { base, ext } = buildFileName(url, mimeExt);
  const fileName = await uniqueName(handle, base, ext);

  const fileHandle = await handle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(blob);
  } finally {
    await writable.close();
  }
  return fileName;
}

async function saveViaDownloads(url) {
  const { base, ext } = buildFileName(url, null);
  const fileName = `${base}.${ext}`;
  const id = await chrome.downloads.download({
    url,
    filename: fileName,
    conflictAction: 'uniquify',
    saveAs: false
  });
  return { id, fileName };
}

// ---------- Message router ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((res) => sendResponse(res))
    .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
  return true; // async response
});

async function handleMessage(msg, sender) {
  if (!msg || typeof msg !== 'object') return { ok: false, error: 'Invalid message' };

  if (msg.type === 'hoversave:save') {
    const url = msg.url;
    if (!url || typeof url !== 'string') {
      return { ok: false, error: 'No image URL' };
    }
    // Skip non-http(s) data: blobs are okay but handled below
    if (!/^(https?:|data:image\/)/i.test(url)) {
      return { ok: false, error: 'Unsupported image source' };
    }

    const handle = await idbGet(HANDLE_KEY).catch(() => null);
    if (handle) {
      try {
        const fileName = await saveToFolder(handle, url);
        return { ok: true, method: 'folder', fileName };
      } catch (err) {
        // If folder access failed, fall back to downloads (do not throw)
        console.warn('[hoversave] folder save failed, falling back:', err);
        const { fileName } = await saveViaDownloads(url);
        return { ok: true, method: 'downloads', fileName, warning: err.message };
      }
    } else {
      const { fileName } = await saveViaDownloads(url);
      return { ok: true, method: 'downloads', fileName };
    }
  }

  if (msg.type === 'hoversave:clearHandle') {
    await idbDelete(HANDLE_KEY);
    return { ok: true };
  }

  if (msg.type === 'hoversave:getStatus') {
    const handle = await idbGet(HANDLE_KEY).catch(() => null);
    let folderName = null;
    if (handle && handle.name) folderName = handle.name;
    return { ok: true, hasFolder: !!handle, folderName };
  }

  if (msg.type === 'hoversave:verifyHandle') {
    const handle = await idbGet(HANDLE_KEY).catch(() => null);
    if (!handle) return { ok: false, error: 'No folder set' };
    try {
      if (typeof handle.queryPermission !== 'function') {
        return {
          ok: false,
          error: 'Saved folder reference is invalid (corrupted or from an old version). Re-pick the folder.',
          permissionState: 'invalid'
        };
      }
      const perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        return { ok: true, folderName: handle.name };
      }
      if (perm === 'prompt') {
        return {
          ok: false,
          error: 'Folder needs permission. Click "Save into my Pictures folder" (or "Choose another folder…") again to re-grant.',
          permissionState: perm
        };
      }
      return {
        ok: false,
        error: 'Folder access was blocked. Re-pick the folder and click "Allow" on the prompt.',
        permissionState: perm
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  return { ok: false, error: 'Unknown action' };
}

// ---------- Lifecycle ----------
chrome.runtime.onInstalled.addListener(() => {
  // First-run defaults
  chrome.storage.sync.get(['saveKey', 'enabled'], (data) => {
    const updates = {};
    if (!data.saveKey) updates.saveKey = 's';
    if (data.enabled === undefined) updates.enabled = true;
    if (Object.keys(updates).length) chrome.storage.sync.set(updates);
  });
});

// ---------- Global keyboard shortcut (chrome.commands) ----------
// The user can rebind this at chrome://extensions/shortcuts.
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-enabled') {
    const data = await chrome.storage.sync.get(['enabled']);
    const next = !(data.enabled !== false); // default true
    await chrome.storage.sync.set({ enabled: next });
    // Visual ack: a transient badge change on the action icon is the only
    // thing a service worker can show. The content script's "OFF" badge will
    // update automatically because it listens to chrome.storage.onChanged.
    try {
      await chrome.action.setBadgeText({ text: next ? '' : 'OFF' });
      await chrome.action.setBadgeBackgroundColor({ color: '#fbbf24' });
      if (!next) {
        setTimeout(() => chrome.action.setBadgeText({ text: '' }).catch(() => {}), 1500);
      }
    } catch {}
  }
});
