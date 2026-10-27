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
  return { plannedAt: new Date().toISOString(), items };
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
