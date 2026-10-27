// The download queue: one item per file to fetch, persisted to
// data/queue.json so any stop (crash, reboot, Ctrl+C) resumes cleanly.

import path from 'node:path';
import { stat, mkdir, rename } from 'node:fs/promises';
import { QUEUE_PATH, readJson, writeJson } from './config.js';

export const STATUS = Object.freeze({
  PENDING: 'pending',
  ACTIVE: 'active',
  DONE: 'done',
  FAILED: 'failed',
});

export const MAX_ATTEMPTS = 3;

export async function loadQueue(file = QUEUE_PATH) {
  const q = await readJson(file);
  if (!q) throw new Error('No download queue yet. Run: node mmf.js plan');
  return q;
}

export const saveQueue = (q, file = QUEUE_PATH) => writeJson(file, q);

// Creator > Bundle > Object view of the queue for the dashboard.
export function buildTree(q) {
  const creators = new Map();
  for (const i of q.items) {
    const [creatorDir, bundleDir] = i.dest;
    if (!creators.has(creatorDir)) creators.set(creatorDir, new Map());
    const bundles = creators.get(creatorDir);
    if (!bundles.has(bundleDir)) bundles.set(bundleDir, new Map());
    const objects = bundles.get(bundleDir);
    if (!objects.has(i.objectId)) {
      objects.set(i.objectId, { id: i.objectId, name: i.objectName, files: 0, bytes: 0, unsized: 0, doneFiles: 0, skip: true, failed: 0 });
    }
    const o = objects.get(i.objectId);
    o.files++;
    // Once a file is downloaded its real size is known, even if MMF lists none.
    const bytes = Number(i.size) || (i.status === STATUS.DONE ? Number(i.doneBytes) || 0 : 0);
    o.bytes += bytes;
    if (!bytes) o.unsized++;
    if (i.status === STATUS.DONE) o.doneFiles++;
    if (i.status === STATUS.FAILED) o.failed++;
    if (!i.skip) o.skip = false;
  }
  return [...creators].sort(([a], [b]) => a.localeCompare(b)).map(([name, bundles]) => ({
    name,
    bundles: [...bundles].sort(([a], [b]) => a.localeCompare(b)).map(([bname, objects]) => ({
      name: bname,
      objects: [...objects.values()].sort((a, b) => b.files - a.files || a.name.localeCompare(b.name)),
    })),
  }));
}

export function setSkip(q, objectIds, skip) {
  const ids = new Set(objectIds.map(Number));
  let changed = 0;
  for (const i of q.items) {
    if (ids.has(Number(i.objectId)) && i.skip !== skip) {
      i.skip = skip;
      changed++;
    }
  }
  return changed;
}

export const finalPath = (archiveRoot, item) => path.join(archiveRoot, ...item.dest, item.filename);

async function sizeOf(file) {
  try { return (await stat(file)).size; } catch { return null; }
}

// Merges freshly planned items into an existing queue, keeping progress.
// An item counts as done if its file is already in the archive at full size,
// which is what makes re-planning a "gap check".
export async function mergeQueue(existing, planned, archiveRoot) {
  const old = new Map((existing?.items ?? []).map((i) => [i.key, i]));
  // New rows for a model (e.g. a whole-model zip replacing loose parts)
  // inherit Skip when every earlier row of that model was skipped.
  const modelSkipped = new Map();
  for (const i of existing?.items ?? []) {
    modelSkipped.set(i.objectId, (modelSkipped.get(i.objectId) ?? true) && i.skip === true);
  }
  const items = [];
  for (const p of planned) {
    const prev = old.get(p.key);
    const item = { ...p, status: STATUS.PENDING, attempts: 0, error: null, skip: modelSkipped.get(p.objectId) ?? false };
    if (prev) {
      item.skip = prev.skip === true;
      item.status = prev.status === STATUS.ACTIVE ? STATUS.PENDING : prev.status;
      item.attempts = prev.attempts ?? 0;
      item.error = prev.error ?? null;
      item.doneAt = prev.doneAt;
      item.doneBytes = prev.doneBytes;
      item.note = prev.note;
    }
    // Bundle folder or file name changed since this file was filed (e.g. a
    // group got a real title): move it rather than download it again.
    if (prev?.status === STATUS.DONE && prev.dest && prev.filename) {
      const from = finalPath(archiveRoot, prev);
      const to = finalPath(archiveRoot, item);
      if (from !== to && (await sizeOf(from)) === Number(item.size) && (await sizeOf(to)) === null) {
        await mkdir(path.dirname(to), { recursive: true });
        await rename(from, to);
        item.movedFrom = from;
      }
    }
    // The archive on disk is the source of truth for "done". Some older MMF
    // files (loose STLs) have no size in the API; then any non-empty file the
    // bridge filed counts (it was verified when it was filed).
    const onDisk = await sizeOf(finalPath(archiveRoot, item));
    // A file the bridge verified and filed counts at the size it was filed at,
    // even when MMF's listed size is wrong.
    const known = Number(item.size) > 0;
    const filedSize = prev?.status === STATUS.DONE ? (prev.doneBytes ?? (prev.note ? onDisk : null)) : null;
    const matches = known ? onDisk === Number(item.size) : onDisk > 0;
    if (onDisk !== null && onDisk > 0 && (matches || onDisk === filedSize)) {
      item.status = STATUS.DONE;
      item.error = null;
    } else if (item.status === STATUS.DONE) {
      item.status = STATUS.PENDING;
    }
    items.push(item);
  }
  const keys = new Set(items.map((i) => i.key));
  const batch = existing?.batch
    ? { ...existing.batch, keys: existing.batch.keys.filter((k) => keys.has(k)) }
    : undefined;
  return { plannedAt: new Date().toISOString(), items, batch, lastBatch: existing?.lastBatch };
}

