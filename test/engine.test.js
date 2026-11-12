import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, NeedsFolderError } from '../extension/engine/engine.js';
import { mergeQueue, isBust, isStatue, applySkipRules, buildTree, setHidden } from '../extension/core/queue.js';
import { memoryStore, memoryDisk, makeZip, makeStl, fakeFetch, fakeClock } from './engine-fakes.js';

const MMF = 'https://www.myminifactory.com';
const zipA = makeZip('a.stl', 'model A');
const zipB = makeZip('b.stl', 'model B!!');
const item = (o, f, filename, size, extra = {}) => ({
  key: `${o}:${f}`, objectId: o, fileId: f, objectName: `Model ${o}`, creator: 'Rescale',
  url: `${MMF}/download/${o}?archive_id=${f}`, filename, originalFilename: filename, size,
  dest: ['Rescale', '2024-10'], objectFileCount: 1, ...extra,
});

async function setup({ items = [], routes = {}, settings, diskFiles = {}, getPdfDisk } = {}) {
  const store = memoryStore();
  const disk = memoryDisk();
  for (const [k, v] of Object.entries(diskFiles)) disk.files.set(k, v);
  const clock = fakeClock();
  if (items.length) await store.set('queue', await mergeQueue(null, items, disk, clock.now()));
  if (settings) await store.set('settings', settings);
  const fetchImpl = fakeFetch(routes);
  const engine = createEngine({ store, getDisk: async () => disk, getPdfDisk, fetchImpl, now: clock.now, sleep: clock.sleep });
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

// A Response that says where it finally came from (after MMF's redirect).
const landedOn = (url, body, status = 200) => {
  const r = new Response(body, { status, headers: { 'content-type': 'text/html' } });
  Object.defineProperty(r, 'url', { value: url });
  return r;
};

test('engine: a pause for a web page names the file, the HTTP status and the page', async () => {
  const { engine, store } = await setup({
    items: [item(1, 10, 'A.zip', zipA.length)],
    routes: { [`${MMF}/download/1?archive_id=10`]: () => landedOn(`${MMF}/download/1?archive_id=10`, '<!DOCTYPE html><html><head><title>Just a moment...</title></head>', 200) },
  });
  await engine.start();
  await engine.whenIdle();
  const why = engine.status().pauseReason;
  assert.match(why, /web page instead of "A\.zip" \(HTTP 200, page "Just a moment\.\.\."\)/);
  assert.match(why, /Cloudflare check/);
  assert.match(store.hist.find((e) => e.type === 'fail').reason, /"A\.zip" \(HTTP 200/);
  assert.equal(engine.queue.items[0].status, 'pending');

  const login = await setup({
    items: [item(1, 10, 'A.zip', zipA.length)],
    routes: { [`${MMF}/download/1?archive_id=10`]: () => landedOn(`${MMF}/login`, '<!DOCTYPE html><title>Login | MyMiniFactory</title>') },
  });
  await login.engine.start();
  await login.engine.whenIdle();
  assert.match(login.engine.status().pauseReason, /Log in to myminifactory\.com/);
});

test('engine: MMF bouncing one link back to the model page fails that file only; the run carries on', async () => {
  const { engine, store, disk, fetchImpl } = await setup({
    items: [item(1, 10, 'Book.pdf', 500), item(1, 11, 'B.zip', zipB.length)],
    routes: {
      [`${MMF}/download/1?archive_id=10`]: () => landedOn(`${MMF}/object/3d-print-book-1`, '<!DOCTYPE html><html><head><title>3D Printable Book by Someone</title>'),
      [`${MMF}/download/1?archive_id=11`]: [200, zipB],
    },
  });
  await engine.start();
  await engine.whenIdle();
  assert.equal(engine.status().paused, false, 'not paused');
  const [pdf, zip] = engine.queue.items;
  assert.equal(pdf.status, 'failed');
  assert.match(pdf.error, /web page instead of "Book\.pdf" \(HTTP 200, page "3D Printable Book by Someone"\).*did not accept/);
  assert.equal(zip.status, 'done');
  assert.equal(fetchImpl.calls.filter((u) => u.endsWith('archive_id=10')).length, 1, 'asked once, not three times');
  assert.deepEqual([...disk.files.keys()], ['Rescale/2024-10/B.zip'], 'no stray page or .partial left behind');
  assert.ok(!types(store).includes('pause'));
});

test('sync + download: a PDF list remembered by an older build is read again and the PDF downloads from its own link', async () => {
  const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(300, 0x20), Buffer.from('\n%%EOF\n')]);
  const rows = [
    { originalId: 100, name: 'Rite (5e Adventure PDF)', creatorName: 'Rescale', source: 'USER_GROUP', release: '60627' },
    { originalId: 200, name: 'Ghost', creatorName: 'Rescale', source: 'USER_GROUP', release: '60627' },
  ];
  const pdfPage = `<script>var p = {"archives":[{"id":1,"path":"Rite.pdf.zip","size":"${zipA.length}"}],"pdfFiles":[{"id":10325,"name":"Rite v1.1.pdf","size":"${pdfBytes.length}","downloadOriginalUrl":"\\/download\\/pdf\\/10325\\/watermark"}]};</script>`;
  const { engine, store, disk, fetchImpl } = await setup({
    settings: { pageDelayMs: 0 },
    routes: libraryRoutes(rows, {
      [`${MMF}/object/3d-print-100`]: [200, pdfPage],
      [`${MMF}/download/100?archive_id=1`]: [200, zipA],
      [`${MMF}/download/pdf/10325/watermark`]: [200, pdfBytes],
      [`${MMF}/download/200?archive_id=3`]: [200, zipB],
    }),
  });
  // What 2.0.0 remembered: the PDF with an archive-style link, and a model without a PDF.
  await store.setObject(100, { id: 100, files: { items: [
    { id: 1, filename: 'Rite.pdf.zip', size: zipA.length, download_url: `${MMF}/download/100?archive_id=1` },
    { id: 10325, filename: 'Rite v1.1.pdf', size: pdfBytes.length, download_url: `${MMF}/download/100?archive_id=10325` },
  ] } });
  await store.setObject(200, { id: 200, files: { items: [{ id: 3, filename: 'Ghost.zip', size: zipB.length, download_url: `${MMF}/download/200?archive_id=3` }] } });

  const lp = await syncAndWait(engine);
  assert.equal(lp.ok, true, lp.error);
  assert.equal(lp.fetched, 1, 'only the model with a PDF was read again');
  assert.ok(!fetchImpl.calls.includes(`${MMF}/object/3d-print-200`));
  const pdf = engine.queue.items.find((i) => i.key === '100:10325');
  assert.equal(pdf.url, `${MMF}/download/pdf/10325/watermark`);
  assert.equal((await store.getObject(100)).format, 2);

  await engine.start();
  await engine.whenIdle();
  assert.equal(engine.queue.items.find((i) => i.key === '100:10325').status, 'done');
  const saved = [...disk.files.keys()].find((k) => k.endsWith('Rite v1.1.pdf'));
  assert.ok(saved, 'PDF saved under its own name');
  assert.equal(disk.files.get(saved).byteLength, pdfBytes.length);
  assert.ok(!fetchImpl.calls.includes(`${MMF}/download/100?archive_id=10325`), 'old link never used');
});

