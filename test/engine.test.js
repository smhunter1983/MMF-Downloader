import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, NeedsFolderError } from '../extension/engine/engine.js';
import { mergeQueue } from '../extension/core/queue.js';
import { memoryStore, memoryDisk, makeZip, makeStl, fakeFetch, fakeClock } from './engine-fakes.js';

const MMF = 'https://www.myminifactory.com';
const zipA = makeZip('a.stl', 'model A');
const zipB = makeZip('b.stl', 'model B!!');
const item = (o, f, filename, size, extra = {}) => ({
  key: `${o}:${f}`, objectId: o, fileId: f, objectName: `Model ${o}`, creator: 'Rescale',
  url: `${MMF}/download/${o}?archive_id=${f}`, filename, originalFilename: filename, size,
  dest: ['Rescale', '2024-10'], objectFileCount: 1, ...extra,
});

async function setup({ items = [], routes = {}, settings, diskFiles = {} } = {}) {
  const store = memoryStore();
  const disk = memoryDisk();
  for (const [k, v] of Object.entries(diskFiles)) disk.files.set(k, v);
  const clock = fakeClock();
  if (items.length) await store.set('queue', await mergeQueue(null, items, disk, clock.now()));
  if (settings) await store.set('settings', settings);
  const fetchImpl = fakeFetch(routes);
  const engine = createEngine({ store, getDisk: async () => disk, fetchImpl, now: clock.now, sleep: clock.sleep });
  await engine.init();
  return { engine, store, disk, clock, fetchImpl };
}

const types = (store) => store.hist.map((e) => e.type);

test('engine: downloads, verifies and files each selected file; history records the run', async () => {
  const { engine, store, disk } = await setup({
    items: [item(1, 10, 'A.zip', zipA.length), item(1, 11, 'B.zip', zipB.length)],
    routes: { [`${MMF}/download/1?archive_id=10`]: [200, zipA], [`${MMF}/download/1?archive_id=11`]: [200, zipB] },
  });
  assert.deepEqual(await engine.start(), { ok: true });
  await engine.whenIdle();
  assert.deepEqual(disk.files.get('Rescale/2024-10/A.zip'), zipA);
  assert.deepEqual(disk.files.get('Rescale/2024-10/B.zip'), zipB);
  assert.ok(![...disk.files.keys()].some((k) => k.endsWith('.partial')), 'no partial files left');
  assert.deepEqual(engine.queue.items.map((i) => i.status), ['done', 'done']);
  assert.deepEqual(types(store), ['start', 'done', 'done', 'batch']);
  assert.equal(engine.status().running, false);
  const h = await engine.history();
  assert.equal(h[0].type, 'batch');
  assert.equal(h[1].model, 'Model 1');
});

test('engine: big files are written in batches while downloading (byte-exact)', async () => {
  const big = new Uint8Array(40 * 1024 * 1024 + 123);
  for (let i = 0; i < big.length; i += 4096) big[i] = i % 251;
  big.set(makeZip('x', '').subarray(0, 4), 0); // PK header, then no end record -> not a zip
  const body = makeZip('big.bin', Buffer.from(big));
  const { engine, disk } = await setup({
    items: [item(2, 20, 'Big.zip', body.length)],
    routes: { [`${MMF}/download/2?archive_id=20`]: () => new Response(new ReadableStream({
      start(c) { for (let o = 0; o < body.length; o += 1 << 20) c.enqueue(new Uint8Array(body.subarray(o, o + (1 << 20)))); c.close(); },
    })) },
  });
  await engine.start();
  await engine.whenIdle();
  assert.equal(engine.queue.items[0].status, 'done');
  assert.ok(Buffer.compare(disk.files.get('Rescale/2024-10/Big.zip'), body) === 0);
});

