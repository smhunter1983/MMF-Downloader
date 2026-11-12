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
let hiddenOnly = false; // showing only the models hidden with "Don't want"
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

// ---------- wording for this computer ----------
// The words are the same everywhere ("your file browser"); only the look of a path differs.

const PLATFORM = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase();
const OS = PLATFORM.includes('win')
  ? { sep: '\\', archiveExample: 'Z:\\Downloads\\…\\MMF', pdfExample: 'C:\\Users\\…\\Custom Stats' }
  : PLATFORM.includes('mac')
    ? { sep: '/', archiveExample: '/Users/…/MMF', pdfExample: '/Users/…/Custom Stats' }
    : { sep: '/', archiveExample: '/home/…/MMF', pdfExample: '/home/…/Custom Stats' };
// A path is joined the way it was written; with no path to go by, the way this computer writes them.
const sepOf = (path) => (path.includes('\\') ? '\\' : path.includes('/') ? '/' : OS.sep);

$('setPath').placeholder = `e.g. ${OS.archiveExample}`;
$('setPdfPath').placeholder = `e.g. ${OS.pdfExample}`;

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
  // In ⚙ the same pick is named for what it really does: it is how Chrome grants access to a folder.
  rowState($('pathState'), f, st.settings?.archivePath);
  const pf = st.pdfFolder ?? { picked: false };
  const pdfBlocked = pf.picked && pf.permission !== 'granted';
  $('allowFolder').classList.toggle('hidden', !((f.picked && f.permission !== 'granted') || pdfBlocked));
  rowState($('pdfState'), pf, st.settings?.pdfPath);
  // Clear is live only when there is something to clear.
  $('pathClear').disabled = $('setPath').value.trim() === '' && (st.settings?.archivePath ?? '') === '';
  $('pdfOff').disabled = !pf.picked && $('setPdfPath').value.trim() === '' && (st.settings?.pdfPath ?? '') === '';
  $('pdfLabel').title = $('setPdfPath').title = pf.picked
    ? `Each PDF you download from now on is also copied to ${pdfBasePath(st)}${sepOf(pdfBasePath(st))}<Creator>${sepOf(pdfBasePath(st))} under the creator's file name. The archive keeps its copy. Nothing in ${pf.name} is ever overwritten.`
    : 'Optional. Pick a folder and each PDF you download from then on is also copied there, under <Creator>. PDFs always stay in the archive too.';
  const pdfWaiting = pf.picked ? (st.pdfCopiesWaiting ?? 0) : 0;
  // A typed path should end in the folder that was picked, or copied locations point at the wrong place.
  const notes = [
    pathMismatch('Path of archive folder', st.settings?.archivePath, f.picked ? f.name : null),
    pathMismatch('Path for PDFs discovered', st.settings?.pdfPath, pf.picked ? pf.name : null),
    creatorPicked('PDFs', pf.picked ? pf.name : null),
    creatorPicked('the archive', f.picked ? f.name : null),
    pdfWaiting ? `${pdfWaiting} PDF${pdfWaiting === 1 ? '' : 's'} waiting to be copied to ${pf.name}: it happens at the next Start.` : null,
  ].filter(Boolean);
  $('pdfHint').classList.toggle('hidden', notes.length === 0);
  $('pdfHint').textContent = notes.join(' ');
  // A pasted path that Chrome hasn't been shown yet: say what happens next, and wait for the click.
  const todo = [
    { key: 'dir', label: 'archive', button: 'Select and Confirm Archive Location', info: f, typed: st.settings?.archivePath },
    { key: 'pdfDir', label: 'PDF', button: 'Select and Confirm PDF Location', info: pf, typed: st.settings?.pdfPath },
  ].find((r) => lastPart(r.typed) !== '' && !(r.info.picked && r.info.name.toLowerCase() === lastPart(r.typed).toLowerCase()));
  $('confirmRow').classList.toggle('hidden', !todo);
  if (todo) {
    const name = lastPart(todo.typed);
    $('confirmText').textContent = todo.info.picked
      ? `If the path is right and the folder is wrong, select the "${name}" folder for Chrome:`
      : `One more step for the ${todo.label} folder: Chrome has to be shown it before files can be saved there. Click the button, then in Chrome's window (Chrome titles it "Select where this site can save changes") find the "${name}" folder and press Select Folder.`;
    $('confirmBtn').textContent = todo.button;
    $('confirmBtn').dataset.key = todo.key;
  }
  $('pause').disabled = !st.running;
  document.documentElement.style.setProperty('--header-h', `${$('header').offsetHeight}px`);
  if (!$('settings').contains(document.activeElement)) fillSettings(st.settings);
  const bustsOn = st.settings?.skipBusts === true;
  $('bustRow').classList.toggle('on', bustsOn);
  $('statueRow').classList.toggle('on', st.settings?.skipStatues === true);

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
  const hiddenN = st.hiddenModels ?? 0;
  $('hiddenOnly').classList.toggle('hidden', historyMode || (!hiddenN && !hiddenOnly));
  $('hiddenOnly').textContent = hiddenOnly ? 'Show all' : `Hidden (${hiddenN})`;
  $('hiddenOnly').classList.toggle('on', hiddenOnly);
  $('retry').classList.toggle('hidden', !sum.failed);
  $('clearFailed').classList.toggle('hidden', !sum.failed);

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
  if (pdfBlocked) { text = 'Chrome needs your OK to use the PDF folder again. Click "Allow folder" and choose "Allow on every visit". Downloads carry on meanwhile; PDFs are copied once it is allowed.'; warn = true; }
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
  let files = 0, bytes = 0, unsized = 0, getN = 0, selFiles = 0, selDone = 0, failed = 0, doneAll = 0, newN = 0, bustsOut = 0, statuesOut = 0;
  for (const o of objs) {
    files += o.files; bytes += o.bytes; unsized += o.unsized ?? 0; doneAll += o.doneFiles; bustsOut += o.bustsOut ?? 0; statuesOut += o.statuesOut ?? 0;
    if (o.isNew) newN++;
    if (!o.skip) { getN++; selFiles += o.files; selDone += o.doneFiles; failed += o.failed; }
  }
  return { files, bytes, unsized, getN, selFiles, selDone, failed, doneAll, newN, bustsOut, statuesOut, ruleOut: bustsOut + statuesOut, all: objs.length };
}

