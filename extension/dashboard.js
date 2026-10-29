// Floating dashboard: progress, controls, and a Creator > Release > Model tree
// where each item can be set to Get or Skip before (or during) downloading.

const BRIDGE = 'http://127.0.0.1:8766';
const $ = (id) => document.getElementById(id);
const expanded = new Set(); // "c:<creator>" and "b:<creator>/<bundle>"
let tree = [];
let filter = '';
let historyMode = false;
let history = [];

const fmt = (b) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : b >= 1048576 || !b ? `${(b / 1048576).toFixed(0)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

async function bridge(pathname, body) {
  const res = await fetch(`${BRIDGE}${pathname}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-MMF-Bridge': '1', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Bridge HTTP ${res.status}`);
  return res.json();
}

// ---------- start bridge (native messaging helper) ----------

const HOST_NAME = 'com.mmf_downloader.bridge';
let startingBridge = false;
let bridgeError = null;

async function startBridge() {
  if (startingBridge) return;
  startingBridge = true;
  $('startBridge').disabled = true;
  $('msg').textContent = 'Starting the bridge... (a "MMF Downloader bridge" window will open)';
  $('msg').className = 'msg';
  try {
    const r = await chrome.runtime.sendNativeMessage(HOST_NAME, { cmd: 'startBridge' });
    bridgeError = r?.ok ? null : `Couldn't start the bridge: ${r?.error ?? 'no reply'}`;
  } catch (err) {
    bridgeError = /not found|forbidden/i.test(err.message)
      ? 'One-time setup needed for this button: in the MMF Downloader folder run  node mmf.js install-host  then reload the extension. (Or start it by hand: node mmf.js serve)'
      : `Couldn't start the bridge: ${err.message}`;
  } finally {
    startingBridge = false;
    $('startBridge').disabled = false;
    await refreshStatus();
  }
}

// ---------- status header ----------

