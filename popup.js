// popup.js — settings UI logic.
//
// The directory handle is written/read straight from IndexedDB here (via
// idb-shared.js) rather than sent through chrome.runtime.sendMessage, which
// strips FileSystemHandle objects down to lifeless plain objects and breaks
// every method on them (getFileHandle, queryPermission, ...).

import { HANDLE_KEY, idbGet, idbPut } from './idb-shared.js';

const $ = (id) => document.getElementById(id);

const els = {
  enabled: $('enabled'),
  statusText: $('statusText'),
  statusCard: $('statusCard'),
  statusDot: $('statusDot'),
  keyInput: $('keyInput'),
  pickFolder: $('pickFolder'),
  autoSubfolder: $('autoSubfolder'),
  folderTipOverlay: $('folderTipOverlay'),
  dontShowTip: $('dontShowTip'),
  tipCancel: $('tipCancel'),
  tipContinue: $('tipContinue'),
  folderStatus: $('folderStatus'),
  folderText: $('folderText'),
  fixAccess: $('fixAccess'),
  clearFolder: $('clearFolder'),
  footerKey: $('footerKey'),
  verTag: $('verTag')
};

let keyListening = false;

// Map a physical KeyboardEvent.code to a single character that we can store
// and later re-map on the page. Layout-independent — pressing the physical
// "S" key always gives "KeyS" regardless of Farsi / Arabic / Russian etc.
//
// If e.code is missing or non-standard, we fall back to the produced
// character (e.key). That keeps the popup usable on exotic keyboards.
function codeToKeyChar(code, key) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return code.slice(6);
  if (typeof key === 'string' && key.length === 1 && /^[a-zA-Z0-9]$/.test(key)) {
    return key.toLowerCase();
  }
  return null;
}

function setFolderStatus(state, text) {
  els.folderStatus.classList.remove('is-good', 'is-bad');
  const dot = els.folderStatus.querySelector('.dot');
  dot.className = 'dot';
  if (state === 'good') {
    els.folderStatus.classList.add('is-good');
    dot.classList.add('dot-good');
  } else if (state === 'bad') {
    els.folderStatus.classList.add('is-bad');
    dot.classList.add('dot-bad');
  } else {
    dot.classList.add('dot-warn');
  }
  els.folderText.textContent = text;
  els.clearFolder.hidden = state === 'idle';
}

function setExtensionStatus(enabled) {
  if (enabled) {
    els.statusText.textContent = 'Active';
    els.statusCard.classList.remove('is-off');
    els.statusCard.classList.add('is-on');
    els.statusDot.className = 'status-dot dot-on';
  } else {
    els.statusText.textContent = 'Paused';
    els.statusCard.classList.remove('is-on');
    els.statusCard.classList.add('is-off');
    els.statusDot.className = 'status-dot dot-off';
  }
}

async function loadSettings() {
  const data = await chrome.storage.sync.get(['saveKey', 'enabled', 'autoSubfolder']);
  const key = (data.saveKey || 's').toUpperCase();
  els.keyInput.value = key;
  els.footerKey.textContent = key;
  const enabled = data.enabled !== false;
  els.enabled.checked = enabled;
  setExtensionStatus(enabled);
  els.autoSubfolder.checked = data.autoSubfolder !== false;

  try {
    els.verTag.textContent = 'v' + chrome.runtime.getManifest().version;
  } catch {}

  await refreshFolderStatus();
}

// Checks the saved folder + its permission state and updates the status
// line. Shows the "Fix access" button only when permission actually needs
// to be re-granted, so the UI stays quiet when everything is working.
async function refreshFolderStatus() {
  const status = await chrome.runtime.sendMessage({ type: 'hoversave:getStatus' });
  if (!status || !status.ok || !status.hasFolder) {
    els.fixAccess.hidden = true;
    setFolderStatus('idle', "No folder picked — saving to Chrome's default Downloads.");
    return;
  }
  const verify = await chrome.runtime.sendMessage({ type: 'hoversave:verifyHandle' });
  if (verify && verify.ok) {
    els.fixAccess.hidden = true;
    setFolderStatus('good', `✓ Saving to "${status.folderName || 'folder'}"`);
  } else {
    els.fixAccess.hidden = false;
    setFolderStatus('bad', `✗ ${(verify && verify.error) || 'Folder access needs to be renewed.'}`);
  }
}

els.enabled.addEventListener('change', async () => {
  const next = els.enabled.checked;
  await chrome.storage.sync.set({ enabled: next });
  setExtensionStatus(next);
});

els.autoSubfolder.addEventListener('change', async () => {
  await chrome.storage.sync.set({ autoSubfolder: els.autoSubfolder.checked });
});

els.keyInput.addEventListener('focus', () => {
  keyListening = true;
  els.keyInput.value = '';
  els.keyInput.placeholder = '…';
});

els.keyInput.addEventListener('blur', () => {
  keyListening = false;
  els.keyInput.placeholder = 'Press a key';
  loadSettings();
});

