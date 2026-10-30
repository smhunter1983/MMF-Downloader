// MMF Downloader 2.0 engine: everything the Node bridge did, inside the
// extension. It runs in a hidden background page (see host.js) so downloads
// keep going with the dashboard closed.
//
// It is plain logic: storage, the archive folder, the network and the clock
// are passed in, so it can be tested with fakes (test/engine.test.js).
//
//   store:   { get(key), set(key, value), getObject(id), setObject(id, obj),
//              appendHistory(event), readHistory(limit) }
//   getDisk: async () => disk adapter for the picked folder (engine/disk.js),
//            or throws when no folder is picked / permission is missing
//   fetchImpl, now, sleep, log

import {
  STATUS, MAX_ATTEMPTS, buildTree, setSkip, finalParts, mergeQueue, startBatch, joinBatch,
  batchSummary, finishBatchIfDone, upcoming, summarize, newestSeen,
} from '../core/queue.js';
import { buildEntries, applyExclusions, deriveGroupTitles, destinationFor } from '../core/library.js';
import { itemsForObject, dedupeItems, resolveNameClashes, parseArchivesFromPage, MMF_SITE } from '../core/items.js';
import { verifyBytes, looksLikeHtml } from '../core/zip.js';

export const DEFAULT_SETTINGS = Object.freeze({
  maxDownloadsPerHour: 120,
  forbiddenRetryMinutes: 10,
  pageDelayMs: 1500,
  excludeCreators: [],
  bundleTitles: {},
  archivePath: '', // optional, only for "copy location" (Chrome doesn't reveal folder paths)
});

const HOUR_MS = 60 * 60 * 1000;
const WRITE_BATCH = 16 * 1024 * 1024;
const RETRY_FAILED_MS = 5000;

export class NeedsFolderError extends Error {}

const concat = (chunks, total) => {
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
};
const extOf = (name) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i) : ''; };
const withExt = (name, ext) => name.slice(0, name.length - extOf(name).length) + ext;
const label = (i) => `${i.creator} / ${i.objectName} / ${i.filename}`;

