// Zip and STL checks on raw bytes. Shared by the extension (reading File
// objects from the archive folder) and the Node tools (reading files on
// disk): both pass a reader { size, read(position, length) -> Uint8Array }.
// No Node imports here.

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;
const MAX_CD_BYTES = 64 * 1024 * 1024;
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;
const STL_HEADER = 80;
const STL_TRIANGLE = 50;

const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const u64 = (dv, at) => {
  const n = dv.getBigUint64(at, true);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Zip value too large');
  return Number(n);
};
const latin1 = (bytes) => String.fromCharCode(...bytes);
const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;

async function readExactly(reader, position, length) {
  const bytes = await reader.read(position, length);
  if (bytes.byteLength !== length) throw new Error('Unexpected end of file');
  return bytes;
}

export function looksLikeHtml(text) {
  const head = String(text).trimStart().slice(0, 200).toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html') || head.includes('cloudflare');
}

function findEocd(tail) {
  const dv = view(tail);
  for (let i = tail.byteLength - EOCD_MIN; i >= 0; i--) if (dv.getUint32(i, true) === EOCD_SIG) return i;
  return -1;
}

/** Map(entryName -> uncompressed size) from a zip's central directory (ZIP64 aware). */
export async function readZipEntries(reader) {
  const { size } = reader;
  if (size < EOCD_MIN) throw new Error('Not a zip (too small)');
  const tailLen = Math.min(size, EOCD_MIN + MAX_COMMENT);
  const tailPos = size - tailLen;
  const tail = await readExactly(reader, tailPos, tailLen);
  const e = findEocd(tail);
  if (e < 0) throw new Error('Not a zip (no end-of-archive record)');
  const t = view(tail);
  let count = t.getUint16(e + 10, true);
  let cdSize = t.getUint32(e + 12, true);
  let cdOffset = t.getUint32(e + 16, true);
  if (count === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
    const locAt = tailPos + e - 20;
    if (locAt < 0) throw new Error('ZIP64 locator missing');
    const loc = view(await readExactly(reader, locAt, 20));
    if (loc.getUint32(0, true) !== ZIP64_LOCATOR) throw new Error('ZIP64 locator missing');
    const z = view(await readExactly(reader, u64(loc, 8), 56));
    if (z.getUint32(0, true) !== ZIP64_EOCD) throw new Error('ZIP64 end record missing');
    count = u64(z, 32);
    cdSize = u64(z, 40);
    cdOffset = u64(z, 48);
  }
  if (cdSize > MAX_CD_BYTES || cdOffset + cdSize > size) throw new Error('Zip directory is damaged');
  const cdBytes = await readExactly(reader, cdOffset, cdSize);
  const cd = view(cdBytes);
  const entries = new Map();
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cdBytes.byteLength || cd.getUint32(p, true) !== CENTRAL) throw new Error('Zip directory is damaged');
    const flags = cd.getUint16(p + 8, true);
    let compSize = cd.getUint32(p + 20, true);
    let realSize = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    const nameBytes = cdBytes.subarray(p + 46, p + 46 + nameLen);
    const name = flags & 0x800 && decoder ? decoder.decode(nameBytes) : latin1(nameBytes);
    if (realSize === U32_MAX || compSize === U32_MAX) {
      const ex = cdBytes.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      const exv = view(ex);
      for (let x = 0; x + 4 <= ex.byteLength;) {
        const id = exv.getUint16(x, true);
        const len = exv.getUint16(x + 2, true);
        if (id === 0x0001) {
          let at = x + 4;
          if (realSize === U32_MAX) { realSize = u64(exv, at); at += 8; }
          if (compSize === U32_MAX) { compSize = u64(exv, at); at += 8; }
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
}

// Binary STL: 80-byte header, uint32 triangle count, 50 bytes per triangle,
// so the exact length is known. ASCII STL starts with "solid" and ends with
// "endsolid". Either way a truncated download is caught.
async function checkStl(reader, head) {
  const { size } = reader;
  if (size >= STL_HEADER + 4 && head.byteLength >= STL_HEADER + 4) {
    const count = view(head).getUint32(STL_HEADER, true);
    if (STL_HEADER + 4 + count * STL_TRIANGLE === size) return null;
  }
  if (latin1(head.subarray(0, 5)).toLowerCase() === 'solid') {
    const n = Math.min(size, 256);
    const tail = latin1(await readExactly(reader, size - n, n));
    if (/endsolid[^\n]*\s*$/i.test(tail)) return null;
    return 'STL is incomplete (no "endsolid")';
  }
  return 'STL is incomplete or damaged (length does not match its triangle count)';
}

/**
 * Returns { ok: true, bytes[, note] } or { ok: false, bytes, reason[, html] }.
 * `html: true` means a web page arrived instead of the file (Cloudflare check
 * or logged out), which should pause the run rather than fail one file.
 */
export async function verifyBytes(reader, { expectedSize, isZip, isStl }) {
  const { size } = reader;
  const head = await reader.read(0, Math.min(size, 512));
  if (looksLikeHtml(decoder ? decoder.decode(head) : latin1(head))) {
    return { ok: false, bytes: size, html: true, reason: 'Got a web page instead of the file (Cloudflare check or logged out?)' };
  }
  if (size === 0) return { ok: false, bytes: 0, reason: 'File is empty' };

  let structurallySound = false;
  if (isZip) {
    if (!(head[0] === 0x50 && head[1] === 0x4b)) return { ok: false, bytes: size, reason: 'Not a zip archive (bad header)' };
    const tailLen = Math.min(size, EOCD_MIN + MAX_COMMENT);
    if (findEocd(await readExactly(reader, size - tailLen, tailLen)) < 0) {
      return { ok: false, bytes: size, reason: 'Zip is incomplete (no end-of-archive record)' };
    }
    structurallySound = true;
  }
  if (isStl) {
    const problem = await checkStl(reader, head);
    if (problem) return { ok: false, bytes: size, reason: problem };
    structurallySound = true;
  }
  // MMF's size data is occasionally wrong (seen: sizes swapped between files
  // of one model). A structurally complete file is accepted with a note.
  const want = Number(expectedSize);
  if (want > 0 && size !== want) {
    const reason = `Size mismatch: ${size} bytes, MMF says ${want}`;
    if (!structurallySound) return { ok: false, bytes: size, reason };
    return { ok: true, bytes: size, note: `${reason} (file is complete; MMF's listed size looks wrong)` };
  }
  return { ok: true, bytes: size };
}

// Same rule as tools/Combine-RescalePairs.ps1: the creature name is the file
// name with a trailing _Supports / _Supported / _Unsupported removed.
const PAIR_SUFFIX = /[ _-]*(supports|supported|unsupported)$/i;
const splitExt = (name) => { const i = name.lastIndexOf('.'); return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, '']; };

export function packedName(filename) {
  const [base, ext] = splitExt(filename);
  if (ext.toLowerCase() !== '.zip') return null;
  const stem = base.replace(PAIR_SUFFIX, '');
  return stem ? `${stem}.zip` : null;
}

/**
 * Is this item's file inside the combined zip beside it? Yes when the combined
 * zip lists the same file name at the expected size, or (for a duplicate
 * download that shared the combined zip's name) any member of exactly the
 * expected size. `entriesOf(name)` returns that zip's entries (cached) or null.
 */
export async function findPacked(item, expectedSize, entriesOf) {
  const name = packedName(item.filename);
  if (!name) return null;
  const isOwnName = name.toLowerCase() === item.filename.toLowerCase();
  if (!isOwnName && !PAIR_SUFFIX.test(splitExt(item.filename)[0])) return null;
  const entries = await entriesOf(name);
  if (!entries) return null;
  const want = Number(expectedSize) > 0 ? Number(expectedSize) : null;
  for (const [entry, size] of entries) {
    const sameName = entry.toLowerCase() === item.filename.toLowerCase();
    if (want === null ? sameName && size > 0 : size === want && (sameName || isOwnName)) return name;
  }
  return null;
}