async function refreshStatus() {
  const s = await chrome.storage.local.get({ running: false, message: 'Idle', resumeAt: null });
  let st = null;
  try { st = await bridge('/status'); } catch { /* offline */ }

  $('dot').className = `dot ${st ? 'ok' : 'bad'}`;
  $('start').disabled = s.running || !st;
  $('pause').disabled = !s.running;
  $('sync').disabled = !st;
  document.documentElement.style.setProperty('--header-h', `${$('header').offsetHeight}px`);

  $('startBridge').classList.toggle('hidden', !!st);
  if (!st) {
    if (!startingBridge) {
      $('msg').textContent = bridgeError ?? 'Bridge offline. Click "Start bridge", or in the MMF Downloader folder run:  node mmf.js serve';
      $('msg').className = 'msg warn';
    }
    return;
  }
  bridgeError = null;
  const sum = st.summary;
  $('start').disabled = s.running || (!st.batch && !st.upcoming.files);
  // The bar, file count, GB and ETA follow the current batch (what Start set
  // going). Between batches they show what the next Start would download.
  const b = st.batch ?? { total: st.upcoming.files, done: 0, failed: 0, bytesTotal: st.upcoming.bytes, bytesDone: 0 };
  const pct = b.total ? (100 * b.done) / b.total : 0;
  $('fill').style.width = `${pct.toFixed(1)}%`;
  $('count').textContent = `${b.done.toLocaleString()} / ${b.total.toLocaleString()}`;
  $('countLabel').textContent = st.batch ? ' files this batch' : ' files selected';
  $('bytes').textContent = `${fmt(b.bytesDone)} / ${fmt(b.bytesTotal)}`;
  $('archiveStat').textContent = `Archive: ${sum.done.toLocaleString()} files done`;
  $('skippedStat').textContent = sum.skipped ? `${sum.skipped.toLocaleString()} unchecked (${fmt(sum.bytesSkipped)})` : '';
  $('rate').textContent = `${st.rate.inLastHour}/${st.rate.cap} this hour`;
  $('rate').classList.toggle('atcap', st.rate.inLastHour >= st.rate.cap);
  // Rough time left: the hourly cap usually sets the pace.
  const left = b.total - b.done - b.failed;
  $('eta').textContent = left ? `~${etaText(left / st.rate.cap)} left at ${st.rate.cap}/h` : '';
  $('failed').textContent = sum.failed ? `${sum.failed} failed` : '';
  $('retry').classList.toggle('hidden', !sum.failed);

  let text = st.paused ? `Paused: ${st.pauseReason}` : s.message;
  const waitingForCap = s.running && !st.paused && s.resumeAt && s.resumeAt > Date.now() && !st.current;
  if (waitingForCap) {
    const secs = Math.ceil((s.resumeAt - Date.now()) / 1000);
    text = `Hourly limit reached (${st.rate.cap} downloads). Resumes automatically in ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}, at ${new Date(s.resumeAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Leave Chrome and the bridge open.`;
  }
  const waiting = sum.pending + sum.active;
  if (!st.paused && !s.running && waiting) text = `Ready: ${waiting.toLocaleString()} file${waiting === 1 ? '' : 's'} to download. Press Start.`;
  if (!st.paused && st.current && s.running) text = `Downloading ${st.current.label} (${fmt(st.current.size || 0)})`;
  if (!st.batch && !st.upcoming.files && !st.paused && st.lastBatch) {
    const lb = st.lastBatch;
    const when = new Date(lb.finishedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    text = `Last batch done ✓ ${lb.files.toLocaleString()} file${lb.files === 1 ? '' : 's'}, ${fmt(lb.bytes)} (finished ${when})${lb.failed ? `, ${lb.failed} failed` : ''}. Check more models to start another.`;
  }
  if (!sum.total && !sum.skipped) text = `${s.message}\nNo download queue yet: click "Sync library", then run "node mmf.js plan".`;
  $('msg').textContent = text;
  $('msg').className = st.paused || waitingForCap ? 'msg warn' : 'msg';
}

function etaText(hours) {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} days`;
}

// ---------- tree ----------

const objectsOf = (node) => (node.objects ?? node.bundles?.flatMap((b) => b.objects) ?? []);
const matches = (text) => !filter || text.toLowerCase().includes(filter);

function stats(objs) {
  let files = 0, bytes = 0, unsized = 0, getN = 0, selFiles = 0, selDone = 0, failed = 0;
  for (const o of objs) {
    files += o.files; bytes += o.bytes; unsized += o.unsized ?? 0;
    if (!o.skip) { getN++; selFiles += o.files; selDone += o.doneFiles; failed += o.failed; }
  }
  return { files, bytes, unsized, getN, selFiles, selDone, failed, all: objs.length };
}

// Progress counts only the files set to Get.
function stateLabel(st) {
  if (!st.selFiles) return ['', ''];
  if (st.selDone === st.selFiles) return ['done', 'Done'];
  if (st.failed) return ['failed', `${st.failed} failed`];
  if (st.selDone) return ['', `${st.selDone}/${st.selFiles}`];
  return ['', ''];
}

const sizeText = (st) => (st.unsized === st.files ? 'size unknown' : `${fmt(st.bytes)}${st.unsized ? '+' : ''}`);

async function setSkip(objs, skip) {
  const ids = objs.map((o) => o.id);
  if (!ids.length) return;
  await bridge('/skip', { objectIds: ids, skip });
  for (const o of objs) o.skip = skip;
  renderTree();
  refreshStatus();
}

async function reveal(payload) {
  const r = await bridge('/reveal', payload).catch((err) => ({ ok: false, error: err.message }));
  if (!r.ok) {
    $('msg').textContent = `Can't show in Explorer: ${r.error}`;
    $('msg').className = 'msg warn';
  }
}

function makeRow({ level, key, label, objs, expandable, where }) {
  const st = stats(objs);
  const wrap = document.createElement('div');
  wrap.className = `lvl-${level}${st.getN === 0 ? ' skipped' : ''}`;
  const row = document.createElement('div');
  row.className = 'row';

  const twisty = document.createElement('span');
  twisty.className = 'twisty';
  twisty.textContent = expandable ? (expanded.has(key) ? '▾' : '▸') : '';
  if (expandable) {
    twisty.onclick = () => { expanded.has(key) ? expanded.delete(key) : expanded.add(key); renderTree(); };
  }

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.title = 'Checked = Get, unchecked = Skip';
  box.checked = st.getN > 0;
  box.indeterminate = st.getN > 0 && st.getN < st.all;
  box.onchange = () => setSkip(objs, !box.checked);

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = label;
  name.title = label;
  if (expandable) { name.style.cursor = 'pointer'; name.onclick = twisty.onclick; }

  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = `${level < 2 ? `${st.all} model${st.all === 1 ? '' : 's'} · ` : ''}${st.files} file${st.files === 1 ? '' : 's'} · ${sizeText(st)}`;
  if (st.unsized) meta.title = `${st.unsized} file(s) are loose STL/LYS files MMF lists without a size`;

  const [cls, text] = stateLabel(st);
  const state = document.createElement('span');
  state.className = `state ${cls}`;
  state.textContent = text;
  if (text && objs.some((o) => o.doneFiles > 0)) {
    state.classList.add('link');
    state.title = 'Show in Explorer';
    state.onclick = () => reveal(where);
  }

  row.append(twisty, box, name, meta, state);
  wrap.append(row);
  return wrap;
}