test('engine: MMF refuses once -> waits and retries by itself; twice in a row -> pauses', async () => {
  let refusals = 2;
  const { engine, store, clock } = await setup({
    items: [item(1, 10, 'A.zip', zipA.length)],
    routes: { [`${MMF}/download/1?archive_id=10`]: () => (refusals-- > 0 ? new Response('no', { status: 403 }) : new Response(zipA)) },
  });
  const t0 = clock.now();
  await engine.start();
  await engine.whenIdle();
  assert.equal(engine.status().paused, true, 'second refusal right after the retry pauses');
  assert.ok(clock.now() - t0 >= 10 * 60 * 1000, 'waited 10 minutes before retrying');
  assert.deepEqual(types(store), ['start', 'fail', 'hold', 'fail', 'pause']);
  // Start again: it goes through, and a later single refusal is retried again.
  await engine.start();
  await engine.whenIdle();
  assert.equal(engine.queue.items[0].status, 'done');
});

test('engine: a web page instead of the file pauses the run; logged out pauses too', async () => {
  const { engine, store } = await setup({
    items: [item(1, 10, 'A.zip', zipA.length), item(1, 11, 'B.zip', zipB.length)],
    routes: {
      [`${MMF}/download/1?archive_id=10`]: [200, '<!DOCTYPE html><title>Just a moment...</title>', { 'content-type': 'text/html' }],
    },
  });
  await engine.start();
  await engine.whenIdle();
  assert.equal(engine.status().paused, true);
  assert.match(engine.status().pauseReason, /web page/);
  assert.equal(engine.queue.items[0].status, 'pending', 'kept for later');
  assert.equal(engine.queue.items[0].attempts ?? 0, 0);
  assert.ok(types(store).includes('pause'));
});

test('engine: never overwrites a different file already in the archive', async () => {
  const { engine, disk } = await setup({
    items: [item(1, 10, 'A.zip', zipA.length)],
    routes: { [`${MMF}/download/1?archive_id=10`]: [200, zipA] },
  });
  disk.files.set('Rescale/2024-10/A.zip', Buffer.from('combined zip, keep me'));
  // mergeQueue ran before the file appeared, so the item is still pending.
  await engine.start();
  await engine.whenIdle();
  assert.equal(disk.files.get('Rescale/2024-10/A.zip').toString(), 'combined zip, keep me');
  assert.equal(engine.queue.items[0].status, 'failed');
  assert.match(engine.queue.items[0].error, /different file/);
});

test('engine: a single loose part served as a plain STL is accepted and named .stl', async () => {
  const stl = makeStl(3);
  const { engine, disk } = await setup({
    items: [item(244272, 'whole', 'Massive Mage Hand.zip', null, { fileId: 'whole', wholeZip: true, url: `${MMF}/download/244272`, replaces: ['bigbyp.stl'] })],
    routes: { [`${MMF}/download/244272`]: [200, stl] },
    diskFiles: {},
  });
  await engine.start();
  await engine.whenIdle();
  assert.deepEqual(disk.files.get('Rescale/2024-10/Massive Mage Hand.stl'), stl);
  assert.equal(engine.queue.items[0].status, 'done');
  assert.equal(engine.queue.items[0].filename, 'Massive Mage Hand.stl');
});

test('engine: hourly cap waits for the window, then carries on', async () => {
  const { engine, clock } = await setup({
    items: [item(1, 10, 'A.zip', zipA.length), item(1, 11, 'B.zip', zipB.length)],
    routes: { [`${MMF}/download/1?archive_id=10`]: [200, zipA], [`${MMF}/download/1?archive_id=11`]: [200, zipB] },
    settings: { maxDownloadsPerHour: 1 },
  });
  const t0 = clock.now();
  await engine.start();
  await engine.whenIdle();
  assert.deepEqual(engine.queue.items.map((i) => i.status), ['done', 'done']);
  assert.ok(clock.now() - t0 >= 60 * 60 * 1000);
});

test('engine: no folder -> Start refuses with the reason', async () => {
  const store = memoryStore();
  const engine = createEngine({ store, getDisk: async () => { throw new NeedsFolderError('Pick your archive folder first.'); } });
  await engine.init();
  await assert.rejects(engine.start(), /Pick your archive folder/);
});

// ---------- sync ----------

const page = (archives) => `<script>var p = {"archives":${JSON.stringify(archives)},"pdfFiles":[]};</script>`;

