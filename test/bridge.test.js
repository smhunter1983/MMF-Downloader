import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBridge, isAllowedStagingPath } from '../src/bridge.js';
import { verifyDownload } from '../src/verify.js';
import { mergeQueue, saveQueue, loadQueue } from '../src/queue.js';

// A minimal valid "stored" zip containing one file.
function makeZip(name, content) {
  const data = Buffer.from(content);
  const fname = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(10, 4);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(fname.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(10, 6);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(fname.length, 28);
  const cdOffset = local.length + fname.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + fname.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, fname, data, central, fname, eocd]);
}

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mmf-br-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('verifyDownload accepts a real zip and rejects bad ones', async (t) => {
  const dir = await tempDir(t);
  const zip = makeZip('a.stl', 'solid x');
  const good = path.join(dir, 'good.zip');
  await writeFile(good, zip);
  assert.deepEqual(await verifyDownload(good, { expectedSize: zip.length, isZip: true }), { ok: true, bytes: zip.length });

  const truncated = path.join(dir, 't.zip');
  await writeFile(truncated, zip.subarray(0, zip.length - 10));
  assert.match((await verifyDownload(truncated, { isZip: true })).reason, /incomplete/);

  const off = await verifyDownload(good, { expectedSize: 5, isZip: true });
  assert.equal(off.ok, true, 'complete zip accepted despite a wrong listed size');
  assert.match(off.note, /Size mismatch/);
  const pdf = path.join(dir, 'x.pdf');
  await writeFile(pdf, '%PDF-1.7 hello');
  assert.match((await verifyDownload(pdf, { expectedSize: 5 })).reason, /Size mismatch/, 'no structural check: must match');

  const html = path.join(dir, 'h.zip');
  await writeFile(html, '<!DOCTYPE html><title>Just a moment...</title>');
  const v = await verifyDownload(html, { isZip: true });
  assert.equal(v.html, true);
});

test('isAllowedStagingPath only accepts the staged file for that item', () => {
  const cfg = { stagingFolderName: 'MMF-staging' };
  const item = { objectId: 5, fileId: 9, filename: 'x.zip' };
  const base = path.resolve('/Users/Sean/Downloads/MMF-staging');
  const item2 = { ...item, filename: 'Base: Tomb.ZIP' };
  assert.ok(isAllowedStagingPath(cfg, item2, path.join(base, '5_9.zip')));
  assert.ok(isAllowedStagingPath(cfg, item2, path.join(base, '5_9 (1).zip')));
  assert.ok(!isAllowedStagingPath(cfg, item2, path.join(base, '5_91.zip')), 'different file id');
  assert.ok(isAllowedStagingPath(cfg, item2, path.join(base, '5_9.html')), 'web page saved by Chrome is still checked');
  assert.ok(!isAllowedStagingPath(cfg, item2, path.join(base, '5_9.tar.gz')));
  assert.ok(!isAllowedStagingPath(cfg, item2, path.resolve('/Windows/System32/5_9.zip')));
  assert.ok(!isAllowedStagingPath(cfg, item2, 'relative/MMF-staging/5_9.zip'));
});

test('mergeQueue keeps progress and marks files already in the archive as done', async (t) => {
  const dir = await tempDir(t);
  const planned = [
    { key: '1:1', objectId: 1, fileId: 1, filename: 'a.zip', size: 3, dest: ['C', 'B'] },
    { key: '1:2', objectId: 1, fileId: 2, filename: 'b.zip', size: 4, dest: ['C', 'B'] },
    { key: '1:3', objectId: 1, fileId: 3, filename: 'c.zip', size: 5, dest: ['C', 'B'] },
  ];
  await mkdir(path.join(dir, 'C', 'B'), { recursive: true });
  await writeFile(path.join(dir, 'C', 'B', 'b.zip'), 'xxxx');
  await writeFile(path.join(dir, 'C', 'B', 'c.zip'), 'short');
  const existing = { items: [{ key: '1:1', status: 'failed', attempts: 3, error: 'boom' }, { key: '1:3', status: 'active' }] };
  const q = await mergeQueue(existing, planned, dir);
  assert.deepEqual(q.items.map((i) => i.status), ['failed', 'done', 'done']);
});