// Last column: ✓ = everything here is already in your archive (whether or not
// it's checked now); n/m = partly downloaded; blank = never downloaded.
function stateLabel(st) {
  if (st.files && st.doneAll === st.files) return ['done', '✓'];
  if (st.failed) return ['failed', `${st.failed} failed`];
  // Everything is here except busts or statues, and a Skip setting is why: the count turns orange.
  if (st.ruleOut && st.doneAll && st.doneAll === st.files - st.ruleOut) return ['nobust', `${st.doneAll}/${st.files}`];
  if (st.doneAll) return ['', `${st.doneAll}/${st.files}`];
  return ['', ''];
}
// Why a count is short, in words.
function skipTip(st) {
  if (!st.ruleOut) return '';
  const kinds = [];
  if (st.bustsOut) kinds.push(`${st.bustsOut} bust${st.bustsOut === 1 ? '' : 's'}`);
  if (st.statuesOut) kinds.push(`${st.statuesOut} statue${st.statuesOut === 1 ? '' : 's'}`);
  const left = `${kinds.join(' and ')} left out per Settings.`;
  const other = st.files - st.doneAll - st.ruleOut;
  return other > 0 ? `${left} ${other} other file${other === 1 ? '' : 's'} not downloaded yet.` : `Complete. ${left}`;
}
// The legend's note about orange counts, while a Skip setting is on.
// "busts" and "statues" are written in the same orange as the settings and the counts.
function skipLegend(settings) {
  const on = [settings?.skipBusts && 'busts', settings?.skipStatues && 'statues'].filter(Boolean);
  if (!on.length) return [];
  const parts = [' · orange count = complete except '];
  on.forEach((word, n) => {
    if (n) parts.push(' and ');
    const mark = document.createElement('span');
    mark.className = 'skipword';
    mark.textContent = word;
    parts.push(mark);
  });
  return parts;
}

