// Local bridge between the Chrome extension and the download queue.
//
// The extension asks for the next file, lets Chrome download it into the
// staging folder, then reports back. The bridge verifies the file and moves it
// into the archive. Only 127.0.0.1 is bound, and every request must come from
// a Chrome extension with our custom header (web pages can't send that header
// without a CORS preflight, which is refused).

import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { appendFile, copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { LOG_PATH, QUEUE_PATH } from './config.js';
import {
  loadQueue, saveQueue, summarize, buildTree, setSkip, finalPath, STATUS, MAX_ATTEMPTS,
  startBatch, joinBatch, batchSummary, finishBatchIfDone, upcoming, newestSeen,
} from './queue.js';
import { verifyDownload } from './verify.js';
import { pinWindow } from './pin.js';
import { readHistory } from './history.js';

export const BRIDGE_HEADER = 'x-mmf-bridge';
const HOUR_MS = 60 * 60 * 1000;
const MAX_BODY = 64 * 1024;
const MAX_LIBRARY_BODY = 50 * 1024 * 1024;

// Chrome download errors that mean "MMF refused us", not "the network hiccuped".
const BLOCKING_ERRORS = new Set(['SERVER_UNAUTHORIZED', 'SERVER_FORBIDDEN', 'SERVER_BAD_CONTENT']);

async function sizeOf(file) {
  try { return (await stat(file)).size; } catch { return null; }
}

async function moveFile(from, to) {
  await mkdir(path.dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    // Different drives (C: -> Z:): copy to a temp name, then swap in.
    const tmp = `${to}.part`;
    await copyFile(from, tmp);
    await rename(tmp, to);
    await rm(from, { force: true });
  }
}

// After a whole-model zip is filed, the loose parts it replaces are moved to
// <archive>\_to_delete\... for the user to delete (never deleted here).
async function setAsideReplaced(cfg, item, log) {
  const moved = [];
  for (const name of item.replaces ?? []) {
    const from = path.join(cfg.archiveRoot, ...item.dest, name);
    if ((await sizeOf(from)) === null) continue;
    const to = path.join(cfg.archiveRoot, '_to_delete', ...item.dest, name);
    if ((await sizeOf(to)) !== null) continue;
    await moveFile(from, to);
    moved.push(name);
  }
  if (moved.length) log(`   moved ${moved.length} loose file(s) to _to_delete (replaced by ${item.filename})`);
  return moved;
}

// Staging names are built only from ids, so nothing in an MMF filename can
// trip up Chrome. The real name is applied when the file is filed.
const stagingExt = (item) => (/\.([a-z0-9]{1,8})$/i.exec(item.filename)?.[1] ?? 'bin').toLowerCase();

export function stagingName(cfg, item) {
  return `${cfg.stagingFolderName}/${item.objectId}_${item.fileId}.${stagingExt(item)}`;
}

// The reported path must be the staged file for this exact item. Chrome may
// add " (1)" for a leftover file, and swaps the extension when the server
// sends a web page (".html"), which the verifier then reports properly.
export function isAllowedStagingPath(cfg, item, reported) {
  if (!reported || !path.isAbsolute(reported)) return false;
  const p = path.resolve(reported);
  const expected = new RegExp(`^${item.objectId}_${item.fileId}( \\(\\d+\\))?\\.[a-z0-9]{1,8}$`, 'i');
  return path.basename(path.dirname(p)) === cfg.stagingFolderName && expected.test(path.basename(p));
}

// Opens Explorer/Finder at a folder, or with a file selected.
export function revealInFileManager(target, { select }) {
  if (process.platform === 'win32') {
    // Explorer parses its own command line: the path must be quoted exactly
    // like /select,"C:\a b\c.zip", which Node's default quoting breaks.
    const arg = select ? `/select,"${target}"` : `"${target}"`;
    execFile('explorer.exe', [arg], { windowsVerbatimArguments: true });
  } else if (process.platform === 'darwin') {
    execFile('open', select ? ['-R', target] : [target]);
  } else {
    execFile('xdg-open', [select ? path.dirname(target) : target]);
  }
}

export function createBridge(cfg, {
  queueFile = QUEUE_PATH, logFile = LOG_PATH, now = () => Date.now(), log = console.log, onLibrary = null, onPlan = null,
  reveal = revealInFileManager, pin = pinWindow,
} = {}) {
  let queue = { items: [] };
  let queueMtime = null;
  const state = { paused: false, pauseReason: null, lastEvent: null };
  const starts = []; // timestamps of downloads started, for the hourly cap
  let lock = Promise.resolve();

  // Serialise all queue mutations.
  const exclusive = (fn) => {
    const run = lock.then(fn, fn);
    lock = run.catch(() => {});
    return run;
  };

  const logEvent = async (event) => {
    state.lastEvent = event;
    await mkdir(path.dirname(logFile), { recursive: true });
    await appendFile(logFile, JSON.stringify({ t: new Date(now()).toISOString(), ...event }) + '\n');
  };
  const mtimeOf = async () => { try { return (await stat(queueFile)).mtimeMs; } catch { return null; } };
  const save = async () => {
    await saveQueue(queue, queueFile);
    queueMtime = await mtimeOf();
  };

  // "node mmf.js plan" may rewrite queue.json while the bridge runs. Pick the
  // new file up instead of overwriting it, keeping the in-flight item active.
  async function syncQueue() {
    const m = await mtimeOf();
    if (m === null || m === queueMtime) return;
    const active = queue.items.filter((i) => i.status === STATUS.ACTIVE).map((i) => i.key);
    queue = await loadQueue(queueFile);
    queueMtime = m;
    for (const i of queue.items) {
      if (active.includes(i.key)) i.status = STATUS.ACTIVE;
      else if (i.status === STATUS.ACTIVE) i.status = STATUS.PENDING;
    }
    log(`Queue reloaded from disk (${queue.items.length} files).`);
  }
  const find = (key) => queue.items.find((i) => i.key === key);

  function pause(reason) {
    state.paused = true;
    state.pauseReason = reason;
    log(`PAUSED: ${reason}`);
    logEvent({ type: 'pause', reason }).catch(() => {});
  }

  // Rolling window: at most maxDownloadsPerHour starts in any window.
  // rateWindowMs exists only so tests can use a short window.
  const windowMs = cfg.rateWindowMs ?? HOUR_MS;
  function rateInfo() {
    const cutoff = now() - windowMs;
    while (starts.length && starts[0] <= cutoff) starts.shift();
    const full = starts.length >= cfg.maxDownloadsPerHour;
    return {
      inLastHour: starts.length,
      cap: cfg.maxDownloadsPerHour,
      waitMs: full ? starts[0] + windowMs - now() + 1000 : 0,
    };
  }

  async function next() {
    await syncQueue();
    if (!queue.items.length) return { action: 'done', summary: summarize(queue), reason: 'No download queue yet. Run: node mmf.js plan' };
    if (state.paused) return { action: 'paused', reason: state.pauseReason };
    if (planning) return { action: 'wait', ms: 5000, reason: 'Updating the download list' };
    // An item still marked active belongs to a download the extension lost
    // track of (browser restart). Put it back in line.
    for (const i of queue.items) if (i.status === STATUS.ACTIVE) i.status = STATUS.PENDING;

    const item = queue.items.find((i) => i.status === STATUS.PENDING && !i.skip);
    if (!item) {
      const b = batchSummary(queue);
      if (finishBatchIfDone(queue, now()) && b?.total) {
        await logEvent({ type: 'batch', files: b.done, failed: b.failed, bytes: b.bytesDone });
      }
      await save();
      return { action: 'done', summary: summarize(queue), lastBatch: queue.lastBatch ?? null };
    }
    const rate = rateInfo();
    if (rate.waitMs > 0) return { action: 'wait', ms: rate.waitMs, reason: `Hourly cap (${rate.cap}) reached` };

    joinBatch(queue, item, now());
    item.status = STATUS.ACTIVE;
    item.startedAt = new Date(now()).toISOString();
    starts.push(now());
    await save();
    log(`-> ${item.creator} / ${item.filename}`);
    return { action: 'download', item: { key: item.key, url: item.url, filename: stagingName(cfg, item), label: `${item.objectName} / ${item.filename}` } };
  }

  async function fail(item, reason, { countAttempt = true } = {}) {
    if (countAttempt) item.attempts = (item.attempts ?? 0) + 1;
    item.error = reason;
    item.status = item.attempts >= MAX_ATTEMPTS ? STATUS.FAILED : STATUS.PENDING;
    await save();
    await logEvent({ type: 'fail', key: item.key, reason, attempts: item.attempts, status: item.status });
    log(`   x ${item.filename}: ${reason}${item.status === STATUS.FAILED ? ' (giving up)' : ''}`);
  }

  async function report({ key, ok, path: staged, error }) {
    await syncQueue();
    const item = find(key);
    if (!item) return { ok: false, error: 'Unknown item' };
    if (item.status !== STATUS.ACTIVE) return { ok: false, error: `Item is ${item.status}, not active` };

    if (!ok) {
      if (BLOCKING_ERRORS.has(error)) {
        await fail(item, `Chrome: ${error}`, { countAttempt: false });
        pause(`MMF refused the download (${error}). Open myminifactory.com in Chrome, make sure you're logged in, then press Start.`);
        return { ok: true, paused: true };
      }
      await fail(item, `Chrome: ${error ?? 'download failed'}`);
      return { ok: true };
    }

    if (!isAllowedStagingPath(cfg, item, staged)) {
      await fail(item, `Unexpected download path: ${staged}`, { countAttempt: false });
      pause('Chrome saved a file somewhere unexpected. Check the staging folder setting.');
      return { ok: false, error: 'Path not allowed' };
    }

    const lower = item.filename.toLowerCase();
    const v = await verifyDownload(staged, { expectedSize: item.size, isZip: lower.endsWith('.zip'), isStl: lower.endsWith('.stl') });
    if (!v.ok) {
      await rm(staged, { force: true });
      if (v.html) {
        await fail(item, v.reason, { countAttempt: false });
        pause(`${v.reason} Open myminifactory.com in Chrome, clear any check, then press Start.`);
        return { ok: true, paused: true };
      }
      await fail(item, v.reason);
      return { ok: true };
    }

    const dest = finalPath(cfg.archiveRoot, item);
    const existing = await sizeOf(dest);
    if (existing === v.bytes) {
      await rm(staged, { force: true });
    } else if (existing !== null) {
      // Never overwrite a different file in the archive (e.g. a combined zip
      // that took this name). Keep the download in staging for a look.
      item.attempts = MAX_ATTEMPTS;
      await fail(item, `A different file is already at ${dest}; left it alone (download kept in staging)`, { countAttempt: false });
      return { ok: true };
    } else {
      await moveFile(staged, dest);
    }
    item.status = STATUS.DONE;
    item.error = null;
    item.note = v.note ?? null;
    item.doneBytes = v.bytes;
    if (item.wholeZip) item.setAside = await setAsideReplaced(cfg, item, log);
    item.doneAt = new Date(now()).toISOString();
    await save();
    await logEvent({ type: 'done', key: item.key, bytes: v.bytes, dest, ...(v.note ? { note: v.note } : {}) });
    if (v.note) log(`   note: ${item.filename}: ${v.note}`);
    log(`   ok ${(v.bytes / 1048576).toFixed(1)} MB -> ${path.join(...item.dest)}`);
    return { ok: true };
  }

  // "plan" run from the dashboard (after Sync library). While it runs, nothing
  // that changes the queue is allowed: plan rewrites queue.json at the end.
  let planning = null;
  let lastPlan = null;
  const planBusy = () => (planning ? { ok: false, error: 'Updating the download list; try again in a moment.' } : null);

  function startPlan() {
    const at = () => new Date(now()).toISOString();
    planning = { startedAt: at(), line: 'Starting...' };
    (async () => {
      try {
        const r = await onPlan({ log: (m) => { planning.line = String(m).trim(); log(m); } });
        lastPlan = { ok: true, at: at(), ...r };
      } catch (err) {
        lastPlan = { ok: false, at: at(), error: err.message };
        log(`plan failed: ${err.message}`);
      } finally {
        planning = null;
      }
    })();
  }

  function status() {
    const current = queue.items.find((i) => i.status === STATUS.ACTIVE);
    return {
      paused: state.paused,
      pauseReason: state.pauseReason,
      summary: summarize(queue),
      batch: batchSummary(queue),
      lastBatch: queue.lastBatch ?? null,
      upcoming: upcoming(queue),
      rate: rateInfo(),
      current: current ? { label: `${current.creator} / ${current.objectName} / ${current.filename}`, size: current.size } : null,
      lastEvent: state.lastEvent,
      planning,
      lastPlan,
    };
  }

  const routes = {
    'GET /status': () => exclusive(async () => { await syncQueue(); return status(); }),
    'POST /next': () => exclusive(next),
    'POST /report': (body) => exclusive(() => report(body)),
    'POST /pause': () => { pause('Paused from Chrome.'); return { ok: true }; },
    // Start: un-pause and (re)open a batch with everything currently selected.
    'POST /resume': () => exclusive(async () => {
      if (planning) return planBusy();
      state.paused = false;
      state.pauseReason = null;
      await syncQueue();
      const ahead = upcoming(queue);
      if (startBatch(queue, now())) await save();
      if (ahead.files) await logEvent({ type: 'start', files: ahead.files, bytes: ahead.bytes });
      return { ok: true, batch: batchSummary(queue) };
    }),
    'GET /history': () => exclusive(async () => { await syncQueue(); return { events: await readHistory(logFile, queue.items) }; }),
    'GET /tree': () => exclusive(async () => { await syncQueue(); return { tree: buildTree(queue), newSince: newestSeen(queue) }; }),
    'POST /skip': ({ objectIds, skip }) => exclusive(async () => {
      if (planning) return planBusy();
      if (!Array.isArray(objectIds) || typeof skip !== 'boolean') return { ok: false, error: 'Expected { objectIds: [...], skip: true|false }' };
      await syncQueue();
      const changed = setSkip(queue, objectIds, skip);
      if (changed) await save();
      return { ok: true, changed, summary: summarize(queue) };
    }),
    // Show a model, release or creator in Explorer. Paths are built from the
    // queue (never taken from the request) and must sit inside the archive.
    'POST /reveal': ({ objectId, creator, bundle }) => exclusive(async () => {
      await syncQueue();
      const root = path.resolve(cfg.archiveRoot);
      let target;
      let select = false;
      if (objectId != null) {
        const done = queue.items.filter((i) => Number(i.objectId) === Number(objectId) && i.status === STATUS.DONE);
        for (const i of done) {
          const own = finalPath(cfg.archiveRoot, i);
          const p = (await sizeOf(own)) === null && i.packedIn ? path.join(cfg.archiveRoot, ...i.dest, i.packedIn) : own;
          if ((await sizeOf(p)) !== null) { target = p; select = true; break; }
        }
      } else if (typeof creator === 'string') {
        const item = queue.items.find((i) => i.dest[0] === creator && (bundle === undefined || i.dest[1] === bundle));
        if (item) target = path.join(cfg.archiveRoot, ...(bundle === undefined ? [item.dest[0]] : item.dest));
      }
      if (!target) return { ok: false, error: 'Nothing downloaded there yet' };
      const resolved = path.resolve(target);
      if (!resolved.startsWith(root + path.sep)) return { ok: false, error: 'Outside the archive folder' };
      if (!select) {
        try { await stat(resolved); } catch { return { ok: false, error: 'Folder does not exist yet' }; }
      }
      reveal(resolved, { select });
      return { ok: true, path: resolved };
    }),
    'POST /pin': ({ title, pinned }) => pin(String(title ?? ''), pinned === true),
    'POST /plan': () => exclusive(async () => {
      if (!onPlan) return { ok: false, error: 'Planning not available' };
      if (planning) return { ok: true, already: true };
      await syncQueue();
      if (queue.items.some((i) => i.status === STATUS.ACTIVE)) return { ok: false, error: 'A download is in progress. Pause, let it finish, then sync again.' };
      startPlan();
      return { ok: true, started: true };
    }),
    'POST /library': (body) => exclusive(async () => {
      if (planning) return planBusy();
      if (!onLibrary) return { ok: false, error: 'Library sync not available' };
      return { ok: true, ...(await onLibrary(body)) };
    }),
    'POST /retry-failed': () => exclusive(async () => {
      if (planning) return planBusy();
      await syncQueue();
      let n = 0;
      for (const i of queue.items) if (i.status === STATUS.FAILED) { i.status = STATUS.PENDING; i.attempts = 0; n++; }
      await save();
      return { ok: true, requeued: n };
    }),
  };

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(new Error('Body too large')); req.destroy(); }
        else chunks.push(c);
      });
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(text ? JSON.parse(text) : {}); } catch { reject(new Error('Bad JSON')); }
      });
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    // Web pages can only send our custom header after a CORS preflight, and
    // preflights (OPTIONS) are refused, so the header proves the caller is the
    // extension. Chrome omits Origin on some extension GETs; when present it
    // must be an extension.
    const origin = req.headers.origin;
    if (req.method === 'OPTIONS' || req.headers[BRIDGE_HEADER] !== '1'
      || (origin !== undefined && !origin.startsWith('chrome-extension://'))) {
      return send(403, { error: 'Forbidden' });
    }
    const pathname = new URL(req.url, 'http://x').pathname;
    const route = routes[`${req.method} ${pathname}`];
    if (!route) return send(404, { error: 'Not found' });
    try {
      const limit = pathname === '/library' ? MAX_LIBRARY_BODY : MAX_BODY;
      const body = req.method === 'POST' ? await readBody(req, limit) : {};
      send(200, await route(body));
    } catch (err) {
      log(`bridge error: ${err.message}`);
      send(500, { error: err.message });
    }
  });

  return {
    async start() {
      queue = await loadQueue(queueFile).catch(() => ({ items: [] }));
      for (const i of queue.items) if (i.status === STATUS.ACTIVE) i.status = STATUS.PENDING;
      // Count downloads started within the last hour toward the cap.
      const cutoff = now() - windowMs;
      for (const i of queue.items) {
        const t = i.startedAt ? Date.parse(i.startedAt) : NaN;
        if (t > cutoff) starts.push(t);
      }
      starts.sort((a, b) => a - b);
      if (queue.items.length) await save();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(cfg.bridgePort, '127.0.0.1', resolve);
      });
      return server.address().port;
    },
    stop: () => new Promise((r) => server.close(r)),
    status,
    get queue() { return queue; },
  };
}

