// Turning a model's file list into download items: whole-model zips for
// loose-part-only models, page-title names for single files, de-duplication
// of files sold both in a bundle and alone, and name clashes. Shared by the
// extension and the Node tools: no Node imports here.

import { safeName } from './names.js';

const extOf = (name) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i) : ''; };

const ARCHIVE = /\.(zip|rar|7z)$/i;
export const MMF_SITE = 'https://www.myminifactory.com';

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
    const ext = extOf(original);
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
      const ext = extOf(it.filename);
      it.filename = `${it.filename.slice(0, it.filename.length - ext.length)} [${it.objectId}]${ext}`;
    }
  }
  return items;
}


// Reads the JSON array that follows `"key":` in a page, or null.
function jsonArrayAfter(html, key) {
  const at = html.search(new RegExp(`"${key}"\\s*:\\s*\\[`));
  if (at < 0) return null;
  const start = html.indexOf('[', at);
  let depth = 0;
  let inString = false;
  let j = start;
  for (; j < html.length; j++) {
    const c = html[j];
    if (inString) {
      if (c === '\\') j++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { depth--; if (depth === 0) break; }
  }
  return JSON.parse(html.slice(start, j + 1));
}

/**
 * A model's page on MMF carries its download list, which is what the
 * extension reads instead of the official API:
 *   "archives":[{"id":108451,"path":"Master Wendigo Lychee.zip","size":"86528557",...}]
 *   "pdfFiles":[...]
 *   state.filesInfo[1544916] = { "name": "bigbyp.stl" }   (loose parts)
 * Returned in the API's file-list shape so itemsForObject works on either.
 * null if the page has no download list at all (logged out, Cloudflare).
 */
export function parseArchivesFromPage(html, objectId) {
  const archives = jsonArrayAfter(html, 'archives');
  if (!archives) return null;
  const pdfs = jsonArrayAfter(html, 'pdfFiles') ?? [];
  const items = [];
  for (const a of [...archives, ...pdfs]) {
    const name = a?.path ?? a?.filename ?? a?.name;
    if (!a || a.id == null || !name) continue;
    items.push({ id: a.id, filename: name, size: Number(a.size) || null, download_url: `${MMF_SITE}/download/${objectId}?archive_id=${a.id}` });
  }
  const seen = new Set(items.map((i) => String(i.id)));
  for (const m of html.matchAll(/filesInfo\[(\d+)\]\s*=\s*(\{[^}]*\})/g)) {
    if (seen.has(m[1])) continue;
    let name;
    try { name = JSON.parse(m[2]).name; } catch { continue; }
    if (!name) continue;
    seen.add(m[1]);
    items.push({ id: Number(m[1]), filename: name, size: null, download_url: `${MMF_SITE}/download/${objectId}?downloadfile=${encodeURIComponent(name)}` });
  }
  return { id: objectId, files: { items } };
}
