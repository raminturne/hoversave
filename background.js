// background.js — service worker. Receives save requests, fetches the image,
// and either writes it to the user-chosen folder (File System Access API) or
// falls back to chrome.downloads (which lands in Chrome's default Downloads).

const DB_NAME = 'HoverSaveDB';
const DB_VERSION = 1;
const STORE_NAME = 'handles';
const HANDLE_KEY = 'directoryHandle';

// ---------- IndexedDB helpers (for the directory handle) ----------
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.objectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

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
  if (!handle || !handle.queryPermission) return false;
  let perm = await handle.queryPermission({ mode: 'readwrite' });
  if (perm === 'granted') return true;
  // Cannot re-prompt from the background — the user must click the popup action
  // and re-grant. We surface a clear error.
  throw new Error('Folder permission lost. Re-open the extension popup and re-pick the folder.');
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
  const fileName = `${base}_${timestampSuffix()}.${ext}`;
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

  if (msg.type === 'hoversave:saveHandle') {
    if (!msg.handle) return { ok: false, error: 'No handle provided' };
    // Make sure we can write
    let perm = 'granted';
    try {
      if (msg.handle.queryPermission) {
        perm = await msg.handle.queryPermission({ mode: 'readwrite' });
      }
    } catch {}
    if (perm !== 'granted') {
      return { ok: false, error: 'Permission not granted' };
    }
    await idbPut(HANDLE_KEY, msg.handle);
    return { ok: true, name: msg.handle.name || 'folder' };
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
      const perm = handle.queryPermission
        ? await handle.queryPermission({ mode: 'readwrite' })
        : 'granted';
      if (perm !== 'granted') {
        return { ok: false, error: 'Folder permission lost — re-pick the folder.' };
      }
      return { ok: true, folderName: handle.name };
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
