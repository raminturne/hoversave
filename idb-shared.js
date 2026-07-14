// idb-shared.js — shared IndexedDB helpers for the saved directory handle.
//
// FileSystemDirectoryHandle objects can be stored/retrieved via IndexedDB's
// structured-clone algorithm and keep working when read back — including
// from a *different* extension context (background service worker vs.
// popup page), because IndexedDB does its own native serialization.
//
// chrome.runtime.sendMessage does NOT preserve these handles the same way:
// its message-passing layer strips them down to a plain data object with no
// methods. So the handle must be written to IndexedDB from the same context
// that created it (the popup, via showDirectoryPicker), and read directly
// from IndexedDB wherever it's needed — never relayed through sendMessage.

export const DB_NAME = 'HoverSaveDB';
export const DB_VERSION = 1;
export const STORE_NAME = 'handles';
export const HANDLE_KEY = 'directoryHandle';

// The DB can land in a bad state ("Version change transaction was aborted in
// upgradeneeded event handler") if the extension is reloaded mid-upgrade, if
// another instance/tab has it open with an older version, or if a previous
// install left a partial schema. We make openDB self-healing: on failure we
// delete the DB and re-create it. The user loses the saved folder handle and
// has to re-pick — but the extension stays usable.

export function openDB() {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(e);
      return;
    }

    req.onupgradeneeded = (event) => {
      const db = req.result;
      try {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      } catch (e) {
        console.error('[hoversave] upgradeneeded error:', e);
        throw e;
      }
    };

    req.onblocked = () => {
      reject(new Error('Database is locked by another tab. Close other HoverSave windows and try again.'));
    };

    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        try { db.close(); } catch {}
      };
      resolve(db);
    };

    req.onerror = () => reject(req.error);
  });
}

export function deleteDB() {
  return new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.deleteDatabase(DB_NAME);
    } catch {
      resolve();
      return;
    }
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

export async function openDBWithRecovery() {
  try {
    return await openDB();
  } catch (err) {
    const msg = (err && err.message) || String(err);
    const looksLikeAbort = err && (err.name === 'AbortError' || /abort|versionchange|blocked/i.test(msg));
    console.warn('[hoversave] openDB failed, attempting reset:', err);
    if (!looksLikeAbort) throw err;
    await deleteDB();
    await new Promise((r) => setTimeout(r, 50));
    return await openDB();
  }
}

export async function idbGet(key) {
  const db = await openDBWithRecovery();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (e) {
      reject(e);
    }
  });
}

export async function idbPut(key, value) {
  const db = await openDBWithRecovery();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    } catch (e) {
      reject(e);
    }
  });
}

export async function idbDelete(key) {
  const db = await openDBWithRecovery();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    } catch (e) {
      reject(e);
    }
  });
}

