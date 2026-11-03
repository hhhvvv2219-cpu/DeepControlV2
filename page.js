// DeepControl: скрипт, работающий внутри управляемой (целевой) вкладки.
(() => {
  if (window.__dcPage) return;
  window.__dcPage = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let registry = new Map(); // id -> element
  let overlay = null;

  const INTERACTIVE =
    'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],' +
    '[role=menuitem],[role=checkbox],[role=switch],[role=option],[role=radio],[contenteditable=""],' +
    '[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';

  const KEYS = {
    Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37,
    ArrowRight: 39, PageDown: 34, PageUp: 33, Home: 36, End: 35, Space: 32
  };

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity !== 0;
  }
  const inViewport = (r) => r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  const clip = (s, n) => {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };
  const isSecret = (el) => {
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    return el.type === 'password' || /cc-|one-time-code|current-password|new-password/.test(ac);
  };

  function labelOf(el) {
    const t = el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') ||
      el.getAttribute('placeholder') || (el.tagName === 'INPUT' && ['button', 'submit'].includes(el.type) ? el.value : '') ||
      el.querySelector('img[alt]')?.alt || el.getAttribute('name') || '';
    return clip(t, 70);
  }

  function indexElements(scope) {
    registry = new Map();
    const all = scope === 'all';
    const found = [];
    for (const el of document.querySelectorAll(INTERACTIVE)) {
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      if (!all && !inViewport(r)) continue;
      found.push({ el, r });
      if (found.length >= (all ? 200 : 120)) break;
    }
    const lines = [];
    found.forEach(({ el, r }, i) => {
      const id = i + 1;
      registry.set(id, el);
      const tag = el.tagName.toLowerCase();
      let desc = `[${id}] ${tag}`;
      if (tag === 'input') desc += `(${el.type})`;
      const lab = labelOf(el);
      if (lab) desc += ` "${lab}"`;
      if (tag === 'a' && el.href) desc += ` href=${clip(el.href, 80)}`;
      if (['input', 'textarea', 'select'].includes(tag) && !isSecret(el) && el.value && !['button', 'submit'].includes(el.type))
        desc += ` value="${clip(el.value, 50)}"`;
      if (isSecret(el)) desc += ' (secret field)';
      if (el.checked) desc += ' [checked]';
      if (el.disabled) desc += ' [disabled]';
      if (all) desc += ` @(${Math.round(r.left)},${Math.round(r.top + scrollY)})`;
      lines.push(desc);
    });
    return lines;
  }

  function pageHeader() {
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    return `URL: ${location.href}\nTitle: ${document.title}\nScroll: ${Math.round(scrollY)}/${Math.round(maxScroll)}px, viewport ${innerWidth}x${innerHeight}`;
  }

  function getEl(id) {
    const el = registry.get(Number(id));
    if (!el) throw new Error(`id ${id} не найден — вызови get_page ещё раз`);
    if (!el.isConnected) throw new Error(`id ${id} устарел (элемент исчез) — вызови get_page ещё раз`);
    return el;
  }

  function fireMouse(el, x, y) {
    const o = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', o));
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new PointerEvent('pointerup', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.click();
  }

  function setNative(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const KEY_ALIAS = { return: 'Enter', esc: 'Escape', del: 'Delete', down: 'ArrowDown', up: 'ArrowUp', left: 'ArrowLeft', right: 'ArrowRight', ' ': 'Space', pgdn: 'PageDown', pgup: 'PageUp' };
  function pressKey(target, key) {
    key = KEY_ALIAS[String(key).toLowerCase()] || Object.keys(KEYS).find((k) => k.toLowerCase() === String(key).toLowerCase()) || key;
    const code = KEYS[key];
    const k = key === 'Space' ? ' ' : key;
    const init = { key: k, code: key === 'Space' ? 'Space' : key, keyCode: code || 0, which: code || 0, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    if (key === 'Enter' || key === 'Space') target.dispatchEvent(new KeyboardEvent('keypress', init));
    const prevented = false;
    target.dispatchEvent(new KeyboardEvent('keyup', init));
    if (key === 'Enter' && !prevented && target.form && target.tagName === 'INPUT') {
      try { target.form.requestSubmit(); } catch (e) { /* ignore */ }
    }
  }

  function annotate(lines) {
    unannotate();
    overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    registry.forEach((el, id) => {
      const r = el.getBoundingClientRect();
      if (!inViewport(r)) return;
      const box = document.createElement('div');
      box.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border:2px solid #e11d48;box-sizing:border-box;`;
      const tag = document.createElement('div');
      tag.textContent = id;
      tag.style.cssText = 'position:absolute;left:0;top:0;background:#e11d48;color:#fff;font:700 13px/1 monospace;padding:2px 4px;';
      box.appendChild(tag);
      overlay.appendChild(box);
    });
    document.documentElement.appendChild(overlay);
  }
  function unannotate() { overlay?.remove(); overlay = null; }

  async function handle(a) {
    switch (a.type) {
      case 'get_page': {
        const lines = indexElements(a.scope === 'all' ? 'all' : 'viewport');
        let out = pageHeader() + `\nElements (${lines.length}):\n` + lines.join('\n');
        if (a.text !== false) out += `\n\nPage text:\n${clip(document.body.innerText, 3000)}`;
        return { ok: true, output: out };
      }
      case 'annotate': {
        const lines = indexElements('viewport');
        annotate(lines);
        return { ok: true, output: pageHeader() + `\nElements (${lines.length}):\n` + lines.join('\n') };
      }
      case 'unannotate': unannotate(); return { ok: true };
      case 'click': {
        const el = getEl(a.id);
        el.scrollIntoView({ block: 'center', inline: 'center' });
        await sleep(100);
        const r = el.getBoundingClientRect();
        el.focus?.();
        fireMouse(el, r.left + r.width / 2, r.top + r.height / 2);
        return { ok: true, output: `clicked ${el.tagName.toLowerCase()} "${labelOf(el)}"` };
      }
      case 'click_xy': {
        const el = document.elementFromPoint(+a.x, +a.y);
        if (!el) throw new Error('в этой точке нет элемента');
        fireMouse(el, +a.x, +a.y);
        return { ok: true, output: `clicked <${el.tagName.toLowerCase()}> at (${a.x},${a.y})` };
      }
      case 'type': {
        const el = getEl(a.id);
        if (isSecret(el)) throw new Error('ввод в поля паролей/карт заблокирован — используй ask_user');
        el.scrollIntoView({ block: 'center' });
        el.focus();
        const text = String(a.text ?? '');
        const clear = a.clear !== false;
        if (el.isContentEditable) {
          if (clear) document.execCommand('selectAll');
          document.execCommand('insertText', false, text);
        } else if ('value' in el) {
          setNative(el, (clear ? '' : el.value) + text);
        } else throw new Error('элемент не поддерживает ввод текста');
        if (a.submit) pressKey(el, 'Enter');
        return { ok: true, output: `typed ${text.length} chars` };
      }
      case 'select': {
        const el = getEl(a.id);
        if (el.tagName !== 'SELECT') throw new Error('элемент не <select>');
        const v = String(a.value);
        const opt = [...el.options].find((o) => o.value === v || o.text.trim() === v);
        if (!opt) throw new Error('нет такой опции: ' + [...el.options].map((o) => o.text.trim()).slice(0, 15).join(' | '));
        el.value = opt.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, output: `selected "${opt.text.trim()}"` };
      }
      case 'press': {
        if (!a.key) throw new Error('не указан key');
        pressKey(document.activeElement || document.body, a.key);
        return { ok: true, output: `pressed ${a.key}` };
      }
      case 'scroll': {
        const target = a.id ? getEl(a.id) : null;
        const amt = Number(a.amount) || Math.round(innerHeight * 0.8);
        const dir = a.direction || 'down';
        const sc = target || window;
        if (dir === 'top') sc.scrollTo({ top: 0 });
        else if (dir === 'bottom') sc.scrollTo({ top: target ? target.scrollHeight : document.documentElement.scrollHeight });
        else sc.scrollBy({ top: dir === 'up' ? -amt : amt });
        await sleep(300);
        const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
        return { ok: true, output: `scrolled ${dir}; page scroll ${Math.round(scrollY)}/${Math.round(max)}px` };
      }
      case 'read_text': {
        const el = a.id ? getEl(a.id) : document.body;
        const max = Math.min(Number(a.max) || 4000, 12000);
        return { ok: true, output: clip(el.innerText, max) };
      }
      case 'ping': return { ok: true };
      default: throw new Error('unknown action "' + a.type + '". Valid: get_page, screenshot, click, click_xy, type, select, press, scroll, read_text, navigate, new_tab, go_back, wait, ask_user, done (+ FullControl: list_tabs, switch_tab, close_tab, new_window, go_forward, reload)');
    }
  }

  chrome.runtime.onMessage.addListener((msg, _s, send) => {
    if (msg?.dc !== 'page') return;
    handle(msg.action).then(send).catch((e) => send({ ok: false, error: e.message }));
    return true;
  });
})();
