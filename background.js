// DeepControl: service worker — выполняет команды. Режимы: SAFE (одна вкладка, один сайт) и FULL (все вкладки/окна, любые сайты).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = chrome.storage.local;
const DS_RE = /^https:\/\/chat\.deepseek\.com\//;
const isDs = (t) => DS_RE.test(t?.url || t?.pendingUrl || '');
const FULL_ONLY = new Set(['list_tabs', 'switch_tab', 'close_tab', 'new_window']);
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// ---------- сайт-«загон» для SAFE-режима ----------
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }
function baseDomain(h) {
  if (/^[\d.]+$/.test(h) || h.includes(':')) return h;
  const p = h.split('.');
  if (p.length <= 2) return h;
  const l = p[p.length - 1], s = p[p.length - 2];
  return (l.length === 2 && s.length <= 3 ? p.slice(-3) : p.slice(-2)).join('.');
}
const sameSite = (a, b) => baseDomain(a) === baseDomain(b);

async function state() { return store.get({ targetTabId: null, allowedHost: '', fullControl: false }); }
async function setTarget(id, allowedHost) {
  const tab = await chrome.tabs.get(id);
  const patch = { targetTabId: id, targetTitle: tab.title || tab.url || `tab ${id}` };
  if (allowedHost !== undefined) patch.allowedHost = allowedHost;
  await store.set(patch);
}

// Ссылки target=_blank: новая вкладка от целевой становится целевой.
chrome.tabs.onCreated.addListener(async (tab) => {
  const { targetTabId } = await state();
  if (targetTabId && tab.openerTabId === targetTabId) setTarget(tab.id).catch(() => {});
});
chrome.tabs.onUpdated.addListener(async (id, info, tab) => {
  if (info.title && id === (await state()).targetTabId) store.set({ targetTitle: tab.title });
});
chrome.tabs.onRemoved.addListener(async (id) => {
  if (id === (await state()).targetTabId) store.remove(['targetTabId', 'targetTitle']);
});

function normUrl(u) {
  u = String(u || '').trim();
  if (!u) throw new Error('url is empty');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
  const x = new URL(u);
  if (!['http:', 'https:'].includes(x.protocol)) throw new Error('only http/https allowed');
  return x.href;
}
function checkAllowed(url, st) {
  if (st.fullControl) return;
  const h = hostOf(url);
  if (st.allowedHost && !sameSite(h, st.allowedHost))
    throw new Error(`BLOCKED (Safe mode): navigation allowed only within "${st.allowedHost}", not "${h}". If the task needs other sites, use ask_user to ask the user to enable FullControl mode.`);
}

function waitComplete(tabId, timeout = 15000) {
  return new Promise((res) => {
    const fin = () => { chrome.tabs.onUpdated.removeListener(l); clearTimeout(to); res(); };
    const l = (id, info) => { if (id === tabId && info.status === 'complete') fin(); };
    const to = setTimeout(fin, timeout);
    chrome.tabs.onUpdated.addListener(l);
  });
}
async function settle(tabId) {
  await sleep(500);
  const t = await chrome.tabs.get(tabId);
  if (t.status !== 'complete') await waitComplete(tabId);
  await sleep(300);
}

async function callPage(tabId, action) {
  const send = () => chrome.tabs.sendMessage(tabId, { dc: 'page', action });
  try { return await send(); } catch (e) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['page.js'] });
      await sleep(150);
      return await send();
    } catch (e2) {
      throw new Error('cannot reach this page (chrome://, Web Store, PDF viewer are not accessible): ' + e2.message);
    }
  }
}

async function autoTarget() {
  for (const t of await chrome.tabs.query({ active: true })) {
    if (/^https?:/.test(t.url || '') && !isDs(t)) { await setTarget(t.id, hostOf(t.url)); return t.id; }
  }
  return null;
}

