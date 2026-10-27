// Builds the download queue: fetches each object's file list from the official
// API (paced, cached, resumable) and works out where each file belongs.

import path from 'node:path';
import { existsSync } from 'node:fs';
import { OBJECTS_DIR, UNAVAILABLE_PATH, RELEASES_PATH, readJson, writeJson } from './config.js';
import { applyExclusions, deriveGroupTitles, destinationFor, loadLibrary } from './library.js';
import { loadQueue, mergeQueue, saveQueue } from './queue.js';
import { safeName } from './names.js';
import { AuthError, CloudflareBlockError } from './http.js';

const FILES_PAGE = 100;

// Pulls every file for an object, following pagination when the object
// payload only carries the first page.
async function allFiles(api, obj) {
  const first = obj.files?.items ?? (Array.isArray(obj.files) ? obj.files : []);
  const total = Number(obj.files?.total_count ?? first.length);
  if (first.length >= total) return first;
  const items = [];
  for (let page = 1; items.length < total; page++) {
    const res = await api.get(`/objects/${obj.id}/files?per_page=${FILES_PAGE}&page=${page}`);
    const batch = res.items ?? [];
    if (!batch.length) break;
    items.push(...batch);
  }
  return items;
}

async function objectWithFiles(api, id, { refresh }) {
  const cachePath = path.join(OBJECTS_DIR, `${id}.json`);
  if (!refresh && existsSync(cachePath)) return { obj: await readJson(cachePath), cached: true };
  const obj = await api.object(id);
  obj.files = { total_count: undefined, items: await allFiles(api, obj) };
  obj.files.total_count = obj.files.items.length;
  await writeJson(cachePath, obj);
  return { obj, cached: false };
}

const ARCHIVE = /\.(zip|rar|7z)$/i;
const MMF_SITE = 'https://www.myminifactory.com';

export function itemsForObject(entry, obj, dest) {
  const files = (obj.files?.items ?? []).filter((f) => f?.download_url && f.id != null);
  const names = files.map((f) => f.filename ?? f.path ?? '');

  // Older models have only loose parts (STL/LYS...) and no creator archive.
  // Like the site's Download button, fetch MMF's whole-model zip instead.
  // PDF-only objects (books) stay as PDFs.
  const loosePartsOnly = files.length > 0
    && !names.some((n) => ARCHIVE.test(n))
    && !names.every((n) => /\.pdf$/i.test(n));
  if (loosePartsOnly) {
    return [{
      key: `${entry.id}:whole`,
      objectId: entry.id,
      fileId: 'whole',
      objectName: entry.name,
      creator: entry.creator,
      url: `${MMF_SITE}/download/${entry.id}`,
      filename: safeName(`${entry.name}.zip`, 180),
      size: null,
      dest,
      objectFileCount: 1,
      wholeZip: true,
      replaces: names.map((n) => safeName(n, 180)),
    }];
  }

  // A model with a single file is named after its MMF page title, which keeps
  // details the creator's filename drops ("Kevin Brightwood.zip" becomes
  // "Kevin Bightwood - Half-orc Barbarian.zip"). Multi-file models keep the
  // creator's names (Supported/Unsupported etc.).
  const single = files.length === 1;
  return files.map((f) => {
    const original = safeName(f.filename ?? f.path ?? `${f.id}.zip`, 180);
    const ext = path.extname(original);
    const filename = single && entry.name ? safeName(`${entry.name}${ext}`, 180) : original;
    return {
      key: `${entry.id}:${f.id}`,
      objectId: entry.id,
      fileId: f.id,
      objectName: entry.name,
      creator: entry.creator,
      url: f.download_url,
      filename,
      originalFilename: original,
      size: Number(f.size) || null,
      dest,
      objectFileCount: files.length,
    };
  });
}

