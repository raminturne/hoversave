// content.js — runs on every page, detects hovered images and the configured hotkey.
// Uses event.code (physical key position) so Farsi/Arabic/Russian/etc. keyboard
// layouts still trigger the hotkey correctly. event.key (the produced character)
// is layout-dependent, so we deliberately ignore it for hotkey matching.

(() => {
  const INDICATOR_ID = 'hoversave-indicator';
  const BADGE_ID = 'hoversave-badge';
  const DEFAULT_KEY = 's';

  let currentImage = null;
  let saveKey = DEFAULT_KEY;        // stored letter/digit (a-z, 0-9)
  let saveKeyCode = 'KeyS';         // matching physical key code
  let indicator = null;
  let hideTimer = null;
  let enabled = true;
  let badge = null;

  // ---------- Mapping: stored character -> physical KeyboardEvent.code ----------
  // Letter a-z / A-Z -> KeyA..KeyZ
  // Digit 0-9        -> Digit0..Digit9 (top row). Numpad is also supported at runtime.
  function keyCharToCode(ch) {
    if (!ch) return null;
    if (/^[a-zA-Z]$/.test(ch)) return 'Key' + ch.toUpperCase();
    if (/^[0-9]$/.test(ch)) return 'Digit' + ch;
    return null;
  }

  // ---------- Settings ----------
  function loadSettings() {
    try {
      chrome.storage.sync.get(['saveKey', 'enabled'], (data) => {
        const k = (data && data.saveKey) || DEFAULT_KEY;
        if (typeof k === 'string' && keyCharToCode(k)) {
          saveKey = k.toLowerCase();
          saveKeyCode = keyCharToCode(saveKey);
        } else {
          // Stored value isn't a mappable Latin char (could be leftover "س" from
          // an older build). Fall back to default without overwriting storage —
          // the user can re-pick in the popup.
          saveKey = DEFAULT_KEY;
          saveKeyCode = 'KeyS';
        }
        enabled = data && data.enabled === false ? false : true;
        updateBadge();
      });
    } catch (e) {
      // chrome.storage may be unavailable in some contexts
    }
  }

  loadSettings();

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      if (changes.saveKey) {
        const k = changes.saveKey.newValue || DEFAULT_KEY;
        if (keyCharToCode(k)) {
          saveKey = k.toLowerCase();
          saveKeyCode = keyCharToCode(saveKey);
        }
      }
      if (changes.enabled) {
        enabled = changes.enabled.newValue !== false;
        currentImage = null;
        const el = ensureIndicator();
        el.style.display = 'none';
        updateBadge();
      }
    });
  } catch {}

  // ---------- Indicator (hover tooltip) ----------
  function ensureIndicator() {
    if (indicator && document.documentElement.contains(indicator)) return indicator;
    indicator = document.createElement('div');
    indicator.id = INDICATOR_ID;
    indicator.setAttribute('aria-hidden', 'true');
    document.documentElement.appendChild(indicator);
    return indicator;
  }

  function showIndicator(text, mode = 'normal') {
    const el = ensureIndicator();
    el.classList.remove('hoversave-success', 'hoversave-error');
    if (mode === 'success') el.classList.add('hoversave-success');
    if (mode === 'error') el.classList.add('hoversave-error');
    el.innerHTML = text;
    el.style.display = 'block';
    clearTimeout(hideTimer);
    if (mode !== 'normal') {
      hideTimer = setTimeout(() => {
        el.style.display = 'none';
      }, 1400);
    }
  }

  function moveIndicator(x, y) {
    const el = ensureIndicator();
    const pad = 8;
    const w = el.offsetWidth || 120;
    const h = el.offsetHeight || 24;
    const maxX = window.innerWidth - w - pad;
    const maxY = window.innerHeight - h - pad;
    el.style.left = Math.min(Math.max(pad, x + 14), Math.max(pad, maxX)) + 'px';
    el.style.top = Math.min(Math.max(pad, y + 14), Math.max(pad, maxY)) + 'px';
  }

  function hideIndicatorSoon() {
    if (hideTimer) return;
    hideTimer = setTimeout(() => {
      const el = ensureIndicator();
      if (el.classList.contains('hoversave-success') || el.classList.contains('hoversave-error')) return;
      el.style.display = 'none';
      hideTimer = null;
    }, 180);
  }

  // ---------- "OFF" badge (only visible when disabled) ----------
  function ensureBadge() {
    if (badge && document.documentElement.contains(badge)) return badge;
    badge = document.createElement('div');
    badge.id = BADGE_ID;
    badge.setAttribute('aria-hidden', 'true');
    badge.innerHTML = 'HoverSave: <b>OFF</b>';
    badge.addEventListener('click', () => {
      // Best-effort: ping the background to open the popup.
      try { chrome.runtime.sendMessage({ type: 'hoversave:openPopup' }); } catch {}
    });
    document.documentElement.appendChild(badge);
    return badge;
  }

  function updateBadge() {
    const el = ensureBadge();
    if (enabled) {
      el.style.display = 'none';
    } else {
      el.style.display = 'flex';
    }
  }

  // ---------- Image detection ----------
  // Walks up from event target to find an <img> or an element with a background-image.
  function findImage(el) {
    if (!el || el.nodeType !== 1) return null;
    let cur = el;
    const stop = document.documentElement;
    while (cur && cur !== stop.parentNode) {
      if (cur.tagName === 'IMG' && cur.src) {
        return { url: cur.currentSrc || cur.src, source: 'img' };
      }
      if (cur.tagName === 'INPUT' && cur.type === 'image' && cur.src) {
        return { url: cur.src, source: 'input' };
      }
      const bg = safeGetBg(cur);
      if (bg) return { url: bg, source: 'css' };
      cur = cur.parentElement;
    }
    return null;
  }

  function safeGetBg(el) {
    try {
      const bg = window.getComputedStyle(el).backgroundImage;
      if (!bg || bg === 'none') return null;
      const first = bg.split('),')[0];
      const m = first.match(/url\((['"]?)(.+?)\1\)/);
      if (m && m[2] && !m[2].startsWith('data:') && !m[2].includes('gradient')) {
        return m[2];
      }
    } catch {}
    return null;
  }

  // ---------- Event listeners ----------
  document.addEventListener('mouseover', (e) => {
    if (!enabled) return;
    const found = findImage(e.target);
    if (found) {
      currentImage = found;
      showIndicator(`Press <kbd>${saveKey.toUpperCase()}</kbd> to save`, 'normal');
      moveIndicator(e.clientX, e.clientY);
    } else if (currentImage) {
      currentImage = null;
      hideIndicatorSoon();
    }
  }, true);

  document.addEventListener('mousemove', (e) => {
    if (!enabled || !currentImage) return;
    moveIndicator(e.clientX, e.clientY);
  }, true);

  document.addEventListener('mouseout', (e) => {
    if (!currentImage) return;
    const found = findImage(e.relatedTarget);
    if (!found || found.url !== currentImage.url) {
      currentImage = null;
      hideIndicatorSoon();
    }
  }, true);

  // Hotkey: compare the PHYSICAL key code, not the produced character.
  // This makes the shortcut work on Farsi, Arabic, Russian, AZERTY, Dvorak,
  // Colemak, etc. — any layout that has the same physical "S" key position.
  document.addEventListener('keydown', async (e) => {
    if (!enabled || !currentImage) return;

    // Don't steal keystrokes from form fields where the user is typing.
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) {
      return;
    }

    if (e.ctrlKey || e.altKey || e.metaKey) return;

    // e.code is layout-independent: e.g. physical "S" is always "KeyS".
    // We also accept the numpad digit code (Numpad0..Numpad9) for users
    // who bound the hotkey to a digit.
    const code = e.code;
    const isMatch = code === saveKeyCode
      || (/^Digit\d$/.test(saveKeyCode) && code === 'Numpad' + saveKeyCode.slice(5));
    if (!isMatch) return;

    e.preventDefault();
    e.stopPropagation();

    const url = currentImage.url;
    const source = currentImage.source;
    showIndicator('Saving…', 'normal');

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'hoversave:save',
        url,
        source,
        pageUrl: location.href
      });
      if (result && result.ok) {
        const where = result.method === 'folder' ? 'Folder' : 'Downloads';
        showIndicator(`✓ Saved to ${escapeHtml(result.fileName || 'image')} (${where})`, 'success');
      } else {
        showIndicator(`✗ ${escapeHtml((result && result.error) || 'Save failed')}`, 'error');
      }
    } catch (err) {
      showIndicator(`✗ ${escapeHtml(err.message || 'Error')}`, 'error');
    }
  }, true);

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
})();
