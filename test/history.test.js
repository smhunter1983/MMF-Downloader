import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { readHistory } from '../src/history.js';

test('readHistory: newest first, labelled from the queue, junk skipped, limited', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mmf-hist-'));
  const log = path.join(dir, 'run-log.jsonl');
  const lines = [
    { t: '2026-10-28T01:00:00Z', type: 'start', files: 3, bytes: 99 },
    { t: '2026-10-28T01:01:00Z', type: 'fail', key: '5:1', reason: 'Chrome: SERVER_FAILED', status: 'pending' },
    'garbage {',
    { t: '2026-10-28T01:02:00Z', type: 'done', key: '5:1', bytes: 42, dest: 'Z:\\x' },
    { t: '2026-10-28T01:03:00Z', type: 'fail', key: 'gone:1', reason: 'bad', status: 'failed' },
    { t: '2026-10-28T01:04:00Z', type: 'something-else' },
  ].map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
  await writeFile(log, lines);
  const items = [{ key: '5:1', objectId: 5, objectName: 'Razoraptor', creator: 'Rescale Miniatures', filename: 'Razoraptor_Supports.zip' }];
  const ev = await readHistory(log, items);
  assert.deepEqual(ev.map((e) => e.type), ['fail', 'done', 'retry', 'start']);
  assert.equal(ev[0].file, 'gone:1', 'unknown keys still show');
  assert.deepEqual([ev[1].model, ev[1].file, ev[1].bytes, ev[1].objectId], ['Razoraptor', 'Razoraptor_Supports.zip', 42, 5]);
  assert.equal((await readHistory(log, items, { limit: 2 })).length, 2);
  assert.deepEqual(await readHistory(path.join(dir, 'missing.jsonl')), []);
});