// Creators often sell a full release bundle AND each model on its own, with
// the very same zips. A file with the same creator, name and exact byte size
// is downloaded once and filed with the object that has the most files (the
// bundle). The others are listed in `alsoIn`.
export function dedupeItems(items) {
  const groups = new Map();
  for (const it of items) {
    if (!it.size) { groups.set(Symbol('unsized'), [it]); continue; }
    const k = `${it.creator}\u0000${(it.originalFilename ?? it.filename).toLowerCase()}\u0000${it.size}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  const kept = [];
  let dupes = 0;
  let bytesSaved = 0;
  for (const group of groups.values()) {
    group.sort((a, b) => b.objectFileCount - a.objectFileCount || a.objectId - b.objectId || a.fileId - b.fileId);
    const [keep, ...rest] = group;
    if (rest.length) {
      keep.alsoIn = [...new Set(rest.map((r) => r.objectId))];
      dupes += rest.length;
      bytesSaved += rest.reduce((n, r) => n + (r.size ?? 0), 0);
    }
    kept.push(keep);
  }
  kept.sort((a, b) => items.indexOf(a) - items.indexOf(b));
  return { items: kept, dupes, bytesSaved };
}

// Files that would land at the same path get the object id appended.
export function resolveNameClashes(items) {
  const seen = new Map();
  for (const it of items) {
    const k = [...it.dest, it.filename].join('/').toLowerCase();
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  for (const it of items) {
    const k = [...it.dest, it.filename].join('/').toLowerCase();
    if (seen.get(k) > 1) {
      const ext = path.extname(it.filename);
      it.filename = `${path.basename(it.filename, ext)} [${it.objectId}]${ext}`;
    }
  }
  return items;
}

export async function buildPlan(cfg, api, { refresh = false, log = console.log } = {}) {
  const { kept, excluded } = applyExclusions(await loadLibrary(), cfg.excludeCreators);
  const groupTitles = deriveGroupTitles(kept, await readJson(RELEASES_PATH, {}));
  log(`Planning ${kept.length} objects (${excluded.length} excluded).`);

  const planned = [];
  const unavailable = [];
  const errors = [];
  let fetched = 0;
  let cached = 0;

  for (const [i, entry] of kept.entries()) {
    try {
      const r = await objectWithFiles(api, entry.id, { refresh });
      r.cached ? cached++ : fetched++;
      const dest = destinationFor(entry, groupTitles, cfg.bundleTitles);
      const items = itemsForObject(entry, r.obj, dest);
      if (!items.length) unavailable.push({ id: entry.id, name: entry.name, creator: entry.creator, reason: 'no downloadable files' });
      planned.push(...items);
    } catch (err) {
      if (err instanceof CloudflareBlockError || err instanceof AuthError) throw err;
      if (err.status === 404) {
        unavailable.push({ id: entry.id, name: entry.name, creator: entry.creator, reason: 'not found on MMF (removed?)' });
      } else {
        // Keep going; the next "plan" retries it (fetched objects are cached).
        errors.push({ id: entry.id, name: entry.name, error: err.message });
        log(`  ! ${entry.id} ${entry.name}: ${err.message}`);
      }
    }
    if (shouldLogProgress(i, kept.length)) {
      log(`  ${i + 1}/${kept.length} objects (${fetched} fetched, ${cached} cached)`);
    }
  }

  // Objects that failed to load this run keep their existing queue items.
  const existing = await loadQueue().catch(() => null);
  if (errors.length && existing) {
    const failedIds = new Set(errors.map((e) => e.id));
    planned.push(...existing.items.filter((i) => failedIds.has(i.objectId)).map(({ status, attempts, error, doneAt, startedAt, movedFrom, alsoIn, ...rest }) => rest));
  }
  const deduped = dedupeItems(planned);
  resolveNameClashes(deduped.items);
  const queue = await mergeQueue(existing, deduped.items, cfg.archiveRoot);
  await saveQueue(queue);
  await writeJson(UNAVAILABLE_PATH, unavailable);
  return { queue, unavailable, errors, fetched, cached, groupTitles, dupes: deduped.dupes, bytesSaved: deduped.bytesSaved };
}

// Progress line every 25 objects and at the end.
function shouldLogProgress(i, total) {
  return (i + 1) % 25 === 0 || i + 1 === total;
}
