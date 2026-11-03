const $ = (id) => document.getElementById(id);
const DEF = { enabled: true, autoRun: false, fullControl: false, vision: false, targetTabId: null, targetTitle: '', allowedHost: '' };
async function init() {
  const st = await chrome.storage.local.get(DEF);
  $('enabled').checked = st.enabled;
  $('autoRun').checked = st.autoRun;
  $('fullControl').checked = st.fullControl;
  $('vision').checked = st.vision;
  $('warn').style.display = st.fullControl ? 'block' : 'none';
  $('safeBox').style.opacity = st.fullControl ? 0.5 : 1;
  $('cur').textContent = st.targetTabId ? `${st.targetTitle || 'tab ' + st.targetTabId}\n🔒 ${st.allowedHost || '—'}` : 'не выбрана';
  const sel = $('tabs');
  sel.innerHTML = '';
  for (const t of await chrome.tabs.query({})) {
    if (!/^https?:/.test(t.url || '') || /^https:\/\/chat\.deepseek\.com\//.test(t.url)) continue;
    const o = document.createElement('option');
    o.value = t.id;
    o.textContent = (t.title || t.url).slice(0, 60);
    if (t.id === st.targetTabId) o.selected = true;
    sel.appendChild(o);
  }
}
$('enabled').onchange = (e) => chrome.storage.local.set({ enabled: e.target.checked });
$('autoRun').onchange = (e) => chrome.storage.local.set({ autoRun: e.target.checked });
$('fullControl').onchange = async (e) => { await chrome.storage.local.set({ fullControl: e.target.checked }); init(); };
$('vision').onchange = (e) => chrome.storage.local.set({ vision: e.target.checked });
$('set').onclick = async () => {
  const id = Number($('tabs').value);
  if (!id) return;
  const t = await chrome.tabs.get(id);
  let host = '';
  try { host = new URL(t.url).hostname.replace(/^www\./, ''); } catch {}
  await chrome.storage.local.set({ targetTabId: id, targetTitle: t.title || t.url, allowedHost: host });
  init();
};
$('open').onclick = () => chrome.tabs.create({ url: 'https://chat.deepseek.com/' });
init();