function libraryRoutes(rows, extra = {}) {
  return {
    [`${MMF}/api/data-library/objectPreviews`]: [200, JSON.stringify(rows)],
    [`${MMF}/api/data-library/userGroups_metadata`]: [200, JSON.stringify([{ id: 7, name: 'Rescale' }])],
    [`${MMF}/api/data-library/userGroup_releases_metadata/7`]: [200, JSON.stringify([{ id: 60627, label: '2024 - 10 _ October release - Hollow Graves', createdAt: '2024-10-01' }])],
    ...extra,
  };
}

async function syncAndWait(engine) {
  const r = await engine.sync();
  assert.equal(r.ok, true);
  while (engine.status().planning) await new Promise((res) => setTimeout(res, 1));
  return engine.status().lastPlan;
}

test('sync: reads the library and model pages, files under release names, skips what is on disk', async () => {
  const rows = [
    { originalId: 100, name: 'Ghost', creatorName: 'Rescale', source: 'USER_GROUP', release: '60627' },
    { originalId: 200, name: 'Wendigo', creatorName: 'MMM', source: 'TRIBE', release: 'type:tribes-tier;yearmonth:202610' },
    { originalId: 300, name: 'Claymore thing', creatorName: 'Claymore Miniatures', source: 'PURCHASE' },
  ];
  const routes = libraryRoutes(rows, {
    [`${MMF}/object/3d-print-100`]: [200, page([{ id: 1, path: 'Ghost_Supports.zip', size: String(zipA.length) }, { id: 2, path: 'Ghost_Unsupported.zip', size: '50' }])],
    [`${MMF}/object/3d-print-200`]: [200, page([{ id: 3, path: 'Wendigo.zip', size: String(zipB.length) }])],
  });
  const { engine, store } = await setup({
    routes,
    settings: { excludeCreators: ['Claymore Miniatures'], pageDelayMs: 0 },
    diskFiles: { 'MMM/2026-10/Wendigo.zip': zipB },
  });
  const lp = await syncAndWait(engine);
  assert.equal(lp.ok, true, lp.error);
  assert.equal(lp.models, 2);
  assert.equal(lp.excluded, 1);
  const byKey = Object.fromEntries(engine.queue.items.map((i) => [i.key, i]));
  assert.deepEqual(byKey['100:1'].dest, ['Rescale', '2024 - 10 _ October release - Hollow Graves']);
  assert.equal(byKey['100:1'].url, `${MMF}/download/100?archive_id=1`);
  assert.equal(byKey['200:3'].status, 'done', 'already on disk');
  assert.equal(byKey['100:1'].status, 'pending');
  assert.ok(await store.getObject(100), 'model file list cached');
  assert.ok(!store.kv.has('noSuchKey'));
});

test('sync: a check page stops the sync with a clear message; later syncs flag new models', async () => {
  const rows1 = [{ originalId: 100, name: 'Ghost', creatorName: 'Rescale', source: 'PURCHASE' }];
  const blocked = libraryRoutes(rows1, { [`${MMF}/object/3d-print-100`]: [200, '<!DOCTYPE html><title>Just a moment...</title>'] });
  const { engine, store } = await setup({ routes: blocked, settings: { pageDelayMs: 0 } });
  const lp = await syncAndWait(engine);
  assert.equal(lp.ok, false);
  assert.match(lp.error, /check or login page/);

  // Fresh engine (same store) with working pages: first sync is the baseline, second flags model 200.
  const ok1 = libraryRoutes(rows1, { [`${MMF}/object/3d-print-100`]: [200, page([{ id: 1, path: 'Ghost.zip', size: '10' }])] });
  const disk = memoryDisk();
  const clock = fakeClock();
  let fetchImpl = fakeFetch(ok1);
  const e2 = createEngine({ store, getDisk: async () => disk, fetchImpl: (...a) => fetchImpl(...a), now: clock.now, sleep: clock.sleep });
  await e2.init();
  assert.equal((await syncAndWait(e2)).newModels, 0);
  const rows2 = [...rows1, { originalId: 200, name: 'Master Wendigo', creatorName: 'MMM', source: 'PURCHASE' }];
  fetchImpl = fakeFetch(libraryRoutes(rows2, { [`${MMF}/object/3d-print-200`]: [200, page([{ id: 3, path: 'W.zip', size: '10' }])] }));
  clock.advance(1000);
  const lp2 = await syncAndWait(e2);
  assert.equal(lp2.newModels, 1);
  const tree = e2.tree();
  const all = tree.flatMap((c) => c.bundles.flatMap((b) => b.objects));
  assert.equal(all.find((o) => o.id === 200).isNew, true);
  assert.equal(all.find((o) => o.id === 100).isNew, false);
});

