// popup.js — settings UI logic.

const $ = (id) => document.getElementById(id);

const els = {
  enabled: $('enabled'),
  keyInput: $('keyInput'),
  pickPictures: $('pickPictures'),
  pickCustom: $('pickCustom'),
  folderStatus: $('folderStatus'),
  folderText: $('folderText'),
  clearFolder: $('clearFolder'),
  footerKey: $('footerKey')
};

let keyListening = false;

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

async function loadSettings() {
  const data = await chrome.storage.sync.get(['saveKey', 'enabled']);
  const key = (data.saveKey || 's').toUpperCase();
  els.keyInput.value = key;
  els.footerKey.textContent = key;
  els.enabled.checked = data.enabled !== false;

  const status = await chrome.runtime.sendMessage({ type: 'hoversave:getStatus' });
  if (status && status.ok && status.hasFolder) {
    setFolderStatus('good', `✓ Saving to "${status.folderName || 'folder'}"`);
  } else {
    setFolderStatus('idle', 'No folder picked — saving to Chrome\'s default Downloads.');
  }

  // Verify the handle is still accessible
  if (status && status.ok && status.hasFolder) {
    const verify = await chrome.runtime.sendMessage({ type: 'hoversave:verifyHandle' });
    if (!verify.ok) {
      setFolderStatus('bad', `✗ ${verify.error}`);
    }
  }
}

els.enabled.addEventListener('change', async () => {
  await chrome.storage.sync.set({ enabled: els.enabled.checked });
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

els.keyInput.addEventListener('keydown', async (e) => {
  if (!keyListening) return;
  e.preventDefault();
  if (typeof e.key !== 'string' || e.key.length !== 1) return;
  const k = e.key.toLowerCase();
  if (!/^[a-z0-9]$/.test(k)) return;
  await chrome.storage.sync.set({ saveKey: k });
  els.keyInput.value = k.toUpperCase();
  els.footerKey.textContent = k.toUpperCase();
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
    if (err && err.name === 'AbortError') return; // user cancelled
    setFolderStatus('bad', `✗ ${err.message || err}`);
  }
}

els.pickPictures.addEventListener('click', () => pickFolder('pictures'));
els.pickCustom.addEventListener('click', () => pickFolder());

els.clearFolder.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'hoversave:clearHandle' });
  setFolderStatus('idle', 'No folder picked — saving to Chrome\'s default Downloads.');
});

loadSettings();