const sizeText = (st) => (st.unsized === st.files ? 'size unknown' : `${fmt(st.bytes)}${st.unsized ? '+' : ''}`);

// "Don't want" hides whole models from the list and its counts; "Restore" brings them back, badged NEW.
async function setHidden(objs, hidden, label) {
  const ids = objs.map((o) => o.id);
  if (!ids.length) return;
  const r = await engine('setHidden', { objectIds: ids, hidden });
  if (r.ok === false) { showError(r.error); return; }
  const n = ids.length;
  showNotice(hidden
    ? `Hidden: ${label}${n > 1 ? ` (${n} models)` : ''}. Find it again under "Hidden (${r.hiddenModels})".`
    : `Restored: ${label}${n > 1 ? ` (${n} models)` : ''}. It's back in the list, badged NEW.`, false, 8000);
  if (!hidden && !r.hiddenModels) hiddenOnly = false;
  await refreshStatus();
  loadTree();
}

async function setSkip(objs, skip) {
  const ids = objs.map((o) => o.id);
  if (!ids.length) return;
  const r = await engine('setSkip', { objectIds: ids, skip });
  if (r.ok === false) { showError(r.error); return; }
  for (const o of objs) o.skip = skip;
  renderTree();
  refreshStatus();
}

// The mark beside a path: ✓ when the path and the folder Chrome was shown agree, ⚠ when something is missing.
const lastPart = (path) => (path ?? '').trim().split(/[\\/]+/).filter(Boolean).at(-1) ?? '';
function rowState(el, info, typed) {
  const last = lastPart(typed);
  const allowed = info.picked && info.permission === 'granted';
  const good = allowed && last !== '' && last.toLowerCase() === info.name.toLowerCase();
  const bad = last !== '' ? !good : (info.picked && !allowed);
  el.textContent = good ? '✓' : bad ? '⚠' : '';
  el.className = `pathstate${bad ? ' warn' : ''}`;
  el.title = good ? `Set: Chrome can save to "${info.name}".` : bad ? 'Needs attention: see the note below.' : '';
}

