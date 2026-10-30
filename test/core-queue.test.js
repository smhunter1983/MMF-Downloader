// The download list's rules (shared core): keeping progress across syncs,
// the gap check against the archive folder, Get/Skip, batches, and the
// zip/STL checks. Ported from the 1.x bridge tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeQueue, setSkip, buildTree, startBatch, joinBatch, batchSummary, finishBatchIfDone, upcoming, summarize, STATUS,
} from '../extension/core/queue.js';
import { verifyBytes } from '../extension/core/zip.js';
import { memoryDisk, makeZip, makeStl } from './engine-fakes.js';

const reader = (b) => ({ size: b.byteLength, read: async (p, l) => b.subarray(p, p + l) });
const verify = (data, opts) => verifyBytes(reader(Buffer.from(data)), opts);
const binaryStl = (triangles, header = 'binary') => { const b = makeStl(triangles); b.write(header, 0, 'latin1'); return b; };

test('verify: complete zips pass, truncated ones fail, web pages are flagged', async () => {
  const zip = makeZip('a.stl', 'solid x');
  assert.deepEqual(await verify(zip, { expectedSize: zip.length, isZip: true }), { ok: true, bytes: zip.length });
  assert.match((await verify(zip.subarray(0, zip.length - 10), { isZip: true })).reason, /incomplete/);
  const off = await verify(zip, { expectedSize: 5, isZip: true });
  assert.equal(off.ok, true, 'complete zip accepted despite a wrong listed size');
  assert.match(off.note, /Size mismatch/);
  assert.match((await verify('%PDF-1.7 hello', { expectedSize: 5 })).reason, /Size mismatch/, 'no structural check: must match');
  assert.equal((await verify('<!DOCTYPE html><title>Just a moment...</title>', { isZip: true })).html, true);
  assert.equal((await verify('', {})).ok, false, 'empty');
});

test('verify: STL files that MMF lists without a size', async () => {
  const cases = {
    bin: [binaryStl(3), true],
    'bin with a "solid" header': [binaryStl(2, 'solid exported by X'), true],
    'bin cut short': [binaryStl(3).subarray(0, 150), false],
    ascii: [Buffer.from('solid cube\nfacet normal 0 0 1\nendfacet\nendsolid cube\n'), true],
    'ascii cut short': [Buffer.from('solid cube\nfacet normal 0 0 1\n'), false],
  };
  for (const [name, [data, ok]] of Object.entries(cases)) assert.equal((await verify(data, { expectedSize: null, isStl: true })).ok, ok, name);
  const swapped = await verify(binaryStl(10), { expectedSize: 99999, isStl: true });
  assert.equal(swapped.ok, true, "MMF's sizes swapped: a complete STL is still accepted");
  assert.match(swapped.note, /listed size looks wrong/);
});

test('sync keeps progress and marks files already in the archive as done', async () => {
  const disk = memoryDisk();
  disk.files.set('C/B/b.zip', Buffer.from('xxxx'));
  disk.files.set('C/B/c.zip', Buffer.from('short'));
  const planned = [
    { key: '1:1', objectId: 1, fileId: 1, filename: 'a.zip', size: 3, dest: ['C', 'B'] },
    { key: '1:2', objectId: 1, fileId: 2, filename: 'b.zip', size: 4, dest: ['C', 'B'] },
    { key: '1:3', objectId: 1, fileId: 3, filename: 'c.zip', size: 5, dest: ['C', 'B'] },
  ];
  const q = await mergeQueue({ items: [{ key: '1:1', status: 'failed', attempts: 3, error: 'boom' }, { key: '1:3', status: 'active' }] }, planned, disk);
  assert.deepEqual(q.items.map((i) => i.status), ['failed', 'done', 'done']);
});

test('sync moves filed files when their release folder gets a new name', async () => {
  const disk = memoryDisk();
  disk.files.set('C/Release 1/a.zip', Buffer.from('abc'));
  const existing = { items: [
    { key: '1:1', status: 'done', dest: ['C', 'Release 1'], filename: 'a.zip' },
    { key: '1:2', status: 'done', dest: ['C', 'Release 1'], filename: 'gone.zip' },
  ] };
  const planned = [
    { key: '1:1', objectId: 1, fileId: 1, filename: 'a.zip', size: 3, dest: ['C', '2024-10 - Hollow Graves'] },
    { key: '1:2', objectId: 1, fileId: 2, filename: 'gone.zip', size: 4, dest: ['C', '2024-10 - Hollow Graves'] },
  ];
  const q = await mergeQueue(existing, planned, disk);
  assert.equal(q.items[0].status, 'done');
  assert.equal(disk.files.get('C/2024-10 - Hollow Graves/a.zip').toString(), 'abc');
  assert.ok(!disk.files.has('C/Release 1/a.zip'));
  assert.equal(q.items[1].status, 'pending', 'a "done" file that vanished from disk is fetched again');
});