// ---------- PDF folder ----------

const pdfBody = (text = 'stats') => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from(text), Buffer.from('\n%%EOF\n')]);
const pdfItem = (o, f, filename, bytes, extra = {}) => ({
  ...item(o, f, filename, bytes.length), creator: 'Mammoth Factory', dest: ['Mammoth Factory', 'Rite (5e Adventure PDF)'],
  url: `${MMF}/download/pdf/${f}/watermark`, ...extra,
});

test('pdf folder: a downloaded PDF is also copied to <Creator>/<creator\'s file name>; the archive keeps its copy', async () => {
  const book = pdfBody('rite of the black feather');
  const pdfDisk = memoryDisk();
  const { engine, store, disk } = await setup({
    getPdfDisk: async () => pdfDisk,
    // A single-file model: named after the page title in the archive.
    items: [pdfItem(1, 10325, 'Fateless Rite (5e Adventure PDF).pdf', book, { originalFilename: 'Rite of the Black Feather v1.1.pdf' }), item(2, 11, 'B.zip', zipB.length)],
    routes: { [`${MMF}/download/pdf/10325/watermark`]: [200, book], [`${MMF}/download/2?archive_id=11`]: [200, zipB] },
  });
  await engine.start();
  await engine.whenIdle();
  assert.deepEqual([...pdfDisk.files.keys()], ['Mammoth Factory/Rite of the Black Feather v1.1.pdf'], 'only the PDF, flat under the creator');
  assert.ok(Buffer.from(pdfDisk.files.get('Mammoth Factory/Rite of the Black Feather v1.1.pdf')).equals(book), 'byte for byte');
  assert.ok(disk.files.has('Mammoth Factory/Rite (5e Adventure PDF)/Fateless Rite (5e Adventure PDF).pdf'), 'archive copy stays');
  assert.equal(engine.queue.items[0].pdfCopy, 'copied');
  assert.equal(engine.queue.items[1].pdfCopy, undefined, 'zips are never copied');
  assert.match(store.hist.find((e) => e.type === 'pdf').reason, /Copied to the PDF folder: Mammoth Factory\/Rite of the Black Feather v1\.1\.pdf/);
  assert.deepEqual((await engine.history()).find((e) => e.type === 'pdf').at, ['Mammoth Factory', 'Rite of the Black Feather v1.1.pdf'], 'History knows where the copy is');
  assert.equal(engine.status().pdfCopiesWaiting, 0);
});

