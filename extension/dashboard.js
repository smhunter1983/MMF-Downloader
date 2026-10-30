// Floating dashboard: progress, controls, and a Creator > Release > Model tree
// where each item can be set to Get or Skip before (or during) downloading.
// 2.0: talks to the engine in the extension's hidden background page.

import * as store from './engine/store.js';

const $ = (id) => document.getElementById(id);
const expanded = new Set(); // "c:<creator>" and "b:<creator>/<bundle>"
let tree = [];
let filter = '';
let historyMode = false;
let newSince = null; // when the latest new models arrived (from Sync)
let newOnly = false;
let history = [];

const fmt = (b) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : b >= 1048576 || !b ? `${(b / 1048576).toFixed(0)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

let engineReady = null;
async function engine(cmd, args) {
  engineReady ??= chrome.runtime.sendMessage({ to: 'background', cmd: 'ensureEngine' });
  await engineReady;
  const r = await chrome.runtime.sendMessage({ to: 'engine', cmd, args });
  if (r === undefined) throw new Error('The engine did not answer');
  return r;
}

// A short message that the 2-second status refresh leaves alone for a while.
let notice = null;
function showNotice(text, warn = false, ms = 8000) {
  notice = { text, warn, until: Date.now() + ms };
  $('msg').textContent = text;
  $('msg').className = warn ? 'msg warn' : 'msg';
}
const showError = (text) => showNotice(text, true, 12000);

// ---------- status header ----------

let lastStatus = null;
let lastPlanSeen = null;

async function refreshStatus() {
  let st = null;
  try { st = await engine('status'); } catch (e) { showError(`Can't reach the engine: ${e.message}. Try reloading the extension.`); return; }
  if (st.ok === false && !st.summary) { showError(st.error); return; }
  lastStatus = st;
  // A finished Sync changes the list: redraw it now rather than at the next poll.
  if (st.lastPlan?.at && st.lastPlan.at !== lastPlanSeen && !st.planning) {
    lastPlanSeen = st.lastPlan.at;
    historyMode ? loadHistory() : loadTree();
    if (!$('settings').classList.contains('hidden')) loadCreators();
  }
  const f = st.folder;
  $('dot').className = `dot ${f.picked && f.permission === 'granted' ? 'ok' : 'bad'}`;
  $('folder').textContent = f.picked ? `📁 ${f.name}` : '📁 Pick folder';
  $('folder').title = f.picked ? `Archive folder: ${f.name} (click to change)` : 'Pick the folder your archive lives in';
  $('folder').classList.toggle('warn', !f.picked || f.permission !== 'granted');
  $('allowFolder').classList.toggle('hidden', !(f.picked && f.permission !== 'granted'));
  $('pause').disabled = !st.running;
  document.documentElement.style.setProperty('--header-h', `${$('header').offsetHeight}px`);
  if (!$('settings').contains(document.activeElement)) fillSettings(st.settings);

  const sum = st.summary;
  const folderOk = f.picked && f.permission === 'granted';
  $('start').disabled = st.running || !!st.planning || !folderOk || (!st.batch && !st.upcoming.files);
  $('sync').disabled = st.running || !!st.planning || !folderOk;
  $('sync').textContent = st.planning ? 'Syncing...' : 'Sync library';
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

  const clock = (ms) => { const secs = Math.ceil(ms / 1000); return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`; };
  const at = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  let text = st.paused ? `Paused: ${st.pauseReason}` : st.message;
  let warn = st.paused;
  const holding = st.running && st.hold && Date.parse(st.hold.until) > Date.now() && !st.current;
  const waitingForCap = st.running && !holding && st.rate.waitMs > 0 && !st.current;
  if (holding) {
    const until = Date.parse(st.hold.until);
    text = `${st.hold.reason}. Retrying by itself in ${clock(until - Date.now())}, at ${at(until)}. If it's refused again, the run pauses.`;
    warn = true;
  } else if (waitingForCap) {
    text = `Hourly limit reached (${st.rate.cap} downloads). Resumes by itself in ${clock(st.rate.waitMs)}, at ${at(Date.now() + st.rate.waitMs)}. You can close this window; keep Chrome open.`;
    warn = true;
  }
  const waiting = sum.pending + sum.active;
  if (!st.paused && !st.running && waiting) text = `Ready: ${waiting.toLocaleString()} file${waiting === 1 ? '' : 's'} to download. Press Start.`;
  if (st.current && st.running) {
    const of = st.current.size ? ` of ${fmt(st.current.size)}` : '';
    text = `Downloading ${st.current.label} (${fmt(st.current.bytes)}${of}). You can close this window; keep Chrome open.`;
  }
  if (!st.batch && !st.upcoming.files && !st.paused && !st.running && st.lastBatch) {
    const lb = st.lastBatch;
    text = `Last batch done ✓ ${lb.files.toLocaleString()} file${lb.files === 1 ? '' : 's'}, ${fmt(lb.bytes)} (finished ${at(lb.finishedAt)})${lb.failed ? `, ${lb.failed} failed` : ''}. Check more models to start another.`;
  }
  const planNewer = st.lastPlan && (!st.lastBatch || Date.parse(st.lastPlan.at) > Date.parse(st.lastBatch.finishedAt));
  if (planNewer && !st.planning && !st.running && Date.now() - Date.parse(st.lastPlan.at) < 10 * 60 * 1000) {
    const lp = st.lastPlan;
    if (!lp.ok) { text = `Sync failed: ${lp.error}`; warn = true; }
    else if (!st.batch) {
      text = `Library synced: ${lp.models.toLocaleString()} models${lp.newModels ? `, ${lp.newModels} new` : ''}. `
        + (lp.pending ? `${lp.pending.toLocaleString()} file${lp.pending === 1 ? '' : 's'} ready to download (new models are checked).` : 'Nothing new to download.')
        + (lp.errors ? ` ${lp.errors} model${lp.errors === 1 ? '' : 's'} couldn't be read this time (sync again later).` : '');
    }
  }
  if (!sum.total && !sum.skipped && !st.planning) text = f.picked ? 'No download list yet: click "Sync library".' : 'Start by picking your archive folder (📁), then click "Sync library".';
  if (f.picked && f.permission !== 'granted') { text = 'Chrome needs your OK to use the archive folder again. Click "Allow folder" and choose "Allow on every visit".'; warn = true; }
  if (st.planning) text = `Updating the download list: ${st.planning.line}`;
  if (notice && Date.now() < notice.until) return; // keep the notice up
  notice = null;
  $('msg').textContent = text;
  $('msg').className = warn || holding || waitingForCap ? 'msg warn' : 'msg';
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
  let files = 0, bytes = 0, unsized = 0, getN = 0, selFiles = 0, selDone = 0, failed = 0, doneAll = 0, newN = 0;
  for (const o of objs) {
    files += o.files; bytes += o.bytes; unsized += o.unsized ?? 0; doneAll += o.doneFiles;
    if (o.isNew) newN++;
    if (!o.skip) { getN++; selFiles += o.files; selDone += o.doneFiles; failed += o.failed; }
  }
  return { files, bytes, unsized, getN, selFiles, selDone, failed, doneAll, newN, all: objs.length };
}