// What the clipboard holds, if it is a folder path (Windows "Copy as path" adds quotes).
function cleanPath(text) {
  const t = String(text ?? '').trim().replace(/^"(.*)"$/, '$1').trim().replace(/[\\/]+$/, '');
  const looksLikePath = /^([A-Za-z]:|\\\\[^\\]|\/)/.test(t);
  return looksLikePath && !/[\r\n<>|?*"]/.test(t) && t.length < 1000 ? t : null;
}

// Chrome never tells an extension where a picked folder is, so the typed path can't be checked
// fully: only that it ends in the picked folder's name.
function pathMismatch(label, typed, pickedName) {
  const parts = (typed ?? '').trim().split(/[\\/]+/).filter(Boolean);
  if (!parts.length || !pickedName || parts.at(-1).toLowerCase() === pickedName.toLowerCase()) return null;
  return `${label} ends in "${parts.at(-1)}", but the folder you confirmed in Chrome is "${pickedName}". Copied locations will be wrong unless the path is that folder's own, ending in ${sepOf(typed)}${pickedName}.`;
}

// Picking a creator's own folder is an easy slip in the folder dialog: files would land one level too deep.
function creatorPicked(what, pickedName) {
  if (!pickedName || !tree.some((c) => c.name.toLowerCase() === pickedName.toLowerCase())) return null;
  return `The folder picked for ${what} is "${pickedName}", which is one of your creators. Files go into a folder per creator, so they would land in ${pickedName}${OS.sep}${pickedName}${OS.sep}. Paste the path of the folder that holds your creator folders instead.`;
}

// The PDF folder as typed in ⚙ (Chrome doesn't reveal folder paths), or just its name.
const pdfBasePath = (st) => (st?.settings?.pdfPath ?? '').trim().replace(/[\\/]+$/, '') || (st?.pdfFolder?.name ?? 'PDF folder');

// Copy where a PDF sits in the PDF folder.
async function revealPdf(parts) {
  const typed = (lastStatus?.settings?.pdfPath ?? '').trim();
  const full = [pdfBasePath(lastStatus), ...parts].join(sepOf(pdfBasePath(lastStatus)));
  await navigator.clipboard.writeText(full).catch(() => {});
  showNotice(typed
    ? `Copied: ${full}. Paste it into your file browser to go there. (Chrome extensions can't open folders themselves.)`
    : `Copied: ${full}. Tip: paste the PDF folder's path in ⚙ (Path for PDFs discovered) and copied locations can be pasted straight into your file browser.`, false, 12000);
}

// An extension can't open a file browser, so: copy where it is (inside your folder).
async function reveal(where) {
  const r = await engine('locate', where).catch((e) => ({ ok: false, error: e.message }));
  if (!r.ok) { showError(r.error); return; }
  const base = (lastStatus?.settings?.archivePath ?? '').trim().replace(/[\\/]+$/, '');
  const rel = [base || (lastStatus?.folder?.name ?? 'archive'), ...r.parts].join(sepOf(base));
  await navigator.clipboard.writeText(rel).catch(() => {});
  showNotice(base
    ? `Copied: ${rel}${r.packed ? '  (inside this combined zip)' : ''}. Paste it into your file browser to go there. (Chrome extensions can't open folders themselves.)`
    : `Copied: ${rel}${r.packed ? '  (inside this combined zip)' : ''}. Tip: paste your archive folder's path in ⚙ (Path of archive folder) and copied locations can be pasted straight into your file browser.`, false, 12000);
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
  const tip = text === '✓' ? '' : skipTip(st);
  if (tip) state.title = state.title ? `${tip} ${state.title}.` : tip;

  const hide = document.createElement('button');
  hide.className = 'hidebtn';
  hide.type = 'button';
  hide.textContent = hiddenOnly ? 'Restore' : "Don't want";
  hide.title = hiddenOnly
    ? 'Put this back in the list, badged NEW'
    : `Hide ${level === 2 ? 'this model' : `everything in this ${level === 0 ? 'creator' : 'release'}`}: out of the list, the counts and New. It is never downloaded. Bring it back from "Hidden".`;
  hide.onclick = () => setHidden(objs, !hiddenOnly, label);

  row.append(twisty, box, name, meta, hide, state);
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
    root.innerHTML = `<div class="empty">${hiddenOnly ? 'No hidden models.' : 'Nothing planned yet.'}</div>`;
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
  $('newOnly').classList.toggle('hidden', !newAll || hiddenOnly);
  $('newOnly').textContent = newOnly ? 'Show all' : `New (${newAll})`;
  $('newOnly').classList.toggle('on', newOnly);
  if (!shown.length) root.innerHTML = '<div class="empty">Nothing matches.</div>';
  $('selsum').textContent = hiddenOnly
    ? `${shown.length} hidden model${shown.length === 1 ? '' : 's'}: not in the list, the counts or New, and never downloaded · point at one and click "Restore" to bring it back`
    : filtering || newOnly
    ? `${shown.length} models ${newOnly ? 'new' : 'match'} · ${st.getN} set to Get`
    : `${st.all} models in ${tree.length} creators · ${st.getN} set to Get${newAll ? ` · ${newAll} new` : ''} · ✓ = already downloaded`;
  if (!(filtering || newOnly || hiddenOnly)) $('selsum').append(...skipLegend(lastStatus?.settings));
}

async function loadTree() {
  try {
    const r = await engine('tree', { hidden: hiddenOnly });
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
$('clearFailed').onclick = async () => {
  const r = await act('clearFailed');
  if (r?.cleared) showNotice(`Cleared ${r.cleared} failed file${r.cleared === 1 ? '' : 's'}: now unchecked. Tick the model again to get ${r.cleared === 1 ? 'it' : 'them'} later.`, false, 8000);
  loadTree();
};
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
  // Chrome asks about one folder per click.
  for (const key of ['dir', 'pdfDir']) {
    const handle = await store.get(key);
    if (handle && (await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      await handle.requestPermission({ mode: 'readwrite' }).catch(() => {});
      break;
    }
  }
  await engine('folderChanged');
  refreshStatus();
};

// ---------- PDF folder (optional) ----------

// One button per folder row pastes the path you copied. Chrome only lets an extension save into a
// folder picked in its own window, so a note then asks for that pick: it never opens unasked.
const ROWS = {
  dir: { box: 'setPath', what: 'archive' },
  pdfDir: { box: 'setPdfPath', what: 'PDF' },
};

async function pastePath(key) {
  const row = ROWS[key];
  let path = null;
  try { path = cleanPath(await navigator.clipboard.readText()); } catch { /* Chrome said no: fall back to the box */ }
  path ??= cleanPath($(row.box).value);
  if (!path) {
    showError('There is no folder path to paste. Copy the folder\'s path in your file browser first, then click "Paste path" again.');
    return;
  }
  $(row.box).value = path;
  await saveSettingsNow();
  await pathSaved(key, path);
  refreshStatus();
}

// After a path is saved: if Chrome already knows this folder, make sure it is still allowed.
// If it doesn't, the note under the rows asks for the one click that shows it to Chrome.
async function pathSaved(key, path) {
  const have = await store.get(key);
  if (!have || have.name.toLowerCase() !== lastPart(path).toLowerCase()) {
    showNotice('Path saved. One more step: see the note under the paths.', false, 8000);
    return;
  }
  try {
    if ((await have.queryPermission({ mode: 'readwrite' })) !== 'granted') await have.requestPermission({ mode: 'readwrite' });
    await engine('folderChanged');
    showNotice(`Set: the ${ROWS[key].what} folder is ${path}`, false, 8000);
  } catch { /* the "Allow folder" button in the header covers this */ }
}

// The one step Chrome won't let the downloader skip: you pick the folder in Chrome's own window.
// It always opens at the Desktop, not wherever a folder was last picked.
async function pickFolder(key) {
  const row = ROWS[key];
  const path = cleanPath($(row.box).value) ?? '';
  const name = lastPart(path);
  try {
    const handle = await showDirectoryPicker({ mode: 'readwrite', startIn: 'desktop' });
    const other = await store.get(key === 'dir' ? 'pdfDir' : 'dir');
    if (other && await other.isSameEntry(handle)) { showError('The archive and the PDF folder have to be different folders. Nothing changed.'); return; }
    await store.set(key, handle);
    await engine('folderChanged');
    if (handle.name.toLowerCase() === name.toLowerCase()) showNotice(`Set: the ${row.what} folder is ${path}`, false, 8000);
    else showNotice(`You picked "${handle.name}", but the path ends in "${name}". See the note under the paths.`, true, 8000);
  } catch (e) {
    if (e.name === 'AbortError') showNotice('No folder was picked in Chrome\'s window, so nothing changed.', true, 6000);
    else showError(`Couldn't use that folder: ${e.message}`);
  }
  refreshStatus();
}

$('confirmBtn').onclick = () => pickFolder($('confirmBtn').dataset.key);
$('pathPaste').onclick = () => pastePath('dir');
$('pdfPaste').onclick = () => pastePath('pdfDir');
// Typed or Ctrl+V'd straight into a box: saved the same way, once you leave the box.
for (const [key, row] of Object.entries(ROWS)) {
  $(row.box).onchange = async () => {
    await saveSettingsNow();
    const path = cleanPath($(row.box).value);
    if (path) await pathSaved(key, path);
    refreshStatus();
  };
}
$('pathClear').onclick = async () => {
  $('setPath').value = '';
  await saveSettingsNow();
  refreshStatus();
};
// Clearing the PDF row also forgets the folder, so copying stops.
$('pdfOff').onclick = async () => {
  $('setPdfPath').value = '';
  await saveSettingsNow();
  await store.del('pdfDir');
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
  $('setPdfPath').value = st.pdfPath ?? '';
  $('setBusts').checked = st.skipBusts === true;
  $('setStatues').checked = st.skipStatues === true;
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
  await act('saveSettings', { maxDownloadsPerHour: cap, forbiddenRetryMinutes: retry, excludeCreators: exclude, archivePath: $('setPath').value.trim(), pdfPath: $('setPdfPath').value.trim(), skipBusts: $('setBusts').checked, skipStatues: $('setStatues').checked });
  $('setCap').value = cap;
  $('setRetry').value = retry;
  const n = exclude.length;
  $('excludeCount').textContent = n ? `(${n} skipped)` : '';
  showNotice(`Saved.${n ? ` Skipping ${n} creator${n === 1 ? '' : 's'} from the next Sync.` : ''}${cap > RISKY_CAP ? ` Heads up: ${cap}/hour is above the ~${RISKY_CAP} where MMF has been reported to push back.` : ''}`, cap > RISKY_CAP, 5000);
}
$('setCap').onchange = saveSettingsNow;
$('setBusts').onchange = $('setStatues').onchange = async () => { await saveSettingsNow(); refreshStatus(); loadTree(); };
$('setRetry').onchange = saveSettingsNow;
$('setPath').oninput = () => { $('pathClear').disabled = $('setPath').value.trim() === ''; };
$('setPdfPath').oninput = () => { if ($('setPdfPath').value.trim() !== '') $('pdfOff').disabled = false; };
$('creatorList').onchange = saveSettingsNow;


$('search').oninput = (e) => { filter = e.target.value.trim().toLowerCase(); historyMode ? renderHistory() : renderTree(); };
$('getAll').onclick = () => setSkip(visibleObjects(), false);
$('skipAll').onclick = () => setSkip(visibleObjects(), true);
$('hiddenOnly').onclick = async () => {
  hiddenOnly = !hiddenOnly;
  if (hiddenOnly) newOnly = false;
  await loadTree();
  if (hiddenOnly) { for (const c of tree) { expanded.add(`c:${c.name}`); for (const b of c.bundles) expanded.add(`b:${c.name}/${b.name}`); } renderTree(); }
  refreshStatus();
};
$('newOnly').onclick = () => {
  newOnly = !newOnly;
  if (newOnly) for (const c of filteredTree()) { expanded.add(`c:${c.name}`); for (const b of c.bundles) expanded.add(`b:${c.name}/${b.name}`); }
  renderTree();
};
$('expand').onclick = () => {
  const anyOpen = expanded.size > 0;
  expanded.clear();
  if (!anyOpen) for (const c of tree) expanded.add(`c:${c.name}`);
  $('expand').textContent = anyOpen ? 'Expand all' : 'Collapse all';
  $('expand').title = anyOpen ? 'Open every creator one level, to show its releases' : 'Close every creator';
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
  pdf: { icon: '📄', cls: '' },
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
    const link = (e.type === 'done' && e.objectId != null) || (e.type === 'pdf' && Array.isArray(e.at));
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
    el.onclick = () => (e.type === 'pdf' ? revealPdf(e.at) : reveal({ objectId: e.objectId }));
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
let lastCounts = '';
async function tick() {
  await refreshStatus();
  const running = lastStatus?.running || lastStatus?.planning;
  // The list (ticks, NEW badges, failed marks) is redrawn the moment a file finishes or fails,
  // or a run ends: not only on the slower regular refresh.
  const sum = lastStatus?.summary;
  const counts = sum ? `${sum.done}/${sum.failed}/${sum.skipped}/${Boolean(running)}` : '';
  const moved = counts !== lastCounts;
  lastCounts = counts;
  if (moved || Date.now() - lastTree > (running ? 4000 : 30000)) {
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
