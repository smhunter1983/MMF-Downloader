import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeQueue, buildTree, newestSeen } from '../extension/core/queue.js';
import { memoryDisk } from './engine-fakes.js';

const item = (objectId, fileId, extra = {}) => ({
  key: `${objectId}:${fileId}`, objectId, fileId, objectName: `Model ${objectId}`, creator: 'C',
  filename: `m${objectId}_${fileId}.zip`, size: 10, dest: ['C', 'R'], ...extra,
});
const objs = (q) => Object.fromEntries(buildTree(q)[0].bundles[0].objects.map((o) => [o.id, o]));

test('NEW: first plan is the baseline; later syncs flag only models never seen before', async () => {
  const root = memoryDisk();
  const t1 = Date.parse('2026-10-01T00:00:00Z');
  const t2 = Date.parse('2026-11-01T00:00:00Z');
  const t3 = Date.parse('2026-12-01T00:00:00Z');

  const q1 = await mergeQueue(null, [item(1, 1), item(2, 1)], root, t1);
  assert.equal(newestSeen(q1), null);
  assert.ok(Object.values(objs(q1)).every((o) => !o.isNew), 'nothing is new on the first plan');

  // November: model 3 appears; model 2 gains a file (an update, not a new model).
  const q2 = await mergeQueue(q1, [item(1, 1), item(2, 1), item(2, 2), item(3, 1)], root, t2);
  assert.equal(newestSeen(q2), new Date(t2).toISOString());
  let o = objs(q2);
  assert.equal(o[3].isNew, true);
  assert.equal(o[2].isNew, false, 'a new file in a known model is not a new model');
  assert.equal(o[1].isNew, false);

  // A sync with nothing new keeps November's badges.
  const q3 = await mergeQueue(q2, [item(1, 1), item(2, 1), item(2, 2), item(3, 1)], root, t3);
  assert.equal(objs(q3)[3].isNew, true);

  // December: model 4 arrives; now only it is new.
  const q4 = await mergeQueue(q3, [item(1, 1), item(2, 1), item(2, 2), item(3, 1), item(4, 1)], root, t3);
  o = objs(q4);
  assert.equal(o[4].isNew, true);
  assert.equal(o[3].isNew, false);
});

test('NEW goes away once the model is downloaded', async () => {
  const disk = memoryDisk();
  const q1 = await mergeQueue(null, [item(1, 1)], disk, Date.parse('2026-10-01'));
  const q2 = await mergeQueue(q1, [item(1, 1), item(5, 1), item(5, 2)], disk, Date.parse('2026-11-01'));
  assert.equal(objs(q2)[5].isNew, true);
  q2.items.find((i) => i.key === '5:1').status = 'done';
  assert.equal(objs(q2)[5].isNew, true, 'partly downloaded: still new');
  q2.items.find((i) => i.key === '5:2').status = 'done';
  assert.equal(objs(q2)[5].isNew, false, 'downloaded: no longer new');
});