// The tree narrowed to the filter: a matching creator or release keeps all
// its models; otherwise only matching models are kept.
function filteredTree() {
  return tree
    .map((c) => {
      const cMatch = matches(c.name);
      const bundles = c.bundles
        .map((b) => ({ ...b, objects: cMatch || matches(b.name) ? b.objects : b.objects.filter((o) => matches(o.name)) }))
        .filter((b) => b.objects.length);
      return { ...c, bundles };
    })
    .filter((c) => c.bundles.length);
}

const visibleObjects = () => filteredTree().flatMap((c) => c.bundles.flatMap((b) => b.objects));

function renderTree() {
  if (historyMode) return; // the History panel owns the summary line
  const root = $('tree');
  root.textContent = '';
  if (!tree.length) {
    root.innerHTML = '<div class="empty">Nothing planned yet.</div>';
    $('selsum').textContent = '';
    return;
  }
  const filtering = Boolean(filter);
  const shown = [];
  for (const { name, bundles } of filteredTree()) {
    const cKey = `c:${name}`;
    const cNode = makeRow({ level: 0, key: cKey, label: name, objs: bundles.flatMap((b) => b.objects), expandable: true, where: { creator: name } });
    root.append(cNode);
    shown.push(...bundles.flatMap((b) => b.objects));
    if (!filtering && !expanded.has(cKey)) continue;
    for (const b of bundles) {
      const bKey = `b:${name}/${b.name}`;
      cNode.append(makeRow({ level: 1, key: bKey, label: b.name, objs: b.objects, expandable: true, where: { creator: name, bundle: b.name } }));
      if (!filtering && !expanded.has(bKey)) continue;
      for (const o of b.objects) cNode.append(makeRow({ level: 2, key: `o:${o.id}`, label: o.name, objs: [o], expandable: false, where: { objectId: o.id } }));
    }
  }
  const st = stats(shown);
  $('selsum').textContent = filtering
    ? `${shown.length} models match · ${st.getN} set to Get`
    : `${st.all} models in ${tree.length} creators · ${st.getN} set to Get · click ▸ to open a creator or release`;
}

async function loadTree() {
  try {
    tree = (await bridge('/tree')).tree;
  } catch {
    tree = [];
  }
  renderTree();
}

// ---------- pin on top ----------

// The bridge finds this window by a one-time title, then the title goes back.
async function setPinned(pinned) {
  const original = document.title;
  const token = `MMF-PIN-${Math.random().toString(36).slice(2, 12).padEnd(10, '0')}`;
  document.title = token;
  let r;
  try {
    r = await bridge('/pin', { title: token, pinned });
  } catch (err) {
    r = { ok: false, error: err.message };
  } finally {
    document.title = original;
  }
  if (!r.ok) {
    $('msg').textContent = `Can't pin the window: ${r.error}`;
    $('msg').className = 'msg warn';
    return;
  }
  $('pin').classList.toggle('on', pinned);
  $('pin').title = pinned ? 'On top: click to unpin' : 'Keep this window on top';
}

$('pin').onclick = () => setPinned(!$('pin').classList.contains('on'));

// ---------- controls ----------

$('start').onclick = async () => { await chrome.runtime.sendMessage({ cmd: 'start' }); refreshStatus(); };
$('pause').onclick = async () => { await chrome.runtime.sendMessage({ cmd: 'pause' }); refreshStatus(); };
$('startBridge').onclick = async () => { await startBridge(); if (!bridgeError) loadTree(); };
$('retry').onclick = async () => { await chrome.runtime.sendMessage({ cmd: 'retryFailed' }); refreshStatus(); loadTree(); };
$('sync').onclick = async () => {
  $('sync').disabled = true;
  $('sync').textContent = 'Syncing...';
  await chrome.runtime.sendMessage({ cmd: 'syncLibrary' });
  $('sync').textContent = 'Sync library';
  refreshStatus();
};
$('search').oninput = (e) => { filter = e.target.value.trim().toLowerCase(); historyMode ? renderHistory() : renderTree(); };
$('getAll').onclick = () => setSkip(visibleObjects(), false);
$('skipAll').onclick = () => setSkip(visibleObjects(), true);
$('expand').onclick = () => {
  const anyOpen = expanded.size > 0;
  expanded.clear();
  if (!anyOpen) for (const c of tree) expanded.add(`c:${c.name}`);
  $('expand').textContent = anyOpen ? 'Expand' : 'Collapse';
  renderTree();
};

// ---------- history ----------