test('gap check: size-less files already filed stay done; verified sizes beat wrong listed ones', async () => {
  const disk = memoryDisk();
  disk.files.set('C/B/base.stl', binaryStl(1));
  let q = await mergeQueue({ items: [{ key: '9:1', status: 'done' }] }, [
    { key: '9:1', objectId: 9, fileId: 1, filename: 'base.stl', size: null, dest: ['C', 'B'] },
    { key: '9:2', objectId: 9, fileId: 2, filename: 'other.stl', size: null, dest: ['C', 'B'] },
  ], disk);
  assert.deepEqual(q.items.map((i) => i.status), ['done', 'pending']);

  disk.files.set('C/B/w.stl', binaryStl(10));
  const planned = [{ key: '1:1', objectId: 1, fileId: 1, filename: 'w.stl', size: 99999, dest: ['C', 'B'] }];
  q = await mergeQueue({ items: [{ key: '1:1', status: 'done', doneBytes: binaryStl(10).length }] }, planned, disk);
  assert.equal(q.items[0].status, 'done');
  q = await mergeQueue({ items: [{ key: '1:1', status: 'done', note: 'Size mismatch' }] }, planned, disk);
  assert.equal(q.items[0].status, 'done', 'older entries with a note also count');
  q = await mergeQueue({ items: [{ key: '1:1', status: 'done', doneBytes: 5 }] }, planned, disk);
  assert.equal(q.items[0].status, 'pending', 'file changed on disk since it was filed');
});

const ITEMS = [
  { key: '1:10', objectId: 1, fileId: 10, objectName: 'Obj', creator: 'Rescale', filename: 'A.zip', size: 10, dest: ['Rescale', 'HG'] },
  { key: '1:11', objectId: 1, fileId: 11, objectName: 'Obj', creator: 'Rescale', filename: 'B.zip', size: 20, dest: ['Rescale', 'HG'] },
  { key: '2:20', objectId: 2, fileId: 20, objectName: 'Solo Mini', creator: 'Rescale', filename: 'S.zip', size: 30, dest: ['Rescale', 'HG'] },
];

test('Get/Skip: per model, shown in the tree, and kept across syncs (new rows of a skipped model too)', async () => {
  const disk = memoryDisk();
  const q = await mergeQueue(null, ITEMS, disk);
  assert.equal(setSkip(q, [1], true), 2);
  const s = summarize(q);
  assert.deepEqual([s.total, s.skipped], [1, 2]);
  assert.deepEqual(buildTree(q)[0].bundles[0].objects.map((o) => [o.name, o.files, o.skip]), [['Obj', 2, true], ['Solo Mini', 1, false]]);
  const again = await mergeQueue(q, ITEMS, disk);
  assert.deepEqual(again.items.map((i) => i.skip), [true, true, false]);
  const whole = { key: '1:whole', objectId: 1, fileId: 'whole', objectName: 'Obj', creator: 'Rescale', filename: 'Obj.zip', size: null, dest: ['Rescale', 'HG'], wholeZip: true };
  assert.equal((await mergeQueue(q, [whole], disk)).items[0].skip, true, 'a skipped model stays skipped when its files change');
});

test('batches: Start opens one, mid-run selections join, it closes and resets when done', async () => {
  const q = await mergeQueue(null, ITEMS, memoryDisk());
  setSkip(q, [2], true);
  assert.equal(batchSummary(q), null);
  assert.equal(upcoming(q).files, 2, 'preview of the next batch');
  startBatch(q, Date.now());
  assert.deepEqual([batchSummary(q).done, batchSummary(q).total], [0, 2]);
  const done = (key) => { const i = q.items.find((x) => x.key === key); joinBatch(q, i); i.status = STATUS.DONE; };
  done('1:10');
  setSkip(q, [2], false);
  done('2:20'); // checked mid-run: joins the batch
  done('1:11');
  assert.deepEqual([batchSummary(q).done, batchSummary(q).total], [3, 3]);
  assert.equal(finishBatchIfDone(q, Date.now()), true);
  assert.equal(batchSummary(q), null, 'batch closed: the bar resets');
  assert.equal(q.lastBatch.files, 3);
  assert.equal(q.lastBatch.bytes, 60);
  assert.equal(summarize(q).done, 3, 'archive-wide count keeps everything');
});