test('pdf folder: none picked -> PDFs just go to the archive, as before', async () => {
  const book = pdfBody();
  const { engine, store, disk } = await setup({
    items: [pdfItem(1, 5, 'Book.pdf', book)],
    routes: { [`${MMF}/download/pdf/5/watermark`]: [200, book] },
  });
  await engine.start();
  await engine.whenIdle();
  assert.equal(engine.queue.items[0].status, 'done');
  assert.equal(engine.queue.items[0].pdfCopy, undefined);
  assert.ok(disk.files.has('Mammoth Factory/Rite (5e Adventure PDF)/Book.pdf'));
  assert.ok(!types(store).includes('pdf'));
});

test('pdf folder: never overwrites; a copy you moved to _Other counts as already there', async () => {
  const a = pdfBody('same file');
  const b = pdfBody('new version from MMF');
  const mine = pdfBody('my own, different');
  const pdfDisk = memoryDisk();
  pdfDisk.files.set('Mammoth Factory/_Other/Preview.pdf', a);
  pdfDisk.files.set('Mammoth Factory/Clash.pdf', mine);
  const { engine, store } = await setup({
    getPdfDisk: async () => pdfDisk,
    items: [pdfItem(1, 1, 'Preview.pdf', a), pdfItem(1, 2, 'Clash.pdf', b), pdfItem(1, 3, 'Fake.pdf', zipA)],
    routes: {
      [`${MMF}/download/pdf/1/watermark`]: [200, a], [`${MMF}/download/pdf/2/watermark`]: [200, b], [`${MMF}/download/pdf/3/watermark`]: [200, zipA],
    },
  });
  await engine.start();
  await engine.whenIdle();
  assert.deepEqual(engine.queue.items.map((i) => [i.status, i.pdfCopy]), [['done', 'there'], ['done', 'clash'], ['done', 'not-pdf']]);
  assert.deepEqual([...pdfDisk.files.keys()].sort(), ['Mammoth Factory/Clash.pdf', 'Mammoth Factory/_Other/Preview.pdf'], 'nothing added, no .partial left');
  assert.ok(Buffer.from(pdfDisk.files.get('Mammoth Factory/Clash.pdf')).equals(mine), 'your file is untouched');
  const notes = store.hist.filter((e) => e.type === 'pdf').map((e) => e.reason);
  assert.match(notes[0], /Already in the PDF folder: Mammoth Factory\/_Other\/Preview\.pdf/);
  assert.match(notes[1], /different file is already at Mammoth Factory\/Clash\.pdf/);
  assert.match(notes[2], /not a PDF inside/);
});