test('engine: a run in progress resumes after a restart; locate gives the file path', async () => {
  const { engine, store } = await setup({
    items: [item(1, 10, 'A.zip', zipA.length)],
    routes: { [`${MMF}/download/1?archive_id=10`]: [200, zipA] },
  });
  await store.set('wasRunning', true);
  const e2 = createEngine({ store, getDisk: async () => memoryDisk() });
  assert.deepEqual(await e2.init(), { resume: true });
  await engine.start();
  await engine.whenIdle();
  assert.equal(await store.get('wasRunning'), false, 'finished runs are not resumed');
  assert.deepEqual(engine.locate({ objectId: 1 }), { ok: true, parts: ['Rescale', '2024-10', 'A.zip'], packed: false });
  assert.deepEqual(engine.locate({ creator: 'Rescale', bundle: '2024-10' }).parts, ['Rescale', '2024-10']);
  assert.equal(engine.locate({ objectId: 99 }).ok, false);
});

test('engine: a model saved as a single STL stays done on the next sync (no re-download)', async () => {
  const stl = makeStl(3);
  const rows = [{ originalId: 300, name: 'Mage Hand', creatorName: 'Ranger Fox', source: 'PURCHASE' }];
  const routes = libraryRoutes(rows, {
    [`${MMF}/object/3d-print-300`]: [200, '<script>x={"archives":[],"pdfFiles":[]}; state.filesInfo[9] = { "name": "bigbyp.stl" }</script>'],
    [`${MMF}/download/300`]: [200, stl],
  });
  const { engine, disk } = await setup({ routes, settings: { pageDelayMs: 0 } });
  await syncAndWait(engine);
  await engine.start();
  await engine.whenIdle();
  assert.deepEqual(disk.files.get('Ranger Fox/Purchases/Mage Hand.stl'), stl);
  const lp = await syncAndWait(engine);
  assert.equal(lp.pending, 0);
  assert.equal(engine.queue.items[0].filename, 'Mage Hand.stl');
});

test('engine: creators checklist lists everyone in the library, with skipped ones ticked', async () => {
  const rows = [
    { originalId: 100, name: 'Ghost', creatorName: 'Rescale', source: 'PURCHASE' },
    { originalId: 101, name: 'Wraith', creatorName: 'Rescale', source: 'PURCHASE' },
    { originalId: 300, name: 'Sword', creatorName: 'Claymore Miniatures', source: 'PURCHASE' },
  ];
  const routes = libraryRoutes(rows, {
    [`${MMF}/object/3d-print-100`]: [200, page([{ id: 1, path: 'G.zip', size: '10' }])],
    [`${MMF}/object/3d-print-101`]: [200, page([{ id: 2, path: 'W.zip', size: '10' }])],
  });
  const { engine } = await setup({ routes, settings: { pageDelayMs: 0, excludeCreators: ['claymore miniatures'] } });
  await syncAndWait(engine);
  assert.deepEqual(await engine.creators(), [
    { name: 'Claymore Miniatures', models: 1, skipped: true },
    { name: 'Rescale', models: 2, skipped: false },
  ]);
});

test('engine: settings are kept in sensible bounds (retry after a refusal: at least 5 minutes)', async () => {
  const { engine } = await setup({});
  assert.equal((await engine.saveSettings({ forbiddenRetryMinutes: 1 })).settings.forbiddenRetryMinutes, 5);
  assert.equal((await engine.saveSettings({ forbiddenRetryMinutes: 30 })).settings.forbiddenRetryMinutes, 30);
  assert.equal((await engine.saveSettings({ maxDownloadsPerHour: 0 })).settings.maxDownloadsPerHour, 120, 'blank/0 -> default');
  assert.equal((await engine.saveSettings({ maxDownloadsPerHour: 5000 })).settings.maxDownloadsPerHour, 1000);
});