// ---------- batches ----------
// A batch is what Start sets in motion: the selected files not yet done,
// plus anything selected while it runs. Progress, GB and ETA in the
// dashboard count the batch, then reset when it finishes.

const sizeOfItem = (i) => Number(i.size) || Number(i.doneBytes) || 0;
const wanted = (i) => !i.skip && i.status !== STATUS.DONE;

export function startBatch(q, now = Date.now()) {
  const add = q.items.filter(wanted).map((i) => i.key);
  if (!add.length && !q.batch) return false;
  if (!q.batch) q.batch = { startedAt: new Date(now).toISOString(), keys: [] };
  const have = new Set(q.batch.keys);
  for (const k of add) if (!have.has(k)) q.batch.keys.push(k);
  return true;
}

export function joinBatch(q, item, now = Date.now()) {
  if (!q.batch) q.batch = { startedAt: new Date(now).toISOString(), keys: [] };
  if (!q.batch.keys.includes(item.key)) q.batch.keys.push(item.key);
}

export function batchSummary(q) {
  if (!q.batch) return null;
  const byKey = new Map(q.items.map((i) => [i.key, i]));
  const s = { total: 0, done: 0, failed: 0, bytesTotal: 0, bytesDone: 0, startedAt: q.batch.startedAt };
  for (const k of q.batch.keys) {
    const i = byKey.get(k);
    if (!i || (i.skip && i.status !== STATUS.DONE)) continue; // unchecked mid-run
    s.total++;
    s.bytesTotal += sizeOfItem(i);
    if (i.status === STATUS.DONE) { s.done++; s.bytesDone += sizeOfItem(i); }
    if (i.status === STATUS.FAILED) s.failed++;
  }
  return s;
}

// Closes the batch once every file in it is done or has failed for good.
export function finishBatchIfDone(q, now = Date.now()) {
  const b = batchSummary(q);
  if (!b) return false;
  if (b.done + b.failed < b.total) return false;
  if (b.total) {
    q.lastBatch = { files: b.done, failed: b.failed, bytes: b.bytesDone, startedAt: b.startedAt, finishedAt: new Date(now).toISOString() };
  }
  delete q.batch;
  return true;
}

// What Start would download next (selected, not yet done).
export function upcoming(q) {
  let files = 0;
  let bytes = 0;
  for (const i of q.items) if (wanted(i)) { files++; bytes += sizeOfItem(i); }
  return { files, bytes };
}

// Counts what's selected for download. Skipped files (Get/Skip in the
// dashboard) are reported separately and never downloaded.
export function summarize(q) {
  const s = { total: 0, pending: 0, active: 0, done: 0, failed: 0, bytesTotal: 0, bytesDone: 0, skipped: 0, bytesSkipped: 0 };
  for (const i of q.items) {
    if (i.skip && i.status !== STATUS.DONE) {
      s.skipped++;
      s.bytesSkipped += Number(i.size) || 0;
      continue;
    }
    s.total++;
    s[i.status]++;
    const b = Number(i.size) || 0;
    s.bytesTotal += b;
    if (i.status === STATUS.DONE) s.bytesDone += b;
  }
  return s;
}