async function exec(action, dsTab) {
  const type = action.type;
  const st = await state();

  if (FULL_ONLY.has(type) && !st.fullControl)
    throw new Error(`"${type}" is available only in FullControl mode, which is currently OFF. Use ask_user to ask the user to enable it.`);

  if (type === 'wait') {
    await sleep(Math.min(Math.max(+action.ms || 1000, 0), 10000));
    return { ok: true, output: 'waited' };
  }
  if (type === 'list_tabs') {
    const tabs = (await chrome.tabs.query({})).filter((t) => !isDs(t));
    const lines = tabs.slice(0, 80).map((t) => `[${t.id}] ${t.id === st.targetTabId ? '★target ' : ''}${t.active ? '(active) ' : ''}win${t.windowId} "${clip(t.title, 70)}" ${clip(t.url, 110)}`);
    return { ok: true, output: `Open tabs (${tabs.length}${tabs.length > 80 ? ', first 80 shown' : ''}):\n` + lines.join('\n') };
  }
  if (type === 'new_tab') {
    const url = normUrl(action.url);
    checkAllowed(url, st);
    const tab = await chrome.tabs.create({ url, active: false, windowId: dsTab?.windowId });
    await setTarget(tab.id);
    await settle(tab.id);
    return { ok: true, output: `new tab ${tab.id} opened and set as target` };
  }
  if (type === 'new_window') {
    const url = normUrl(action.url);
    const w = await chrome.windows.create({ url, focused: false });
    const tab = w.tabs[0];
    await setTarget(tab.id);
    await settle(tab.id);
    return { ok: true, output: `new window opened; tab ${tab.id} is the target` };
  }
  if (type === 'switch_tab' || type === 'close_tab') {
    const id = Number(action.tab_id) || (type === 'close_tab' ? st.targetTabId : 0);
    if (!id) throw new Error('tab_id is required (use list_tabs)');
    let t; try { t = await chrome.tabs.get(id); } catch { throw new Error(`tab ${id} does not exist`); }
    if (isDs(t)) throw new Error('the DeepSeek chat tab cannot be controlled');
    if (type === 'close_tab') { await chrome.tabs.remove(id); return { ok: true, output: `tab ${id} closed; target cleared — use list_tabs/switch_tab` }; }
    await setTarget(id);
    if (dsTab && t.windowId !== dsTab.windowId) await chrome.tabs.update(id, { active: true });
    return { ok: true, output: `target is now tab ${id} "${clip(t.title, 60)}" ${clip(t.url, 100)}` };
  }

  // действие в конкретной вкладке (только FullControl)
  if (st.fullControl && action.tab_id) {
    const id = Number(action.tab_id);
    let t; try { t = await chrome.tabs.get(id); } catch { throw new Error(`tab ${id} does not exist`); }
    if (isDs(t)) throw new Error('the DeepSeek chat tab cannot be controlled');
    await setTarget(id);
    if (dsTab && t.windowId !== dsTab.windowId) await chrome.tabs.update(id, { active: true });
    st.targetTabId = id;
  }

  let tid = st.targetTabId;
  if (!tid && st.fullControl) tid = await autoTarget();
  if (!tid) throw new Error('no target tab selected' + (st.fullControl ? ' (use list_tabs, then switch_tab or new_tab)' : ' — ask the user to pick one in the DeepControl popup'));
  let tab;
  try { tab = await chrome.tabs.get(tid); } catch { throw new Error('target tab was closed' + (st.fullControl ? ' — use list_tabs' : '')); }
  if (isDs(tab)) throw new Error('the DeepSeek chat tab cannot be controlled');

  // SAFE: запоминаем «разрешённый сайт» и не даём работать за его пределами
  if (!st.fullControl) {
    if (!st.allowedHost) { st.allowedHost = hostOf(tab.url); await store.set({ allowedHost: st.allowedHost }); }
    const h = hostOf(tab.url);
    if (h && !sameSite(h, st.allowedHost) && !['navigate', 'go_back'].includes(type))
      throw new Error(`BLOCKED (Safe mode): current tab is on "${h}", outside allowed site "${st.allowedHost}". Use go_back or navigate to an allowed URL, or ask_user to enable FullControl.`);
  }

  const afterNav = async () => {
    await settle(tid);
    if (!st.fullControl) {
      const t = await chrome.tabs.get(tid);
      const h = hostOf(t.url);
      if (h && st.allowedHost && !sameSite(h, st.allowedHost)) {
        await chrome.tabs.goBack(tid).catch(() => {});
        await settle(tid);
        throw new Error(`BLOCKED (Safe mode): the page navigated to "${h}" outside allowed site "${st.allowedHost}"; went back. Ask the user to enable FullControl if needed.`);
      }
    }
  };

  switch (type) {
    case 'navigate': {
      const url = normUrl(action.url);
      checkAllowed(url, st);
      await chrome.tabs.update(tid, { url });
      await afterNav();
      return { ok: true, output: 'navigated' };
    }
    case 'go_back': await chrome.tabs.goBack(tid); await afterNav(); return { ok: true, output: 'went back' };
    case 'go_forward': await chrome.tabs.goForward(tid); await afterNav(); return { ok: true, output: 'went forward' };
    case 'reload': await chrome.tabs.reload(tid); await afterNav(); return { ok: true, output: 'reloaded' };
    case 'screenshot': {
      const wasActive = tab.active;
      if (!wasActive) await chrome.tabs.update(tid, { active: true });
      await sleep(300);
      let out = '';
      if (action.annotate !== false) out = (await callPage(tid, { type: 'annotate' }).catch(() => null))?.output || '';
      let dataUrl;
      try {
        dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      } finally {
        await callPage(tid, { type: 'unannotate' }).catch(() => {});
        if (!wasActive && dsTab && dsTab.windowId === tab.windowId) await chrome.tabs.update(dsTab.id, { active: true });
      }
      return { ok: true, output: 'screenshot attached.\n' + out, screenshot: dataUrl };
    }
    default: {
      const res = await callPage(tid, action);
      if (['click', 'click_xy', 'type', 'press', 'select'].includes(type)) await afterNav();
      return res;
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (msg?.type !== 'dc_exec') return;
  exec(msg.action, sender.tab).then(send).catch((e) => send({ ok: false, error: e.message || String(e) }));
  return true;
});