// Last column: ✓ = everything here is already in your archive (whether or not
// it's checked now); n/m = partly downloaded; blank = never downloaded.
function stateLabel(st) {
  if (st.files && st.doneAll === st.files) return ['done', '✓'];
  if (st.failed) return ['failed', `${st.failed} failed`];
  if (st.doneAll) return ['', `${st.doneAll}/${st.files}`];
  return ['', ''];
}

const sizeText = (st) => (st.unsized === st.files ? 'size unknown' : `${fmt(st.bytes)}${st.unsized ? '+' : ''}`);

async function setSkip(objs, skip) {
  const ids = objs.map((o) => o.id);
  if (!ids.length) return;
  const r = await engine('setSkip', { objectIds: ids, skip });
  if (r.ok === false) { showError(r.error); return; }
  for (const o of objs) o.skip = skip;
  renderTree();
  refreshStatus();
}

// An extension can't open Explorer, so: copy where it is (inside your folder).
async function reveal(where) {
  const r = await engine('locate', where).catch((e) => ({ ok: false, error: e.message }));
  if (!r.ok) { showError(r.error); return; }
  const base = (lastStatus?.settings?.archivePath ?? '').trim().replace(/[\\/]+$/, '');
  const rel = [base || (lastStatus?.folder?.name ?? 'archive'), ...r.parts].join('\\');
  await navigator.clipboard.writeText(rel).catch(() => {});
  showNotice(base
    ? `Copied: ${rel}${r.packed ? '  (inside this combined zip)' : ''}. Paste it into Explorer's address bar. (Chrome extensions can't open Explorer themselves.)`
    : `Copied: ${rel}${r.packed ? '  (inside this combined zip)' : ''}. Tip: put your folder's full path in ⚙ and copied locations open straight from Explorer's address bar.`, false, 12000);
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
  if (st.newN) {
    const badge = document.createElement('span');
    badge.className = 'new';
    badge.textContent = level === 2 ? 'NEW' : `${st.newN} new`;
    badge.title = `New in your library since ${new Date(newSince).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}, not downloaded yet`;
    name.append(' ', badge);
  }
  if (expandable) { name.style.cursor = 'pointer'; name.onclick = twisty.onclick; }

  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = `${level < 2 ? `${st.all} model${st.all === 1 ? '' : 's'} · ` : ''}${st.files} file${st.files === 1 ? '' : 's'} · ${sizeText(st)}`;
  if (st.unsized) meta.title = `${st.unsized} file(s) are loose STL/LYS files MMF lists without a size`;

  const [cls, text] = stateLabel(st);
  const state = document.createElement('span');
  state.className = `state ${cls}`;
  state.textContent = text;
  if (text === '✓') state.title = 'Already downloaded';
  if (text && objs.some((o) => o.doneFiles > 0)) {
    state.classList.add('link');
    state.title = `${text === '✓' ? 'Already downloaded. ' : ''}Click to copy where it is`;
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
        .map((b) => (newOnly ? { ...b, objects: b.objects.filter((o) => o.isNew) } : b))
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
  const newAll = tree.flatMap(objectsOf).filter((o) => o.isNew).length;
  $('newOnly').classList.toggle('hidden', !newAll);
  $('newOnly').textContent = newOnly ? 'Show all' : `New (${newAll})`;
  $('newOnly').classList.toggle('on', newOnly);
  if (!shown.length) root.innerHTML = '<div class="empty">Nothing matches.</div>';
  $('selsum').textContent = filtering || newOnly
    ? `${shown.length} models ${newOnly ? 'new' : 'match'} · ${st.getN} set to Get`
    : `${st.all} models in ${tree.length} creators · ${st.getN} set to Get${newAll ? ` · ${newAll} new` : ''} · ✓ = already downloaded`;
}

async function loadTree() {
  try {
    const r = await engine('tree');
    tree = r.tree;
    newSince = r.newSince ?? null;
  } catch {
    tree = [];
  }
  renderTree();
}

// ---------- controls ----------

async function act(cmd, args) {
  const r = await engine(cmd, args).catch((e) => ({ ok: false, error: e.message }));
  if (r?.ok === false) showError(r.error);
  await refreshStatus();
  return r;
}
$('start').onclick = () => act('start');
$('pause').onclick = () => act('pause');
$('retry').onclick = async () => { await act('retryFailed'); loadTree(); };
$('sync').onclick = async () => { $('sync').disabled = true; await act('sync'); };
$('sync').title = 'Fetch your MMF library and add anything new to the download list';

// ---------- archive folder ----------

$('folder').onclick = async () => {
  try {
    const handle = await showDirectoryPicker({ id: 'mmf-archive', mode: 'readwrite' });
    await store.set('dir', handle);
    await engine('folderChanged');
  } catch (e) {
    if (e.name !== 'AbortError') showError(`Couldn't use that folder: ${e.message}`);
  }
  refreshStatus();
};
$('allowFolder').onclick = async () => {
  const handle = await store.get('dir');
  if (handle) await handle.requestPermission({ mode: 'readwrite' }).catch(() => {});
  await engine('folderChanged');
  refreshStatus();
};

// ---------- settings ----------

const RISKY_CAP = 150; // community reports: MMF starts refusing / flagging above this
const showCapWarning = () => $('capWarn').classList.toggle('hidden', !(Number($('setCap').value) > RISKY_CAP));
$('setCap').oninput = showCapWarning;

function fillSettings(st) {
  if (!st) return;
  $('setCap').value = st.maxDownloadsPerHour;
  showCapWarning();
  $('setRetry').value = st.forbiddenRetryMinutes;
  $('setPath').value = st.archivePath ?? '';
}

// Checklist of every creator in your MMF library; ticked = left out.
async function loadCreators() {
  const r = await engine('creators').catch(() => ({ creators: [] }));
  const list = r.creators ?? [];
  const esc2 = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  $('creatorList').innerHTML = list.length
    ? list.map((c, n) => `<label title="${esc2(c.name)}"><input type="checkbox" data-n="${n}"${c.skipped ? ' checked' : ''}> ${esc2(c.name)} ${c.models != null ? `<small>${c.models}</small>` : ''}</label>`).join('')
    : '<div class="creatorhint">Click "Sync library" once to list your creators.</div>';
  $('creatorList').dataset.names = JSON.stringify(list.map((c) => c.name));
  const n = list.filter((c) => c.skipped).length;
  $('excludeCount').textContent = n ? `(${n} skipped)` : '';
}
const checkedCreators = () => {
  const names = JSON.parse($('creatorList').dataset.names ?? '[]');
  return [...$('creatorList').querySelectorAll('input:checked')].map((b) => names[Number(b.dataset.n)]);
};

$('settingsBtn').onclick = () => {
  $('settings').classList.toggle('hidden');
  if (!$('settings').classList.contains('hidden')) loadCreators();
  $('settingsBtn').classList.toggle('on', !$('settings').classList.contains('hidden'));
  document.documentElement.style.setProperty('--header-h', `${$('header').offsetHeight}px`);
};
// Settings save as soon as they change.
async function saveSettingsNow() {
  const cap = Math.max(1, Math.min(1000, Number($('setCap').value) || 120));
  const retry = Math.max(5, Math.min(120, Number($('setRetry').value) || 10)); // under 5 min just gets refused again
  const exclude = checkedCreators();
  await act('saveSettings', { maxDownloadsPerHour: cap, forbiddenRetryMinutes: retry, excludeCreators: exclude, archivePath: $('setPath').value.trim() });
  $('setCap').value = cap;
  $('setRetry').value = retry;
  const n = exclude.length;
  $('excludeCount').textContent = n ? `(${n} skipped)` : '';
  showNotice(`Saved.${n ? ` Skipping ${n} creator${n === 1 ? '' : 's'} from the next Sync.` : ''}${cap > RISKY_CAP ? ` Heads up: ${cap}/hour is above the ~${RISKY_CAP} where MMF has been reported to push back.` : ''}`, cap > RISKY_CAP, 5000);
}
$('setCap').onchange = saveSettingsNow;
$('setRetry').onchange = saveSettingsNow;
$('setPath').onchange = saveSettingsNow;
$('creatorList').onchange = saveSettingsNow;


$('search').oninput = (e) => { filter = e.target.value.trim().toLowerCase(); historyMode ? renderHistory() : renderTree(); };
$('getAll').onclick = () => setSkip(visibleObjects(), false);
$('skipAll').onclick = () => setSkip(visibleObjects(), true);
$('newOnly').onclick = () => {
  newOnly = !newOnly;
  if (newOnly) for (const c of filteredTree()) { expanded.add(`c:${c.name}`); for (const b of c.bundles) expanded.add(`b:${c.name}/${b.name}`); }
  renderTree();
};
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
  hold: { icon: '⏳', cls: 'pause' },
  start: { icon: '▶', cls: 'run' },
  batch: { icon: '■', cls: 'run' },
};
const HFILTER = {
  all: () => true,
  done: (e) => e.type === 'done',
  problems: (e) => e.type === 'fail' || e.type === 'retry',
  runs: (e) => e.type === 'start' || e.type === 'batch' || e.type === 'pause' || e.type === 'hold',
};