test('pdf folder: if Chrome needs your OK, the download still finishes and the copy happens at the next Start (even after a Sync)', async () => {
  const book = pdfBody('later');
  const pdfDisk = memoryDisk();
  let allowed = false;
  const { engine, disk, clock } = await setup({
    getPdfDisk: async () => { if (!allowed) throw new NeedsFolderError('needs OK'); return pdfDisk; },
    items: [pdfItem(1, 7, 'Book.pdf', book)],
    routes: { [`${MMF}/download/pdf/7/watermark`]: [200, book] },
  });
  await engine.start();
  await engine.whenIdle();
  assert.equal(engine.queue.items[0].status, 'done');
  assert.equal(engine.status().paused, false, 'a PDF folder problem never pauses downloads');
  assert.equal(engine.status().pdfCopiesWaiting, 1);
  assert.equal(pdfDisk.files.size, 0);

  // A Sync rebuilds the list: "waiting to be copied" must survive it.
  const { status, attempts, error, doneAt, doneBytes, pdfCopy, ...planned } = engine.queue.items[0];
  const merged = await mergeQueue(engine.queue, [planned], disk, clock.now());
  assert.equal(merged.items[0].pdfCopy, 'wanted');

  allowed = true;
  const r = await engine.start();
  assert.equal(r.nothing, true, 'nothing left to download');
  assert.deepEqual([...pdfDisk.files.keys()], ['Mammoth Factory/Book.pdf']);
  assert.equal(engine.status().pdfCopiesWaiting, 0);
});

test('pdf folder: a failed copy leaves no half file and is tried again', async () => {
  const book = pdfBody('retry me');
  const pdfDisk = memoryDisk();
  const realWriter = pdfDisk.writer;
  let broken = true;
  pdfDisk.writer = async (parts) => {
    const w = await realWriter(parts);
    return broken ? { ...w, write: async () => { throw new Error('disk full'); } } : w;
  };
  const { engine, store } = await setup({
    getPdfDisk: async () => pdfDisk,
    items: [pdfItem(1, 8, 'Book.pdf', book)],
    routes: { [`${MMF}/download/pdf/8/watermark`]: [200, book] },
  });
  await engine.start();
  await engine.whenIdle();
  assert.equal(engine.queue.items[0].status, 'done', 'the download itself is fine');
  assert.equal(engine.queue.items[0].pdfCopy, 'wanted');
  assert.equal(pdfDisk.files.size, 0);
  assert.match(store.hist.find((e) => e.type === 'pdf').reason, /disk full.*try again at the next Start/);
  broken = false;
  await engine.start();
  assert.deepEqual([...pdfDisk.files.keys()], ['Mammoth Factory/Book.pdf']);
});