test('mergeQueue moves filed files when their folder name changes', async (t) => {
  const dir = await tempDir(t);
  await mkdir(path.join(dir, 'C', 'Release 1'), { recursive: true });
  await writeFile(path.join(dir, 'C', 'Release 1', 'a.zip'), 'abc');
  const existing = { items: [
    { key: '1:1', status: 'done', dest: ['C', 'Release 1'], filename: 'a.zip' },
    { key: '1:2', status: 'done', dest: ['C', 'Release 1'], filename: 'gone.zip' },
  ] };
  const planned = [
    { key: '1:1', objectId: 1, fileId: 1, filename: 'a.zip', size: 3, dest: ['C', '2024-10 - Hollow Graves'] },
    { key: '1:2', objectId: 1, fileId: 2, filename: 'gone.zip', size: 4, dest: ['C', '2024-10 - Hollow Graves'] },
  ];
  const q = await mergeQueue(existing, planned, dir);
  assert.equal(q.items[0].status, 'done');
  assert.equal(await readFile(path.join(dir, 'C', '2024-10 - Hollow Graves', 'a.zip'), 'utf8'), 'abc');
  assert.ok(!existsSync(path.join(dir, 'C', 'Release 1', 'a.zip')));
  assert.equal(q.items[1].status, 'pending', 'a "done" file that vanished from disk is fetched again');
});

