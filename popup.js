// popup.js — settings UI logic.

const $ = (id) => document.getElementById(id);

const els = {
  enabled: $('enabled'),
  statusText: $('statusText'),
  statusCard: $('statusCard'),
  statusDot: $('statusDot'),
  keyInput: $('keyInput'),
  pickPictures: $('pickPictures'),
  pickCustom: $('pickCustom'),
  folderStatus: $('folderStatus'),
  folderText: $('folderText'),
  clearFolder: $('clearFolder'),
  footerKey: $('footerKey')
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
  const data = await chrome.storage.sync.get(['saveKey', 'enabled']);
  const key = (data.saveKey || 's').toUpperCase();
  els.keyInput.value = key;
  els.footerKey.textContent = key;
  const enabled = data.enabled !== false;
  els.enabled.checked = enabled;
  setExtensionStatus(enabled);

  const status = await chrome.runtime.sendMessage({ type: 'hoversave:getStatus' });
  if (status && status.ok && status.hasFolder) {
    setFolderStatus('good', `✓ Saving to "${status.folderName || 'folder'}"`);
  } else {
    setFolderStatus('idle', "No folder picked — saving to Chrome's default Downloads.");
  }

  if (status && status.ok && status.hasFolder) {
    const verify = await chrome.runtime.sendMessage({ type: 'hoversave:verifyHandle' });
    if (!verify.ok) {
      setFolderStatus('bad', `✗ ${verify.error}`);
    }
  }
}

els.enabled.addEventListener('change', async () => {
  const next = els.enabled.checked;
  await chrome.storage.sync.set({ enabled: next });
  setExtensionStatus(next);
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

async function pickFolder(startIn) {
  try {
    const opts = { mode: 'readwrite' };
    if (startIn) opts.startIn = startIn;
    const handle = await window.showDirectoryPicker(opts);
    const saveResult = await chrome.runtime.sendMessage({
      type: 'hoversave:saveHandle',
      handle
    });
    if (saveResult && saveResult.ok) {
      setFolderStatus('good', `✓ Saving to "${saveResult.name}"`);
    } else {
      setFolderStatus('bad', `✗ ${(saveResult && saveResult.error) || 'Could not save folder'}`);
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    setFolderStatus('bad', `✗ ${err.message || err}`);
  }
}

els.pickPictures.addEventListener('click', () => pickFolder('pictures'));
els.pickCustom.addEventListener('click', () => pickFolder());

els.clearFolder.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'hoversave:clearHandle' });
  setFolderStatus('idle', "No folder picked — saving to Chrome's default Downloads.");
});

loadSettings();
