// content.js — runs on every page, detects hovered images and the configured hotkey.

(() => {
  const INDICATOR_ID = 'hoversave-indicator';
  const DEFAULT_KEY = 's';
  const MAX_DIM_FOR_PREVIEW = 0; // 0 = don't enforce, just info

  let currentImageUrl = null;
  let saveKey = DEFAULT_KEY;
  let indicator = null;
  let hideTimer = null;
  let enabled = true;

  // ---------- Indicator ----------
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
      }, mode === 'normal' ? 0 : 1400);
    }
  }

  function moveIndicator(x, y) {
    const el = ensureIndicator();
    // keep it on-screen
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

  // ---------- Image detection ----------
  // Walks up from event target to find an <img> or an element with a background-image.
  function findImageUrl(el) {
    if (!el || el.nodeType !== 1) return null;
    let cur = el;
    const stop = document.documentElement;
    while (cur && cur !== stop.parentNode) {
      // <img>, <picture>'s <img> child, or <input type="image">
      if (cur.tagName === 'IMG' && cur.src) {
        return { url: cur.currentSrc || cur.src, source: 'img' };
      }
      if (cur.tagName === 'INPUT' && cur.type === 'image' && cur.src) {
        return { url: cur.src, source: 'input' };
      }
      // background-image
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
      // Multiple backgrounds are comma-separated; take the first
      const first = bg.split('),')[0];
      const m = first.match(/url\((['"]?)(.+?)\1\)/);
      if (m && m[2] && !m[2].startsWith('data:') && !m[2].includes('gradient')) {
        return m[2];
      }
    } catch {}
    return null;
  }

  // ---------- Settings ----------
  function loadSettings() {
    try {
      chrome.storage.sync.get(['saveKey', 'enabled'], (data) => {
        if (data && data.saveKey && typeof data.saveKey === 'string' && data.saveKey.length === 1) {
          saveKey = data.saveKey.toLowerCase();
        } else {
          saveKey = DEFAULT_KEY;
        }
        enabled = data && data.enabled === false ? false : true;
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
        saveKey = (changes.saveKey.newValue || DEFAULT_KEY).toLowerCase();
      }
      if (changes.enabled) {
        enabled = changes.enabled.newValue !== false;
        if (!enabled) {
          currentImageUrl = null;
          const el = ensureIndicator();
          el.style.display = 'none';
        }
      }
    });
  } catch {}

  // ---------- Event listeners ----------
  document.addEventListener('mouseover', (e) => {
    if (!enabled) return;
    const found = findImageUrl(e.target);
    if (found) {
      currentImageUrl = found;
      showIndicator(`Press <kbd>${saveKey.toUpperCase()}</kbd> to save`, 'normal');
      moveIndicator(e.clientX, e.clientY);
    } else {
      // leaving the image
      if (currentImageUrl) {
        currentImageUrl = null;
        hideIndicatorSoon();
      }
    }
  }, true);

  document.addEventListener('mousemove', (e) => {
    if (!enabled || !currentImageUrl) return;
    moveIndicator(e.clientX, e.clientY);
  }, true);

  document.addEventListener('mouseout', (e) => {
    if (!currentImageUrl) return;
    // Only hide if we left the current image tree
    const found = findImageUrl(e.relatedTarget);
    if (!found || found.url !== currentImageUrl.url) {
      currentImageUrl = null;
      hideIndicatorSoon();
    }
  }, true);

  document.addEventListener('keydown', async (e) => {
    if (!enabled || !currentImageUrl) return;

    // Don't interfere with typing in form fields
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) {
      // If focus is on an input, we still allow the shortcut as long as the user
      // is hovering an image — the indicator proves the intent. But we shouldn't
      // steal keystrokes from form fields unless the user opted in via ctrl/alt.
      // Conservative: skip when typing.
      return;
    }

    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (typeof e.key !== 'string' || e.key.length !== 1) return;
    if (e.key.toLowerCase() !== saveKey) return;

    e.preventDefault();
    e.stopPropagation();

    const url = currentImageUrl.url;
    const source = currentImageUrl.source;
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
