// Recent activity for the dashboard's History panel, read from the bridge's
// append-only run log (data/run-log.jsonl): downloads finished or failed,
// pauses, and batches started/finished. Newest first.

import { open, stat } from 'node:fs/promises';

const MAX_READ = 8 * 1024 * 1024; // the tail is plenty for a short history
const TYPES = new Set(['done', 'fail', 'pause', 'start', 'batch', 'hold']);

export async function readHistory(logFile, items = [], { limit = 10000 } = {}) {
  let text = '';
  try {
    const { size } = await stat(logFile);
    const from = Math.max(0, size - MAX_READ);
    const fh = await open(logFile, 'r');
    try {
      const buf = Buffer.alloc(size - from);
      await fh.read(buf, 0, buf.length, from);
      text = buf.toString('utf8');
      if (from > 0) text = text.slice(text.indexOf('\n') + 1); // drop the partial first line
    } finally {
      await fh.close();
    }
  } catch {
    return [];
  }
  const byKey = new Map(items.map((i) => [i.key, i]));
  const out = [];
  const lines = text.split('\n');
  for (let n = lines.length - 1; n >= 0 && out.length < limit; n--) {
    let e;
    try { e = JSON.parse(lines[n]); } catch { continue; }
    if (!e || !TYPES.has(e.type) || typeof e.t !== 'string') continue;
    const item = e.key ? byKey.get(e.key) : null;
    out.push({
      t: e.t,
      type: e.type === 'fail' && e.status !== 'failed' ? 'retry' : e.type,
      creator: item?.creator ?? null,
      model: item?.objectName ?? null,
      file: item?.filename ?? e.key ?? null,
      objectId: item?.objectId ?? null,
      bytes: e.bytes ?? null,
      files: e.files ?? null,
      failed: e.failed ?? null,
      reason: e.reason ?? e.note ?? null,
      until: e.until ?? null,
    });
  }
  return out;
}