test('engine: Clear failed unchecks the failed files so nothing retries them; ticking the model brings them back', async () => {
  const { engine, fetchImpl } = await setup({
    items: [item(1, 10, 'Gone.zip', 500), item(2, 11, 'B.zip', zipB.length)],
    routes: { [`${MMF}/download/1?archive_id=10`]: [404, 'nope'], [`${MMF}/download/2?archive_id=11`]: [200, zipB] },
  });
  await engine.start();
  await engine.whenIdle();
  assert.equal(engine.status().summary.failed, 1);

  assert.deepEqual(await engine.clearFailed(), { ok: true, cleared: 1 });
  const gone = engine.queue.items[0];
  assert.deepEqual([gone.status, gone.skip, gone.error, gone.attempts], ['pending', true, null, 0]);
  assert.equal(engine.status().summary.failed, 0, 'the failed count is back to zero');
  assert.equal(engine.queue.items[1].status, 'done', 'downloaded files are untouched');

  const asked = fetchImpl.calls.length;
  const r = await engine.start();
  assert.equal(r.nothing, true, 'nothing left to download');
  assert.equal(fetchImpl.calls.length, asked, 'the cleared file is not asked for again');
  assert.deepEqual(await engine.clearFailed(), { ok: true, cleared: 0 }, 'nothing to clear the second time');

  await engine.setSkip([1], false);
  assert.equal(engine.queue.items[0].skip, false, 'ticking the model again queues it');
});

// ---------- Skip busts ----------

test('busts: told by name; "Buster" and "robust" are not busts', () => {
  const yes = ['BUSTS.zip', 'Overlord Bust.zip', 'Arienes, Ocean Queen, BUST.zip', 'Wondersea Pirate BUST.zip', 'bust_presupported.zip', 'Sprawl-Busts-v2.zip'];
  const no = ['Buster Sword.zip', 'Robust Golem.zip', 'Dustbuster.zip', 'Combustion Elemental.zip', 'Troll.zip'];
  for (const f of yes) assert.equal(isBust({ filename: f }), true, f);
  for (const f of no) assert.equal(isBust({ filename: f }), false, f);
  assert.equal(isBust({ filename: 'Files.zip', objectName: 'Arienes, Ocean Queen - Bust' }), true, 'a model named as a bust');
});

test('Skip busts: busts are never downloaded and a model is complete without them; turning it off brings them back', async () => {
  const col = (f, name, bytes) => ({ ...item(1, f, name, bytes.length), objectName: 'The Sprawl II COLLECTION', dest: ['Mammoth Factory', 'The Sprawl II - Nov 2024 - STL'] });
  const { engine, fetchImpl, disk } = await setup({
    items: [col(10, 'Trickster.zip', zipA), col(11, 'BUSTS.zip', zipB)],
    routes: { [`${MMF}/download/1?archive_id=10`]: [200, zipA], [`${MMF}/download/1?archive_id=11`]: [200, zipB] },
  });
  assert.equal((await engine.saveSettings({ skipBusts: true })).settings.skipBusts, true);
  assert.equal(engine.status().bustsOut, 1);
  assert.equal(engine.status().summary.total, 1, 'only the model file counts as selected');

  await engine.start();
  await engine.whenIdle();
  assert.deepEqual([...disk.files.keys()], ['Mammoth Factory/The Sprawl II - Nov 2024 - STL/Trickster.zip']);
  assert.ok(!fetchImpl.calls.some((u) => u.endsWith('archive_id=11')), 'the bust was never asked for');
  assert.equal(engine.status().summary.failed, 0);

  const model = engine.tree()[0].bundles[0].objects[0];
  assert.deepEqual([model.files, model.doneFiles, model.bustsOut], [2, 1, 1], '1 of 2 on disk, the other is a bust left out');
  assert.equal((await engine.start()).nothing, true, 'nothing left to download');

  // Someone who does want busts turns it off: the bust is an ordinary file again.
  await engine.saveSettings({ skipBusts: false });
  assert.equal(engine.status().bustsOut, 0);
  assert.equal(engine.tree()[0].bundles[0].objects[0].bustsOut, 0);
  await engine.start();
  await engine.whenIdle();
  assert.ok(disk.files.has('Mammoth Factory/The Sprawl II - Nov 2024 - STL/BUSTS.zip'));
});