// Drives the bridge over HTTP exactly like the extension does.
async function setupBridge(t, { items, cap = 10, onLibrary, reveal = () => {} } = {}) {
  const dir = await tempDir(t);
  const archive = path.join(dir, 'archive');
  const staging = path.join(dir, 'Downloads', 'MMF-staging');
  await mkdir(staging, { recursive: true });
  const queueFile = path.join(dir, 'queue.json');
  await saveQueue(await mergeQueue(null, items, archive), queueFile);
  const cfg = { archiveRoot: archive, stagingFolderName: 'MMF-staging', bridgePort: 0, maxDownloadsPerHour: cap };
  const bridge = createBridge(cfg, { queueFile, logFile: path.join(dir, 'log.jsonl'), log: () => {}, onLibrary, reveal });
  const port = await bridge.start();
  t.after(() => bridge.stop());
  const call = async (p, body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-MMF-Bridge': '1', Origin: 'chrome-extension://test', 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { dir, archive, staging, queueFile, call, bridge };
}

const zipA = makeZip('a.stl', 'model A');
const zipB = makeZip('b.stl', 'model B!');
const ITEMS = [
  { key: '1:10', objectId: 1, fileId: 10, objectName: 'Obj', creator: 'Rescale', url: 'https://x/1', filename: 'A.zip', size: zipA.length, dest: ['Rescale', '2024-10 - Hollow Graves'] },
  { key: '1:11', objectId: 1, fileId: 11, objectName: 'Obj', creator: 'Rescale', url: 'https://x/2', filename: 'B.zip', size: zipB.length, dest: ['Rescale', '2024-10 - Hollow Graves'] },
];

test('bridge rejects requests that are not from the extension', async (t) => {
  const { call } = await setupBridge(t, { items: ITEMS });
  assert.equal((await call('/status', undefined, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('/status', undefined, { 'X-MMF-Bridge': '0' })).status, 403);
  assert.equal((await call('/status')).status, 200);
  assert.equal((await call('/status', undefined, { Origin: '' })).status, 403, 'empty origin is not an extension');
});

test('bridge happy path: next -> report -> verified file filed in the archive', async (t) => {
  const { call, staging, archive, queueFile } = await setupBridge(t, { items: ITEMS });
  const n1 = (await call('/next', {})).body;
  assert.equal(n1.action, 'download');
  assert.equal(n1.item.filename, 'MMF-staging/1_10.zip');

  const staged = path.join(staging, '1_10.zip');
  await writeFile(staged, zipA);
  assert.deepEqual((await call('/report', { key: n1.item.key, ok: true, path: staged })).body, { ok: true });
  const filed = path.join(archive, 'Rescale', '2024-10 - Hollow Graves', 'A.zip');
  assert.deepEqual(await readFile(filed), zipA);
  assert.ok(!existsSync(staged), 'staging copy removed');

  const n2 = (await call('/next', {})).body;
  await writeFile(path.join(staging, '1_11.zip'), zipB);
  await call('/report', { key: n2.item.key, ok: true, path: path.join(staging, '1_11.zip') });
  assert.equal((await call('/next', {})).body.action, 'done');

  const q = await loadQueue(queueFile);
  assert.deepEqual(q.items.map((i) => i.status), ['done', 'done']);
  const st = (await call('/status')).body;
  assert.equal(st.summary.done, 2);
});

test('bridge pauses on a Cloudflare page and keeps the item for later', async (t) => {
  const { call, staging } = await setupBridge(t, { items: ITEMS });
  const n = (await call('/next', {})).body;
  const staged = path.join(staging, '1_10.html');
  await writeFile(staged, '<!DOCTYPE html><title>Just a moment...</title>');
  const r = (await call('/report', { key: n.item.key, ok: true, path: staged })).body;
  assert.equal(r.paused, true);
  assert.ok(!existsSync(staged));
  assert.equal((await call('/next', {})).body.action, 'paused');

  await call('/resume', {});
  const again = (await call('/next', {})).body;
  assert.equal(again.item.key, '1:10', 'same file retried, attempt not counted');
});

test('bridge retries a corrupt file, then gives up after 3 attempts', async (t) => {
  const { call, staging } = await setupBridge(t, { items: [ITEMS[0]] });
  for (let i = 0; i < 3; i++) {
    const n = (await call('/next', {})).body;
    assert.equal(n.action, 'download');
    const staged = path.join(staging, '1_10.zip');
    await writeFile(staged, zipA.subarray(0, 20));
    await call('/report', { key: n.item.key, ok: true, path: staged });
  }
  assert.equal((await call('/next', {})).body.action, 'done');
  const st = (await call('/status')).body;
  assert.equal(st.summary.failed, 1);
  assert.equal((await call('/retry-failed', {})).body.requeued, 1);
  assert.equal((await call('/next', {})).body.action, 'download');
});

test('bridge pauses when Chrome reports MMF refused the download', async (t) => {
  const { call } = await setupBridge(t, { items: ITEMS });
  const n = (await call('/next', {})).body;
  const r = (await call('/report', { key: n.item.key, ok: false, error: 'SERVER_FORBIDDEN' })).body;
  assert.equal(r.paused, true);
  assert.equal((await call('/status')).body.summary.failed, 0);
});

test('bridge refuses a reported path outside the staging folder', async (t) => {
  const { call, dir } = await setupBridge(t, { items: ITEMS });
  const n = (await call('/next', {})).body;
  const victim = path.join(dir, 'important.txt');
  await writeFile(victim, 'do not move me');
  const r = await call('/report', { key: n.item.key, ok: true, path: victim });
  assert.equal(r.body.ok, false);
  assert.ok(existsSync(victim));
});

test('bridge enforces the hourly cap', async (t) => {
  const { call } = await setupBridge(t, { items: ITEMS, cap: 1 });
  assert.equal((await call('/next', {})).body.action, 'download');
  // The first item is abandoned (no report); the cap still counts it.
  const w = (await call('/next', {})).body;
  assert.equal(w.action, 'wait');
  assert.ok(w.ms > 59 * 60 * 1000);
});

test('bridge picks up a queue rewritten by plan, keeping the in-flight file', async (t) => {
  const { call, queueFile, staging, archive } = await setupBridge(t, { items: ITEMS });
  const n = (await call('/next', {})).body;
  // "plan" runs meanwhile and rewrites the queue (in-flight item reset to pending).
  await new Promise((r) => setTimeout(r, 20));
  const fresh = await mergeQueue(null, [...ITEMS, { ...ITEMS[1], key: '2:20', objectId: 2, fileId: 20, filename: 'C.zip' }], archive);
  await saveQueue(fresh, queueFile);
  const staged = path.join(staging, '1_10.zip');
  await writeFile(staged, zipA);
  assert.deepEqual((await call('/report', { key: n.item.key, ok: true, path: staged })).body, { ok: true });
  const st = (await call('/status')).body;
  assert.equal(st.summary.total, 3, 'new plan was loaded');
  assert.equal(st.summary.done, 1, 'in-flight file still counted');
});

test('bridge passes library syncs to the handler', async (t) => {
  let got;
  const { call } = await setupBridge(t, { items: ITEMS, onLibrary: async (b) => { got = b; return { objects: 1, releases: 2 }; } });
  const r = await call('/library', { objectPreviews: [{ originalId: 1 }], releases: { 5: { label: 'x' } } });
  assert.deepEqual(r.body, { ok: true, objects: 1, releases: 2 });
  assert.equal(got.objectPreviews.length, 1);
});

test('bridge starts without a queue and says so', async (t) => {
  const dir = await tempDir(t);
  const bridge = createBridge({ archiveRoot: dir, stagingFolderName: 'MMF-staging', bridgePort: 0, maxDownloadsPerHour: 5 },
    { queueFile: path.join(dir, 'none.json'), logFile: path.join(dir, 'l'), log: () => {} });
  const port = await bridge.start();
  t.after(() => bridge.stop());
  const res = await fetch(`http://127.0.0.1:${port}/next`, { method: 'POST', headers: { 'X-MMF-Bridge': '1' }, body: '{}' });
  const body = await res.json();
  assert.equal(body.action, 'done');
  assert.match(body.reason, /plan/);
});

test('skipped objects are never handed out and survive a re-plan', async (t) => {
  const items = [
    ...ITEMS,
    { key: '2:20', objectId: 2, fileId: 20, objectName: 'Solo Mini', creator: 'Rescale', url: 'u', filename: 'S.zip', size: 9, dest: ['Rescale', '2024-10 - Hollow Graves'] },
  ];
  const { call, queueFile, archive } = await setupBridge(t, { items });
  const r = (await call('/skip', { objectIds: [1], skip: true })).body;
  assert.equal(r.changed, 2);
  assert.equal(r.summary.total, 1);
  assert.equal(r.summary.skipped, 2);

  const tree = (await call('/tree')).body.tree;
  assert.equal(tree[0].name, 'Rescale');
  const objs = tree[0].bundles[0].objects;
  assert.deepEqual(objs.map((o) => [o.name, o.files, o.skip]), [['Obj', 2, true], ['Solo Mini', 1, false]]);

  assert.equal((await call('/next', {})).body.item.key, '2:20', 'skipped object passed over');

  const replanned = await mergeQueue(await loadQueue(queueFile), items, archive);
  assert.deepEqual(replanned.items.map((i) => i.skip), [true, true, false]);

  assert.equal((await call('/skip', { objectIds: 'nope', skip: true })).body.ok, false);
});

function binaryStl(triangles, headerText = 'binary') {
  const buf = Buffer.alloc(84 + triangles * 50);
  buf.write(headerText, 0, 'latin1');
  buf.writeUInt32LE(triangles, 80);
  return buf;
}

test('verifyDownload checks STL files that MMF lists without a size', async (t) => {
  const dir = await tempDir(t);
  const cases = {
    'bin.stl': [binaryStl(3), true],
    'bin-solid-header.stl': [binaryStl(2, 'solid exported by X'), true],
    'bin-cut.stl': [binaryStl(3).subarray(0, 150), false],
    'ascii.stl': [Buffer.from('solid cube\nfacet normal 0 0 1\nendfacet\nendsolid cube\n'), true],
    'ascii-cut.stl': [Buffer.from('solid cube\nfacet normal 0 0 1\n'), false],
  };
  for (const [name, [data, ok]] of Object.entries(cases)) {
    const f = path.join(dir, name);
    await writeFile(f, data);
    assert.equal((await verifyDownload(f, { expectedSize: null, isStl: true })).ok, ok, name);
  }
  const empty = path.join(dir, 'empty.lys');
  await writeFile(empty, '');
  assert.equal((await verifyDownload(empty, {})).ok, false);
});

test('gap check keeps size-less files that are already filed', async (t) => {
  const dir = await tempDir(t);
  await mkdir(path.join(dir, 'C', 'B'), { recursive: true });
  await writeFile(path.join(dir, 'C', 'B', 'base.stl'), binaryStl(1));
  const planned = [{ key: '9:1', objectId: 9, fileId: 1, filename: 'base.stl', size: null, dest: ['C', 'B'] },
    { key: '9:2', objectId: 9, fileId: 2, filename: 'other.stl', size: null, dest: ['C', 'B'] }];
  const q = await mergeQueue({ items: [{ key: '9:1', status: 'done' }] }, planned, dir);
  assert.deepEqual(q.items.map((i) => i.status), ['done', 'pending']);
});

test('MMF size swap: complete STLs are accepted with a note', async (t) => {
  const dir = await tempDir(t);
  const f = path.join(dir, 'wendigo-base-corpse.stl');
  await writeFile(f, binaryStl(10));
  const v = await verifyDownload(f, { expectedSize: 99999, isStl: true });
  assert.equal(v.ok, true);
  assert.match(v.note, /MMF's listed size looks wrong/);
  await writeFile(f, binaryStl(10).subarray(0, 300));
  assert.equal((await verifyDownload(f, { expectedSize: 99999, isStl: true })).ok, false, 'truncated still fails');
});

test('gap check trusts the verified size when MMF lists a wrong one', async (t) => {
  const dir = await tempDir(t);
  await mkdir(path.join(dir, 'C', 'B'), { recursive: true });
  await writeFile(path.join(dir, 'C', 'B', 'w.stl'), binaryStl(10));
  const planned = [{ key: '1:1', objectId: 1, fileId: 1, filename: 'w.stl', size: 99999, dest: ['C', 'B'] }];
  const filedBytes = binaryStl(10).length;
  let q = await mergeQueue({ items: [{ key: '1:1', status: 'done', doneBytes: filedBytes }] }, planned, dir);
  assert.equal(q.items[0].status, 'done');
  q = await mergeQueue({ items: [{ key: '1:1', status: 'done', note: 'Size mismatch' }] }, planned, dir);
  assert.equal(q.items[0].status, 'done', 'older entries with a note also count');
  q = await mergeQueue({ items: [{ key: '1:1', status: 'done', doneBytes: 5 }] }, planned, dir);
  assert.equal(q.items[0].status, 'pending', 'file changed on disk since it was filed');
});

test('reveal opens only paths inside the archive that it built itself', async (t) => {
  const opened = [];
  const { call, staging, archive } = await setupBridge(t, { items: ITEMS, reveal: (p, o) => opened.push([p, o.select]) });
  assert.equal((await call('/reveal', { objectId: 1 })).body.ok, false, 'nothing downloaded yet');
  const n = (await call('/next', {})).body;
  await writeFile(path.join(staging, '1_10.zip'), zipA);
  await call('/report', { key: n.item.key, ok: true, path: path.join(staging, '1_10.zip') });

  assert.equal((await call('/reveal', { objectId: 1 })).body.ok, true);
  assert.equal((await call('/reveal', { creator: 'Rescale', bundle: '2024-10 - Hollow Graves' })).body.ok, true);
  assert.equal((await call('/reveal', { creator: 'Rescale' })).body.ok, true);
  assert.deepEqual(opened, [
    [path.join(archive, 'Rescale', '2024-10 - Hollow Graves', 'A.zip'), true],
    [path.join(archive, 'Rescale', '2024-10 - Hollow Graves'), false],
    [path.join(archive, 'Rescale'), false],
  ]);
  assert.equal((await call('/reveal', { creator: '..' })).body.ok, false, 'unknown creator');
  assert.equal((await call('/reveal', { path: 'C:\\Windows' })).body.ok, false, 'paths are never taken from the request');
  assert.equal(opened.length, 3);
});

test('whole-model zip: inherits Skip, and sets the loose parts aside after filing', async (t) => {
  const zipW = makeZip('w.stl', 'whole model');
  const whole = { key: '7:whole', objectId: 7, fileId: 'whole', objectName: 'Wendigo', creator: 'Rescale', url: 'u',
    filename: 'Wendigo.zip', size: null, dest: ['Rescale', 'Free Downloads'], wholeZip: true, replaces: ['a.stl', 'b.stl'] };
  const { call, staging, archive, queueFile } = await setupBridge(t, { items: [whole] });

  const before = await mergeQueue({ items: [{ key: '7:1', objectId: 7, skip: true }, { key: '7:2', objectId: 7, skip: true }] }, [whole], archive);
  assert.equal(before.items[0].skip, true, 'skipped model stays skipped');
  const fresh = await mergeQueue({ items: [{ key: '7:1', objectId: 7, skip: false }] }, [whole], archive);
  assert.equal(fresh.items[0].skip, false);

  await mkdir(path.join(archive, 'Rescale', 'Free Downloads'), { recursive: true });
  await writeFile(path.join(archive, 'Rescale', 'Free Downloads', 'a.stl'), 'loose a');
  await writeFile(path.join(archive, 'Rescale', 'Free Downloads', 'b.stl'), 'loose b');

  const n = (await call('/next', {})).body;
  assert.equal(n.item.filename, 'MMF-staging/7_whole.zip');
  await writeFile(path.join(staging, '7_whole.zip'), zipW);
  assert.equal((await call('/report', { key: n.item.key, ok: true, path: path.join(staging, '7_whole.zip') })).body.ok, true);

  const folder = await import('node:fs/promises').then((fs) => fs.readdir(path.join(archive, 'Rescale', 'Free Downloads')));
  assert.deepEqual(folder, ['Wendigo.zip']);
  assert.equal(await readFile(path.join(archive, '_to_delete', 'Rescale', 'Free Downloads', 'a.stl'), 'utf8'), 'loose a');
  const q = await loadQueue(queueFile);
  assert.deepEqual(q.items[0].setAside, ['a.stl', 'b.stl']);
});

test('bridge defaults to the real queue path (as "node mmf.js serve" starts it)', async () => {
  const src = await readFile(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.match(src, /queueFile = QUEUE_PATH/, 'queueFile must default to QUEUE_PATH, or reloads silently stop working');
});

test('pinWindow validates the title and only runs a fixed script on Windows', async () => {
  const { pinWindow } = await import('../src/pin.js');
  const calls = [];
  const run = (cmd, args, opts, cb) => { calls.push({ cmd, args, env: opts.env }); cb(null, 'OK'); };
  assert.equal((await pinWindow('MMF Downloader; rm -rf', true, { platform: 'win32', run })).ok, false);
  assert.equal((await pinWindow('MMF-PIN-abc12345', true, { platform: 'darwin', run })).ok, false);
  assert.equal(calls.length, 0);
  assert.deepEqual(await pinWindow('MMF-PIN-abc12345', true, { platform: 'win32', run }), { ok: true });
  assert.equal(calls[0].env.MMF_PIN_TITLE, 'MMF-PIN-abc12345');
  assert.equal(calls[0].env.MMF_PIN_ON, '1');
  assert.ok(!calls[0].args.join(' ').includes('abc12345'), 'title never pasted into the script');
  const notFound = (c, a, o, cb) => cb(null, 'NOT_FOUND');
  assert.equal((await pinWindow('MMF-PIN-abc12345', false, { platform: 'win32', run: notFound })).ok, false);
});

test('batches: Start opens one, mid-run selections join, it closes and resets when done', async (t) => {
  const items = [...ITEMS, { key: '2:20', objectId: 2, fileId: 20, objectName: 'Solo', creator: 'Rescale', url: 'u', filename: 'S.zip', size: zipA.length, dest: ['Rescale', 'X'] }];
  const { call, staging } = await setupBridge(t, { items });
  await call('/skip', { objectIds: [2], skip: true });
  let st = (await call('/status')).body;
  assert.equal(st.batch, null);
  assert.equal(st.upcoming.files, 2, 'preview of the next batch');

  await call('/resume', {});
  st = (await call('/status')).body;
  assert.deepEqual([st.batch.done, st.batch.total], [0, 2]);

  const deliver = async (n, data) => {
    const f = path.join(staging, `${n.item.key.replace(':', '_')}.zip`);
    await writeFile(f, data);
    return call('/report', { key: n.item.key, ok: true, path: f });
  };
  await deliver((await call('/next', {})).body, zipA);
  await call('/skip', { objectIds: [2], skip: false }); // checked mid-run: joins the batch
  await deliver((await call('/next', {})).body, zipB);
  await deliver((await call('/next', {})).body, zipA);
  st = (await call('/status')).body;
  assert.deepEqual([st.batch.done, st.batch.total], [3, 3]);

  assert.equal((await call('/next', {})).body.action, 'done');
  st = (await call('/status')).body;
  assert.equal(st.batch, null, 'batch closed: the bar resets');
  assert.equal(st.lastBatch.files, 3);
  assert.equal(st.lastBatch.bytes, zipA.length * 2 + zipB.length);
  assert.equal(st.upcoming.files, 0);
  assert.equal(st.summary.done, 3, 'archive-wide count keeps everything');
});