const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const HKIND = {
  done: { icon: '✓', cls: 'done' },
  fail: { icon: '✗', cls: 'fail' },
  retry: { icon: '↻', cls: 'retry' },
  pause: { icon: '⏸', cls: 'pause' },
  start: { icon: '▶', cls: 'run' },
  batch: { icon: '■', cls: 'run' },
};
const HFILTER = {
  all: () => true,
  done: (e) => e.type === 'done',
  problems: (e) => e.type === 'fail' || e.type === 'retry',
  runs: (e) => e.type === 'start' || e.type === 'batch' || e.type === 'pause',
};

function historyLine(e) {
  const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
  if (e.type === 'start') return [`Started downloading ${plural(e.files ?? 0, 'file')}`, e.bytes ? fmt(e.bytes) : ''];
  if (e.type === 'batch') return [`Batch finished: ${plural(e.files ?? 0, 'file')}${e.failed ? `, ${e.failed} failed` : ''}`, e.bytes ? fmt(e.bytes) : ''];
  if (e.type === 'pause') return ['Paused', e.reason ?? ''];
  const where = [e.creator, e.model].filter(Boolean).join(' / ');
  const what = `${esc(e.file ?? '?')}${where ? ` <small>· ${esc(where)}</small>` : ''}`;
  if (e.type === 'done') return [what, e.bytes ? fmt(e.bytes) : '', true];
  return [what, e.type === 'retry' ? `will retry: ${e.reason ?? ''}` : (e.reason ?? 'failed'), true];
}

function renderHistory() {
  const box = $('history');
  const q = filter.toLowerCase();
  const shown = history.filter(HFILTER[$('histFilter').value]).filter((e) => !q
    || [e.file, e.model, e.creator, e.reason].some((v) => v && v.toLowerCase().includes(q)));
  const done = history.filter((e) => e.type === 'done');
  const failed = history.filter((e) => e.type === 'fail').length;
  $('selsum').textContent = history.length
    ? `Last ${history.length.toLocaleString()} events · ${done.length.toLocaleString()} downloaded (${fmt(done.reduce((n, e) => n + (e.bytes ?? 0), 0))})${failed ? ` · ${failed} failed` : ''}${shown.length !== history.length ? ` · ${shown.length.toLocaleString()} shown` : ''}`
    : '';
  if (!shown.length) { box.innerHTML = `<div class="empty">${history.length ? 'Nothing matches.' : 'No history yet.'}</div>`; return; }
  let day = '';
  const html = [];
  for (const [n, e] of shown.entries()) {
    const d = new Date(e.t);
    const dayLabel = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    if (dayLabel !== day) { day = dayLabel; html.push(`<div class="hday">${esc(dayLabel)}</div>`); }
    const k = HKIND[e.type] ?? { icon: '·', cls: '' };
    const [what, meta, isFile] = historyLine(e);
    const link = e.type === 'done' && e.objectId != null;
    html.push(`<div class="hrow ${k.cls}${link ? ' link' : ''}" data-n="${n}">`
      + `<span class="time">${esc(d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}</span>`
      + `<span class="icon">${k.icon}</span>`
      + `<span class="what"${link ? ' title="Show in Explorer"' : ''}>${isFile ? what : esc(what)}</span>`
      + `<span class="meta" title="${esc(meta)}">${esc(meta)}</span></div>`);
  }
  box.innerHTML = html.join('');
  box.querySelectorAll('.hrow.link .what').forEach((el) => {
    const e = shown[Number(el.parentElement.dataset.n)];
    el.onclick = () => reveal({ objectId: e.objectId });
  });
}

async function loadHistory() {
  try { history = (await bridge('/history')).events; } catch { history = []; }
  renderHistory();
}

function setHistoryMode(on) {
  historyMode = on;
  $('historyBtn').classList.toggle('on', on);
  $('historyBtn').textContent = on ? 'Back to library' : 'History';
  for (const id of ['getAll', 'skipAll', 'expand']) $(id).classList.toggle('hidden', on);
  $('histFilter').classList.toggle('hidden', !on);
  $('tree').classList.toggle('hidden', on);
  $('history').classList.toggle('hidden', !on);
  $('search').placeholder = on ? 'Filter history...' : 'Filter creators, releases, models...';
  if (on) loadHistory(); else renderTree();
}
$('historyBtn').onclick = () => setHistoryMode(!historyMode);
$('histFilter').onchange = renderHistory;

// The tree (or history) refreshes every few seconds during a run, otherwise every 30s.
let lastTree = 0;
async function tick() {
  await refreshStatus();
  const { running } = await chrome.storage.local.get({ running: false });
  if (Date.now() - lastTree > (running ? 4000 : 30000)) {
    lastTree = Date.now();
    historyMode ? loadHistory() : loadTree();
  }
}
loadTree();
tick();
setInterval(tick, 2000);