function historyLine(e) {
  const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
  if (e.type === 'start') return [`Started downloading ${plural(e.files ?? 0, 'file')}`, e.bytes ? fmt(e.bytes) : ''];
  if (e.type === 'batch') return [`Batch finished: ${plural(e.files ?? 0, 'file')}${e.failed ? `, ${e.failed} failed` : ''}`, e.bytes ? fmt(e.bytes) : ''];
  if (e.type === 'pause') return ['Paused', e.reason ?? ''];
  if (e.type === 'hold') return [`${e.reason ?? 'MMF refused a download'}: retrying by itself`, e.until ? `at ${new Date(e.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''];
  const where = [
    e.creator ? `<span class="creator" title="Show only ${esc(e.creator)}">${esc(e.creator)}</span>` : '',
    e.model ? esc(e.model) : '',
  ].filter(Boolean).join(' / ');
  const what = `${esc(e.file ?? '?')}${where ? ` <small>· ${where}</small>` : ''}`;
  if (e.type === 'done') return [what, e.bytes ? fmt(e.bytes) : '', true];
  return [what, e.type === 'retry' ? `will retry: ${e.reason ?? ''}` : (e.reason ?? 'failed'), true];
}

function renderHistory() {
  const box = $('history');
  const q = filter.toLowerCase();
  const creator = $('histCreator').value;
  // Totals cover the chosen creator (or everyone); type and search narrow the rows.
  const scope = creator ? history.filter((e) => e.creator === creator) : history;
  const shown = scope.filter(HFILTER[$('histFilter').value]).filter((e) => !q
    || [e.file, e.model, e.creator, e.reason].some((v) => v && v.toLowerCase().includes(q)));
  const done = scope.filter((e) => e.type === 'done');
  const failed = scope.filter((e) => e.type === 'fail').length;
  $('selsum').textContent = scope.length
    ? `${creator ? `${creator}: ` : ''}${done.length.toLocaleString()} downloaded (${fmt(done.reduce((n, e) => n + (e.bytes ?? 0), 0))})${failed ? ` · ${failed} failed` : ''} · ${scope.length.toLocaleString()} events${shown.length !== scope.length ? ` · ${shown.length.toLocaleString()} shown` : ''}`
    : '';
  const MAX_ROWS = 1000; // drawing more makes the window sluggish; filter to narrow
  const extra = shown.length - MAX_ROWS;
  if (extra > 0) shown.length = MAX_ROWS;
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
      + `<span class="what"${link ? ' title="Click to copy where it is"' : ''}>${isFile ? what : esc(what)}</span>`
      + `<span class="meta" title="${esc(meta)}">${esc(meta)}</span></div>`);
  }
  if (extra > 0) html.push(`<div class="empty">${extra.toLocaleString()} older entries not shown. Pick a creator or type a filter to narrow it down.</div>`);
  box.innerHTML = html.join('');
  box.querySelectorAll('.hrow.link .what').forEach((el) => {
    const e = shown[Number(el.parentElement.dataset.n)];
    el.onclick = () => reveal({ objectId: e.objectId });
  });
  box.querySelectorAll('.hrow .creator').forEach((el) => {
    el.onclick = (ev) => {
      ev.stopPropagation(); // not "copy location"
      $('histCreator').value = el.textContent;
      renderHistory();
    };
  });
}

// Creator dropdown: everyone who appears in the history, keeping the choice.
function fillCreators() {
  const sel = $('histCreator');
  const keep = sel.value;
  const names = [...new Set(history.map((e) => e.creator).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (keep && !names.includes(keep)) names.unshift(keep);
  sel.innerHTML = '<option value="">All creators</option>' + names.map((n) => `<option>${esc(n)}</option>`).join('');
  sel.value = keep;
}

async function loadHistory() {
  try { history = (await engine('history')).events ?? []; } catch { history = []; }
  fillCreators();
  renderHistory();
}

function setHistoryMode(on) {
  historyMode = on;
  $('historyBtn').classList.toggle('on', on);
  $('historyBtn').textContent = on ? 'Back to library' : 'History';
  for (const id of ['getAll', 'skipAll', 'expand']) $(id).classList.toggle('hidden', on);
  if (on) $('newOnly').classList.add('hidden');
  $('histFilter').classList.toggle('hidden', !on);
  $('histCreator').classList.toggle('hidden', !on);
  $('tree').classList.toggle('hidden', on);
  $('history').classList.toggle('hidden', !on);
  $('search').placeholder = on ? 'Filter history...' : 'Filter creators, releases, models...';
  if (on) loadHistory(); else renderTree();
}
$('historyBtn').onclick = () => setHistoryMode(!historyMode);
$('histFilter').onchange = renderHistory;
$('histCreator').onchange = renderHistory;

// The tree (or history) refreshes every few seconds during a run, otherwise every 30s.
let lastTree = 0;
async function tick() {
  await refreshStatus();
  const running = lastStatus?.running || lastStatus?.planning;
  if (Date.now() - lastTree > (running ? 4000 : 30000)) {
    lastTree = Date.now();
    historyMode ? loadHistory() : loadTree();
  }
}
// The engine says when something changed; polling covers the rest.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'engine-changed') refreshStatus();
});

loadTree();
tick();
setInterval(tick, 2000);