// Capture the next physical key press — layout-independent.
els.keyInput.addEventListener('keydown', async (e) => {
  if (!keyListening) return;
  e.preventDefault();
  // Allow Escape to cancel
  if (e.key === 'Escape') {
    els.keyInput.blur();
    return;
  }
  const captured = codeToKeyChar(e.code, e.key);
  if (!captured) return; // unsupported key
  await chrome.storage.sync.set({ saveKey: captured });
  els.keyInput.value = captured.toUpperCase();
  els.footerKey.textContent = captured.toUpperCase();
  els.keyInput.blur();
});

async function doPickFolder() {
  try {
    const picked = await window.showDirectoryPicker({ mode: 'readwrite', startIn: 'desktop' });

    // showDirectoryPicker only grants SESSION permission. To use the handle
    // later (after the service worker restarts, across page loads, etc.) we
    // need PERSISTENT permission. requestPermission upgrades the grant from
    // session to persistent — without it, the background's queryPermission
    // returns 'prompt' and the save silently falls back to Downloads.
    let perm = 'granted';
    try {
      if (picked.requestPermission) {
        perm = await picked.requestPermission({ mode: 'readwrite' });
      }
    } catch (e) {
      console.warn('[hoversave] requestPermission failed:', e);
    }

    if (perm !== 'granted') {
      setFolderStatus('bad', '✗ Permission denied. Click the button again and choose "Allow" on the prompt that appears.');
      return;
    }

    // If enabled, save into a "HoverSave" subfolder of whatever the user
    // picked (creating it if needed) instead of the picked folder itself.
    // The subfolder inherits the permission grant given above.
    let handle = picked;
    if (els.autoSubfolder.checked) {
      try {
        handle = await picked.getDirectoryHandle('HoverSave', { create: true });
      } catch (e) {
        console.warn('[hoversave] could not create HoverSave subfolder, using picked folder directly:', e);
      }
    }

    try {
      await idbPut(HANDLE_KEY, handle);
      els.fixAccess.hidden = true;
      const label = handle === picked ? handle.name : `${picked.name}/${handle.name}`;
      setFolderStatus('good', `✓ Saving to "${label}"`);
    } catch (e) {
      setFolderStatus('bad', `✗ Could not save folder: ${e.message || e}`);
    }
  } catch (err) {
    if (err && err.name === 'AbortError') {
      // User cancelled the picker — OR Chrome auto-cancelled it for them.
      // On Windows, Chrome refuses to hand back a handle for well-known
      // folders (Desktop, Documents, Downloads, Music, Pictures, Videos, or
      // a drive root) when picked directly: it shows "this folder contains
      // system files" and reports the same AbortError as a manual cancel.
      // There's no API workaround for that specific folder — pick something
      // else (we'll auto-create the HoverSave subfolder), or open it in the
      // dialog, click "New folder", and select the new subfolder.
      setFolderStatus(
        'bad',
        '✗ Blocked by Windows. Open the folder, click "New folder", and select that. / بلاک شده توسط ویندوز. پوشه رو باز کن، "New folder" بزن، همونو انتخاب کن.'
      );
      return;
    }
    setFolderStatus('bad', `✗ ${err.message || err}`);
  }
}

els.pickFolder.addEventListener('click', async () => {
  const data = await chrome.storage.sync.get(['hideFolderTip']);
  if (data.hideFolderTip) {
    doPickFolder();
  } else {
    els.dontShowTip.checked = false;
    els.folderTipOverlay.hidden = false;
  }
});

els.tipCancel.addEventListener('click', () => {
  els.folderTipOverlay.hidden = true;
});

els.tipContinue.addEventListener('click', async () => {
  if (els.dontShowTip.checked) {
    await chrome.storage.sync.set({ hideFolderTip: true });
  }
  els.folderTipOverlay.hidden = true;
  // Still inside this click's user-gesture, so showDirectoryPicker is allowed.
  doPickFolder();
});

els.clearFolder.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'hoversave:clearHandle' });
  els.fixAccess.hidden = true;
  setFolderStatus('idle', "No folder picked — saving to Chrome's default Downloads.");
});

els.fixAccess.addEventListener('click', async () => {
  // Read the handle straight from IndexedDB (same context as this click,
  // so requestPermission's user-gesture requirement is satisfied).
  const handle = await idbGet(HANDLE_KEY).catch(() => null);
  if (!handle) {
    setFolderStatus('bad', '✗ No folder set.');
    return;
  }
  if (typeof handle.requestPermission !== 'function') {
    setFolderStatus('bad', '✗ Saved folder reference is invalid. Re-pick the folder above.');
    return;
  }
  setFolderStatus('good', 'Asking for permission…');
  let perm = 'prompt';
  try {
    perm = await handle.requestPermission({ mode: 'readwrite' });
  } catch (e) {
    setFolderStatus('bad', `✗ ${e.message}`);
    return;
  }
  if (perm === 'granted') {
    // Re-store to refresh the entry now that permission is persistent.
    await idbPut(HANDLE_KEY, handle);
  }
  await refreshFolderStatus();
});

loadSettings();
