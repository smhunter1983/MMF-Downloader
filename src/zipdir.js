// Reads a zip's central directory (names and uncompressed sizes) without
// unpacking anything. Handles ZIP64, which 7-Zip writes for archives or
// members over 4 GB. Used to recognise files that were folded into a
// combined zip (see tools/Combine-RescalePairs.ps1) so they are not
// downloaded again.

import { open } from 'node:fs/promises';
import path from 'node:path';

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const MAX_CD_BYTES = 64 * 1024 * 1024;
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;

async function readAt(fh, position, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  if (bytesRead !== length) throw new Error('Unexpected end of zip file');
  return buf;
}

function u64(buf, at) {
  const n = buf.readBigUInt64LE(at);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Zip value too large');
  return Number(n);
}

/** Returns Map(entryName -> uncompressed size). Throws if not a readable zip. */
export async function readZipEntries(file) {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    if (size < 22) throw new Error('Not a zip (too small)');
    const tailLen = Math.min(size, 22 + U16_MAX);
    const tailPos = size - tailLen;
    const tail = await readAt(fh, tailPos, tailLen);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD) { e = i; break; }
    }
    if (e < 0) throw new Error('Not a zip (no end-of-archive record)');

    let count = tail.readUInt16LE(e + 10);
    let cdSize = tail.readUInt32LE(e + 12);
    let cdOffset = tail.readUInt32LE(e + 16);
    if (count === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
      const locAt = tailPos + e - 20;
      if (locAt < 0) throw new Error('ZIP64 locator missing');
      const loc = await readAt(fh, locAt, 20);
      if (loc.readUInt32LE(0) !== ZIP64_LOCATOR) throw new Error('ZIP64 locator missing');
      const z = await readAt(fh, u64(loc, 8), 56);
      if (z.readUInt32LE(0) !== ZIP64_EOCD) throw new Error('ZIP64 end record missing');
      count = u64(z, 32);
      cdSize = u64(z, 40);
      cdOffset = u64(z, 48);
    }
    if (cdSize > MAX_CD_BYTES || cdOffset + cdSize > size) throw new Error('Zip directory is damaged');

    const cd = await readAt(fh, cdOffset, cdSize);
    const entries = new Map();
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CENTRAL) throw new Error('Zip directory is damaged');
      const flags = cd.readUInt16LE(p + 8);
      let compSize = cd.readUInt32LE(p + 20);
      let realSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const nameBuf = cd.subarray(p + 46, p + 46 + nameLen);
      const name = nameBuf.toString(flags & 0x800 ? 'utf8' : 'latin1');
      if (realSize === U32_MAX || compSize === U32_MAX) {
        const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
        for (let x = 0; x + 4 <= extra.length;) {
          const id = extra.readUInt16LE(x);
          const len = extra.readUInt16LE(x + 2);
          if (id === 0x0001) {
            let at = x + 4;
            if (realSize === U32_MAX) { realSize = u64(extra, at); at += 8; }
            if (compSize === U32_MAX) { compSize = u64(extra, at); at += 8; }
            break;
          }
          x += 4 + len;
        }
        if (realSize === U32_MAX) throw new Error(`ZIP64 size missing for ${name}`);
      }
      entries.set(name, realSize);
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    await fh.close();
  }
}

// Same rule as tools/Combine-RescalePairs.ps1: the creature name is the file
// name with a trailing _Supports / _Supported / _Unsupported removed.
const PAIR_SUFFIX = /[ _-]*(supports|supported|unsupported)$/i;

export function packedName(filename) {
  const ext = path.extname(filename);
  if (ext.toLowerCase() !== '.zip') return null;
  const stem = path.basename(filename, ext).replace(PAIR_SUFFIX, '');
  return stem ? `${stem}.zip` : null;
}

/**
 * Is this item's file inside the combined zip beside it? Yes when the
 * combined zip lists the same file name at the expected size, or (for a
 * duplicate download that shared the combined zip's name) any member of
 * exactly the expected size. `entriesOf` caches directory reads.
 */
export async function findPacked(dir, item, expectedSize, entriesOf) {
  const name = packedName(item.filename);
  if (!name) return null;
  const isOwnName = name.toLowerCase() === item.filename.toLowerCase();
  if (!isOwnName && !PAIR_SUFFIX.test(path.basename(item.filename, path.extname(item.filename)))) return null;
  const entries = await entriesOf(path.join(dir, name));
  if (!entries) return null;
  const want = Number(expectedSize) > 0 ? Number(expectedSize) : null;
  for (const [entry, size] of entries) {
    const sameName = entry.toLowerCase() === item.filename.toLowerCase();
    if (want === null ? sameName && size > 0 : size === want && (sameName || isOwnName)) return name;
  }
  return null;
}

// Caching reader for findPacked: missing or unreadable zips give null.
export function zipEntryCache() {
  const cache = new Map();
  return async (file) => {
    if (!cache.has(file)) cache.set(file, await readZipEntries(file).catch(() => null));
    return cache.get(file);
  };
}