export function createEngine({
  store, getDisk, fetchImpl = (...a) => fetch(...a), now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {}, onChange = () => {},
}) {
  let queue = { items: [] };
  let settings = { ...DEFAULT_SETTINGS };
  let starts = []; // download start times in the last hour (hourly cap)
  const state = {
    running: false, paused: false, pauseReason: null, hold: null, retriedRefusal: false,
    current: null, message: 'Ready', planning: null, lastPlan: null,
  };
  let loop = null;
  let wake = null; // resolves an in-progress wait early (Pause, Start)

  const changed = () => { try { onChange(); } catch { /* the dashboard may be closed */ } };
  const saveQueue = () => store.set('queue', queue);
  const history = (event) => store.appendHistory(event).catch((e) => log(`history: ${e.message}`));
  const say = (message) => { state.message = message; changed(); };

  async function init() {
    queue = (await store.get('queue')) ?? { items: [] };
    settings = { ...DEFAULT_SETTINGS, ...((await store.get('settings')) ?? {}) };
    starts = ((await store.get('starts')) ?? []).filter((t) => t > now() - HOUR_MS);
    for (const i of queue.items) if (i.status === STATUS.ACTIVE) i.status = STATUS.PENDING;
    // A run that was going when Chrome closed (restart, Windows Update) resumes.
    return { resume: (await store.get('wasRunning')) === true };
  }

  // ---------- status ----------

  function rateInfo() {
    starts = starts.filter((t) => t > now() - HOUR_MS);
    const full = starts.length >= settings.maxDownloadsPerHour;
    return { inLastHour: starts.length, cap: settings.maxDownloadsPerHour, waitMs: full ? starts[0] + HOUR_MS - now() + 1000 : 0 };
  }

  function status() {
    const current = queue.items.find((i) => i.status === STATUS.ACTIVE);
    return {
      running: state.running,
      paused: state.paused,
      pauseReason: state.pauseReason,
      message: state.message,
      hold: state.hold ? { until: new Date(state.hold.until).toISOString(), reason: state.hold.reason } : null,
      planning: state.planning,
      lastPlan: state.lastPlan,
      summary: summarize(queue),
      batch: batchSummary(queue),
      lastBatch: queue.lastBatch ?? null,
      upcoming: upcoming(queue),
      rate: rateInfo(),
      current: current ? { label: label(current), size: current.size, bytes: state.current?.bytes ?? 0 } : null,
      settings,
    };
  }

  // ---------- history ----------

  async function readHistory(limit = 10000) {
    const byKey = new Map(queue.items.map((i) => [i.key, i]));
    return (await store.readHistory(limit)).map((e) => {
      const item = e.key ? byKey.get(e.key) : null;
      return {
        t: e.t,
        type: e.type === 'fail' && e.status !== STATUS.FAILED ? 'retry' : e.type,
        creator: item?.creator ?? e.creator ?? null,
        model: item?.objectName ?? e.model ?? null,
        file: item?.filename ?? e.file ?? e.key ?? null,
        objectId: item?.objectId ?? null,
        bytes: e.bytes ?? null,
        files: e.files ?? null,
        failed: e.failed ?? null,
        reason: e.reason ?? e.note ?? null,
        until: e.until ?? null,
      };
    });
  }

  // ---------- controls ----------

  const busyPlanning = () => (state.planning ? { ok: false, error: 'Updating the download list; try again in a moment.' } : null);

  async function start() {
    if (state.planning) return busyPlanning();
    await getDisk(); // throws NeedsFolderError if the folder isn't usable
    state.paused = false;
    state.pauseReason = null;
    state.hold = null;
    state.retriedRefusal = false;
    const ahead = upcoming(queue);
    if (startBatch(queue, now())) await saveQueue();
    if (!ahead.files && !batchSummary(queue)?.total) return { ok: true, nothing: true };
    if (ahead.files) await history({ type: 'start', files: ahead.files, bytes: ahead.bytes });
    state.running = true;
    await store.set('wasRunning', true);
    say('Starting...');
    wake?.();
    loop ??= runLoop().finally(() => { loop = null; });
    return { ok: true };
  }

  function pause(reason = null) {
    state.running = false;
    store.set('wasRunning', false).catch(() => {});
    if (reason) {
      state.paused = true;
      state.pauseReason = reason;
      history({ type: 'pause', reason });
    }
    say(reason ? `Paused: ${reason}` : 'Paused. The current file (if any) will finish.');
    wake?.();
    return { ok: true };
  }

  async function setSkipFor(objectIds, skip) {
    if (state.planning) return busyPlanning();
    const changedCount = setSkip(queue, objectIds, skip);
    if (changedCount) await saveQueue();
    changed();
    return { ok: true, changed: changedCount, summary: summarize(queue) };
  }

  async function retryFailed() {
    if (state.planning) return busyPlanning();
    let n = 0;
    for (const i of queue.items) {
      if (i.status === STATUS.FAILED) { i.status = STATUS.PENDING; i.attempts = 0; i.error = null; n++; }
    }
    if (n) await saveQueue();
    changed();
    return { ok: true, retried: n };
  }

  async function saveSettings(patch) {
    settings = { ...settings, ...patch };
    // Retrying a refusal sooner than 5 minutes just gets refused again.
    settings.forbiddenRetryMinutes = Math.max(5, Math.min(120, Number(settings.forbiddenRetryMinutes) || 10));
    settings.maxDownloadsPerHour = Math.max(1, Math.min(1000, Math.round(Number(settings.maxDownloadsPerHour) || 120)));
    await store.set('settings', settings);
    changed();
    return { ok: true, settings };
  }

  // ---------- download loop ----------

  async function wait(ms, message) {
    say(message);
    await Promise.race([sleep(ms), new Promise((r) => { wake = r; })]);
    wake = null;
  }

  async function runLoop() {
    while (state.running) {
      if (state.planning) { await wait(5000, 'Updating the download list...'); continue; }
      if (state.hold) {
        const ms = state.hold.until - now();
        if (ms > 0) { await wait(ms, `${state.hold.reason}; retrying automatically`); continue; }
        state.hold = null;
      }
      const item = queue.items.find((i) => i.status === STATUS.PENDING && !i.skip);
      if (!item) {
        const b = batchSummary(queue);
        if (finishBatchIfDone(queue, now()) && b?.total) {
          await history({ type: 'batch', files: b.done, failed: b.failed, bytes: b.bytesDone });
        }
        await saveQueue();
        state.running = false;
        await store.set('wasRunning', false);
        say(queue.lastBatch && b?.total ? 'All done!' : 'Nothing to download.');
        break;
      }
      const rate = rateInfo();
      if (rate.waitMs > 0) { await wait(rate.waitMs, `Hourly limit reached (${rate.cap} downloads)`); continue; }

      let disk;
      try {
        disk = await getDisk();
      } catch (e) {
        pause(e instanceof NeedsFolderError ? e.message : `Archive folder problem: ${e.message}`);
        break;
      }
      starts.push(now());
      await store.set('starts', starts);
      joinBatch(queue, item, now());
      item.status = STATUS.ACTIVE;
      item.startedAt = new Date(now()).toISOString();
      await saveQueue();
      say(`Downloading ${label(item)}`);
      state.current = { key: item.key, bytes: 0 };
      try {
        await downloadOne(item, disk);
      } catch (e) {
        await fail(item, `Unexpected error: ${e.message}`);
      } finally {
        state.current = null;
      }
      changed();
    }
  }

  async function fail(item, reason, { countAttempt = true, final = false } = {}) {
    if (countAttempt) item.attempts = (item.attempts ?? 0) + 1;
    item.error = reason;
    item.status = final || item.attempts >= MAX_ATTEMPTS ? STATUS.FAILED : STATUS.PENDING;
    await saveQueue();
    await history({ type: 'fail', key: item.key, reason, attempts: item.attempts, status: item.status });
    if (item.status === STATUS.PENDING && countAttempt) await sleep(RETRY_FAILED_MS);
  }

  // Streams the response into <file>.partial beside its final place, writing
  // 16 MB at a time while the next 16 MB downloads (measured fastest on a NAS).
  async function writeBody(res, disk, parts) {
    const w = await disk.writer(parts);
    const reader = res.body.getReader();
    let chunks = [];
    let size = 0;
    let total = 0;
    let writing = Promise.resolve();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (value) { chunks.push(value); size += value.byteLength; total += value.byteLength; }
        if (state.current) state.current.bytes = total;
        if (size >= WRITE_BATCH || (done && size)) {
          const buf = concat(chunks, size);
          chunks = [];
          size = 0;
          await writing; // at most one write in flight
          writing = w.write(buf);
        }
        if (done) break;
      }
      await writing;
      await w.close();
    } catch (e) {
      await w.abort?.().catch(() => {});
      throw e;
    }
    return total;
  }

  async function downloadOne(item, disk) {
    const res = await fetchImpl(item.url, { credentials: 'include' });
    if (res.status === 401) {
      await fail(item, 'HTTP 401', { countAttempt: false });
      pause('MMF says you are logged out. Log in to myminifactory.com in Chrome, then press Start.');
      return;
    }
    if (res.status === 403) {
      await res.body?.cancel().catch(() => {});
      if (!state.retriedRefusal) {
        state.retriedRefusal = true;
        state.hold = { until: now() + settings.forbiddenRetryMinutes * 60000, reason: 'MMF refused a download (HTTP 403)' };
        await fail(item, 'HTTP 403 (retrying automatically)', { countAttempt: false });
        await history({ type: 'hold', key: item.key, reason: state.hold.reason, until: new Date(state.hold.until).toISOString() });
        return;
      }
      await fail(item, 'HTTP 403', { countAttempt: false });
      pause('MMF refused the download again (HTTP 403). Open myminifactory.com in Chrome, make sure you are logged in, then press Start.');
      return;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      await fail(item, `HTTP ${res.status}`);
      return;
    }

    const partial = [...item.dest, `${item.filename}.partial`];
    let bytes;
    try {
      bytes = await writeBody(res, disk, partial);
    } catch (e) {
      await disk.remove(partial);
      await fail(item, `Download interrupted: ${e.message}`);
      return;
    }

    const reader = await disk.reader(partial);
    const isZip = /\.zip$/i.test(item.filename);
    let v = await verifyBytes(reader, { expectedSize: item.size, isZip, isStl: /\.stl$/i.test(item.filename) });
    let filename = item.filename;
    // A model with a single loose part: MMF serves that file itself, not a zip.
    if (!v.ok && item.wholeZip && !v.html) {
      const asStl = await verifyBytes(reader, { isStl: true });
      if (asStl.ok) { v = asStl; filename = withExt(item.filename, '.stl'); }
    }
    if (!v.ok) {
      await disk.remove(partial);
      if (v.html) {
        await fail(item, v.reason, { countAttempt: false });
        pause(`${v.reason} Open myminifactory.com in Chrome, clear any check, then press Start.`);
        return;
      }
      await fail(item, v.reason);
      return;
    }

    const dest = [...item.dest, filename];
    const existing = await disk.sizeOf(dest);
    if (existing === v.bytes) {
      await disk.remove(partial);
    } else if (existing !== null) {
      await disk.remove(partial);
      await fail(item, `A different file is already at ${dest.join('/')}; left it alone`, { countAttempt: false, final: true });
      return;
    } else {
      await disk.move(partial, dest);
    }
    item.filename = filename;
    item.status = STATUS.DONE;
    item.error = null;
    item.note = v.note ?? null;
    item.doneBytes = v.bytes;
    item.doneAt = new Date(now()).toISOString();
    state.retriedRefusal = false;
    if (item.wholeZip) item.setAside = await setAside(item, disk);
    await saveQueue();
    await history({ type: 'done', key: item.key, bytes: v.bytes, dest: dest.join('/'), ...(v.note ? { note: v.note } : {}) });
    log(`ok ${bytes} bytes -> ${dest.join('/')}`);
  }

  // Loose parts replaced by a whole-model download go to _to_delete (never deleted).
  async function setAside(item, disk) {
    const moved = [];
    for (const name of item.replaces ?? []) {
      const from = [...item.dest, name];
      const to = ['_to_delete', ...item.dest, name];
      if ((await disk.sizeOf(from)) === null || (await disk.sizeOf(to)) !== null) continue;
      await disk.move(from, to);
      moved.push(name);
    }
    return moved;
  }

  // ---------- sync: library list + download list ----------

  async function mmfJson(pathname) {
    const res = await fetchImpl(`${MMF_SITE}${pathname}`, { credentials: 'include', headers: { Accept: 'application/json' } });
    const text = await res.text();
    if (!res.ok || text.trimStart().startsWith('<')) {
      throw new Error('MMF returned a web page instead of your library (logged out or a Cloudflare check). Open myminifactory.com, log in, and try again.');
    }
    return JSON.parse(text);
  }

  async function fetchLibrary(progress) {
    progress('Reading your library list...');
    const rows = await mmfJson('/api/data-library/objectPreviews');
    const creators = await mmfJson('/api/data-library/userGroups_metadata');
    const releases = {};
    for (const [n, c] of creators.entries()) {
      progress(`Reading release names (${n + 1}/${creators.length}): ${c.name}`);
      for (const r of await mmfJson(`/api/data-library/userGroup_releases_metadata/${encodeURIComponent(c.id)}`)) {
        releases[r.id] = { label: r.label, createdAt: r.createdAt, creator: c.name };
      }
      await sleep(400);
    }
    return { rows, releases };
  }

  // A model's file list, from cache or its MMF page.
  async function objectFiles(id) {
    const cached = await store.getObject(id);
    if (cached) return { obj: cached, fetched: false };
    await sleep(settings.pageDelayMs);
    const res = await fetchImpl(`${MMF_SITE}/object/3d-print-${encodeURIComponent(id)}`, { credentials: 'include' });
    if (res.status === 404) { await res.body?.cancel().catch(() => {}); return { notFound: true }; }
    const html = await res.text();
    const obj = res.ok ? parseArchivesFromPage(html, id) : null;
    if (!obj) {
      const blocked = looksLikeHtml(html) && /just a moment|cloudflare|log ?in/i.test(html.slice(0, 5000));
      const err = new Error(blocked ? 'MMF showed a check or login page' : `No download list on the model page (HTTP ${res.status})`);
      err.blocked = blocked;
      throw err;
    }
    await store.setObject(id, obj);
    return { obj, fetched: true };
  }

  async function plan(progress) {
    const disk = await getDisk();
    const { rows, releases } = await fetchLibrary(progress);
    await store.set('releases', releases);
    const entries = buildEntries(rows);
    // Every creator in the library (for the "skip these creators" checklist).
    const counts = {};
    for (const e of entries) counts[e.creator] = (counts[e.creator] ?? 0) + 1;
    await store.set('creators', counts);
    const { kept, excluded } = applyExclusions(entries, settings.excludeCreators);
    const titles = deriveGroupTitles(kept, releases);
    const planned = [];
    const unavailable = [];
    const errors = [];
    let fetched = 0;
    for (const [n, entry] of kept.entries()) {
      try {
        const r = await objectFiles(entry.id);
        if (r.notFound) {
          unavailable.push({ id: entry.id, name: entry.name, creator: entry.creator, reason: 'not found on MMF (removed?)' });
        } else {
          if (r.fetched) fetched++;
          const items = itemsForObject(entry, r.obj, destinationFor(entry, titles, settings.bundleTitles));
          if (!items.length) unavailable.push({ id: entry.id, name: entry.name, creator: entry.creator, reason: 'no downloadable files' });
          planned.push(...items);
        }
      } catch (e) {
        if (e.blocked) throw new Error(`${e.message}. Open myminifactory.com in Chrome, log in or pass the check, then Sync again.`);
        errors.push({ id: entry.id, name: entry.name, error: e.message });
      }
      if ((n + 1) % 25 === 0 || n + 1 === kept.length) progress(`${n + 1}/${kept.length} models (${fetched} read from MMF)`);
    }
    // Models that failed to load this time keep their existing items.
    if (errors.length) {
      const failedIds = new Set(errors.map((e) => e.id));
      planned.push(...queue.items.filter((i) => failedIds.has(i.objectId))
        .map(({ status, attempts, error, doneAt, startedAt, movedFrom, alsoIn, packedIn, ...rest }) => rest));
    }
    const deduped = dedupeItems(planned);
    resolveNameClashes(deduped.items);
    progress('Checking your archive folder for files already there...');
    queue = await mergeQueue(queue.items.length ? queue : null, deduped.items, disk, now());
    await saveQueue();
    await store.set('unavailable', unavailable);
    const s = summarize(queue);
    return {
      models: kept.length, excluded: excluded.length, fetched, errors: errors.length, unavailable: unavailable.length,
      dupes: deduped.dupes, pending: s.pending, failed: s.failed, newModels: newestSeen(queue) === queue.plannedAt
        ? new Set(queue.items.filter((i) => i.firstSeen === queue.plannedAt).map((i) => i.objectId)).size : 0,
    };
  }

  async function sync() {
    if (state.planning) return { ok: true, already: true };
    if (queue.items.some((i) => i.status === STATUS.ACTIVE)) return { ok: false, error: 'A download is in progress. Pause, let it finish, then sync again.' };
    await getDisk();
    state.planning = { startedAt: new Date(now()).toISOString(), line: 'Starting...' };
    changed();
    const at = () => new Date(now()).toISOString();
    (async () => {
      try {
        const r = await plan((line) => { state.planning.line = line; changed(); });
        state.lastPlan = { ok: true, at: at(), ...r };
      } catch (e) {
        state.lastPlan = { ok: false, at: at(), error: e.message };
        log(`sync failed: ${e.message}`);
      } finally {
        state.planning = null;
        changed();
      }
    })();
    return { ok: true, started: true };
  }

  // Where a model, release or creator lives under the archive folder, for
  // "copy location" (an extension can't open Explorer).
  function locate({ objectId, creator, bundle }) {
    if (objectId != null) {
      const done = queue.items.filter((i) => Number(i.objectId) === Number(objectId) && i.status === STATUS.DONE);
      const i = done[0];
      if (!i) return { ok: false, error: 'Nothing downloaded for that model yet' };
      return { ok: true, parts: [...i.dest, i.packedIn ?? i.filename], packed: Boolean(i.packedIn) };
    }
    const i = queue.items.find((x) => x.dest[0] === creator && (bundle === undefined || x.dest[1] === bundle));
    if (!i) return { ok: false, error: 'Nothing there yet' };
    return { ok: true, parts: bundle === undefined ? [i.dest[0]] : [...i.dest] };
  }

  // Creators for the settings checklist: everyone seen in the last Sync (or in
  // the download list), plus anyone already excluded.
  async function creators() {
    const counts = { ...((await store.get('creators')) ?? {}) };
    if (!Object.keys(counts).length) {
      for (const [name, models] of buildTree(queue).map((c) => [c.name, c.bundles.reduce((n, b) => n + b.objects.length, 0)])) counts[name] = models;
    }
    const known = new Set(Object.keys(counts).map((n) => n.trim().toLowerCase()));
    for (const name of settings.excludeCreators) if (!known.has(name.trim().toLowerCase())) counts[name] = null;
    const skip = new Set(settings.excludeCreators.map((c) => c.trim().toLowerCase()));
    return Object.entries(counts)
      .map(([name, models]) => ({ name, models, skipped: skip.has(name.trim().toLowerCase()) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  return {
    init, status, locate, creators, tree: () => buildTree(queue), newSince: () => newestSeen(queue), history: readHistory,
    start, pause: () => pause(), setSkip: setSkipFor, retryFailed, sync, saveSettings,
    get queue() { return queue; },
    whenIdle: () => loop ?? Promise.resolve(),
  };
}