test('Skip busts: a bust already downloaded stays counted; a new model that is only busts is not "new"', async () => {
  const q = { items: [
    { ...item(1, 10, 'A.zip', 5), status: 'done', firstSeen: '2026-11-01' },
    { ...item(1, 11, 'A BUST.zip', 5), status: 'done', firstSeen: '2026-11-01' },
    { ...item(2, 20, 'Queen BUST.zip', 5), objectName: 'Queen Bust', firstSeen: '2026-11-01' },
    { ...item(3, 30, 'B.zip', 5), status: 'done', firstSeen: '2026-11-01' },
    { ...item(3, 31, 'BUSTS.zip', 5), firstSeen: '2026-11-01' },
  ] };
  assert.equal(applySkipRules(q, { busts: true }), 2, 'only the two busts not on disk are left out');
  const objs = Object.fromEntries(buildTree(q).flatMap((c) => c.bundles).flatMap((b) => b.objects).map((o) => [o.id, o]));
  assert.deepEqual([objs[1].doneFiles, objs[1].files, objs[1].bustsOut], [2, 2, 0], 'kept bust still counts as downloaded');
  assert.deepEqual([objs[3].doneFiles, objs[3].files, objs[3].bustsOut, objs[3].isNew], [1, 2, 1, false], 'complete except its bust: not new');
  assert.equal(objs[2].isNew, false, 'a bust-only model is not new when busts are skipped');
  assert.equal(applySkipRules(q, {}), 0);
  assert.equal(buildTree(q).flatMap((c) => c.bundles).flatMap((b) => b.objects).find((o) => o.id === 3).isNew, true, 'with the rule off it is new again');
});

test('statues: told by name, the same way as busts; "statuesque" is not a statue', () => {
  for (const f of ['Dragon Statue.zip', 'STATUES.zip', 'statue_presupported.zip', 'Lich King - Statue (300mm).zip']) assert.equal(isStatue({ filename: f }), true, f);
  for (const f of ['Statuesque Elf.zip', 'Status Effects.zip', 'Troll.zip', 'BUSTS.zip']) assert.equal(isStatue({ filename: f }), false, f);
  assert.equal(isStatue({ filename: 'Files.zip', objectName: 'Ancient Red Dragon Statue' }), true, 'a model named as a statue');
});

test('Skip statues: works like Skip busts, each on its own switch, and the list counts them apart', async () => {
  const col = (f, name, bytes) => ({ ...item(1, f, name, bytes.length), objectName: 'Loot COLLECTION', dest: ['Loot Studios', '2026-11'] });
  const { engine, fetchImpl, disk } = await setup({
    items: [col(10, 'Knight.zip', zipA), col(11, 'Knight BUST.zip', zipB), col(12, 'Dragon Statue.zip', zipB)],
    routes: { [`${MMF}/download/1?archive_id=10`]: [200, zipA], [`${MMF}/download/1?archive_id=11`]: [200, zipB], [`${MMF}/download/1?archive_id=12`]: [200, zipB] },
  });
  await engine.saveSettings({ skipStatues: true });
  assert.deepEqual([engine.status().bustsOut, engine.status().statuesOut], [0, 1], 'statues only: the bust is still wanted');
  await engine.saveSettings({ skipBusts: true });
  assert.deepEqual([engine.status().bustsOut, engine.status().statuesOut], [1, 1]);

  await engine.start();
  await engine.whenIdle();
  assert.deepEqual([...disk.files.keys()], ['Loot Studios/2026-11/Knight.zip']);
  assert.ok(!fetchImpl.calls.some((u) => /archive_id=1[12]$/.test(u)), 'neither the bust nor the statue was asked for');
  const model = engine.tree()[0].bundles[0].objects[0];
  assert.deepEqual([model.files, model.doneFiles, model.bustsOut, model.statuesOut], [3, 1, 1, 1]);

  await engine.saveSettings({ skipStatues: false });
  assert.deepEqual([engine.status().bustsOut, engine.status().statuesOut], [1, 0], 'statues wanted again, busts still skipped');
  await engine.start();
  await engine.whenIdle();
  assert.deepEqual([...disk.files.keys()].sort(), ['Loot Studios/2026-11/Dragon Statue.zip', 'Loot Studios/2026-11/Knight.zip']);
});

