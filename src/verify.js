// Checks that a downloaded file is the real archive and not an error page.
//
// For zips we look for the "end of central directory" record in the file's
// tail. It's written last, so a truncated or corrupted download won't have it.

import { open, stat } from 'node:fs/promises';
import { looksLikeHtml } from './http.js';

const EOCD_SIG = 0x06054b50;
const STL_HEADER = 80;
const STL_TRIANGLE = 50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

async function readRange(fh, position, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

function hasEocd(tail) {
  for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) return true;
  }
  return false;
}

// Binary STL: 80-byte header, uint32 triangle count, 50 bytes per triangle,
// so the exact length is known. ASCII STL starts with "solid" and ends with
// "endsolid". Either way a truncated download is caught.
async function checkStl(fh, size, head) {
  if (size >= STL_HEADER + 4) {
    const count = head.length >= STL_HEADER + 4 ? head.readUInt32LE(STL_HEADER) : -1;
    if (count >= 0 && STL_HEADER + 4 + count * STL_TRIANGLE === size) return null;
  }
  if (head.subarray(0, 5).toString('latin1').toLowerCase() === 'solid') {
    const tail = (await readRange(fh, Math.max(0, size - 256), Math.min(size, 256))).toString('latin1');
    if (/endsolid[^\n]*\s*$/i.test(tail)) return null;
    return 'STL is incomplete (no "endsolid")';
  }
  return 'STL is incomplete or damaged (length does not match its triangle count)';
}

/**
 * Returns { ok: true, bytes } or { ok: false, bytes, reason, html }.
 * `html: true` means we got a web page (Cloudflare challenge or login page),
 * which should pause the whole run rather than count as one bad file.
 */
export async function verifyDownload(file, { expectedSize, isZip, isStl }) {
  const { size } = await stat(file);
  const fh = await open(file, 'r');
  try {
    const head = await readRange(fh, 0, Math.min(size, 512));
    if (looksLikeHtml(head.toString('utf8'))) {
      return { ok: false, bytes: size, html: true, reason: 'Got a web page instead of the file (Cloudflare check or logged out?)' };
    }
    if (size === 0) return { ok: false, bytes: 0, reason: 'File is empty' };

    // Structural checks prove the file is complete on their own.
    let structurallySound = false;
    if (isZip) {
      if (!(head[0] === 0x50 && head[1] === 0x4b)) {
        return { ok: false, bytes: size, reason: 'Not a zip archive (bad header)' };
      }
      const tailLen = Math.min(size, EOCD_MIN + MAX_COMMENT);
      const tail = await readRange(fh, size - tailLen, tailLen);
      if (!hasEocd(tail)) {
        return { ok: false, bytes: size, reason: 'Zip is incomplete (no end-of-archive record)' };
      }
      structurallySound = true;
    }
    if (isStl) {
      const problem = await checkStl(fh, size, head);
      if (problem) return { ok: false, bytes: size, reason: problem };
      structurallySound = true;
    }

    // MMF's size data is occasionally wrong (seen: sizes swapped between files
    // of one model). A file that is structurally complete is accepted with a
    // note; anything else must match exactly.
    const want = Number(expectedSize);
    if (want > 0 && size !== want) {
      const reason = `Size mismatch: ${size} bytes, MMF says ${want}`;
      if (!structurallySound) return { ok: false, bytes: size, reason };
      return { ok: true, bytes: size, note: `${reason} (file is complete; MMF's listed size looks wrong)` };
    }
    return { ok: true, bytes: size };
  } finally {
    await fh.close();
  }
}