// ---------- Don't want (hidden models) ----------

test("Don't want: a hidden model leaves the list, the counts and New, is never downloaded, and Restore brings it back badged NEW", async () => {
  const { engine, fetchImpl, disk, clock } = await setup({
    items: [
      { ...item(1, 10, 'Huey.zip', zipA.length), objectName: 'Huey Helicopter', firstSeen: '2026-11-10T00:00:00.000Z' },
      { ...item(2, 20, 'B.zip', zipB.length), objectName: 'Troll', firstSeen: '2026-11-10T00:00:00.000Z' },
    ],
    routes: { [`${MMF}/download/1?archive_id=10`]: [200, zipA], [`${MMF}/download/2?archive_id=20`]: [200, zipB] },
  });
  for (const i of engine.queue.items) i.firstSeen = '2026-11-10T00:00:00.000Z'; // both arrived in the latest Sync
  const names = (opts) => engine.tree(opts).flatMap((c) => c.bundles).flatMap((b) => b.objects).map((o) => `${o.name}${o.isNew ? ' NEW' : ''}`).sort();
  assert.deepEqual(names(), ['Huey Helicopter NEW', 'Troll NEW']);

  assert.deepEqual(await engine.setHidden([1], true), { ok: true, changed: 1, hiddenModels: 1 });
  assert.deepEqual(names(), ['Troll NEW'], 'gone from the list and from New');
  assert.deepEqual(names({ hidden: true }), ['Huey Helicopter NEW'], 'kept on its own under Hidden');
  assert.equal(engine.status().hiddenModels, 1);
  assert.deepEqual([engine.status().summary.total, engine.status().summary.skipped], [1, 0], 'not selected, and not counted as unchecked either');

  await engine.start();
  await engine.whenIdle();
  assert.deepEqual([...disk.files.keys()], ['Rescale/2024-10/B.zip']);
  assert.ok(!fetchImpl.calls.some((u) => u.endsWith('archive_id=10')), 'the hidden model was never asked for');

  // A Sync keeps it hidden, and a file the model gains later is hidden with it.
  const strip = ({ status, attempts, error, doneAt, doneBytes, skip, firstSeen, hidden, ...planned }) => planned;
  const again = [...engine.queue.items.map(strip), strip({ ...item(1, 11, 'Huey Extras.zip', 100), objectName: 'Huey Helicopter' })];
  const merged = await mergeQueue(engine.queue, again, disk, clock.now());
  assert.deepEqual(merged.items.filter((i) => i.hidden).map((i) => i.filename).sort(), ['Huey Extras.zip', 'Huey.zip']);

  assert.deepEqual(await engine.setHidden([1], false), { ok: true, changed: 1, hiddenModels: 0 });
  assert.deepEqual(names(), ['Huey Helicopter NEW', 'Troll'], 'restored, badged NEW; Troll was downloaded so it is not');
  assert.deepEqual(names({ hidden: true }), []);
});

test('Restore: a model hidden before any new arrivals still comes back badged NEW', () => {
  const q = { items: [{ ...item(1, 10, 'Huey.zip', 5), hidden: true, firstSeen: null }, { ...item(2, 20, 'B.zip', 5), firstSeen: null }] };
  const objs = () => Object.fromEntries(buildTree(q).flatMap((c) => c.bundles).flatMap((b) => b.objects).map((o) => [o.id, o.isNew]));
  assert.deepEqual(objs(), { 2: false });
  setHidden(q, [1], false, Date.parse('2026-11-12T04:00:00Z'));
  assert.deepEqual(objs(), { 1: true, 2: false }, 'only the restored model is new');
});
