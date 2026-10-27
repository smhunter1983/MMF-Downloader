import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseRelease, buildEntries, importLibrary, applyExclusions, deriveGroupTitles, bundleFor, destinationFor,
} from '../src/library.js';
import { safeName } from '../src/names.js';
import { isMmfHost, looksLikeHtml } from '../src/http.js';
import { resolveNameClashes, itemsForObject, dedupeItems } from '../src/plan.js';

test('parseRelease splits the key:value string', () => {
  assert.deepEqual(parseRelease('type:tribes-tier;owner:1448840;tribe:772;tier:1845;yearmonth:202606'), {
    type: 'tribes-tier', owner: '1448840', tribe: '772', tier: '1845', yearmonth: '202606',
  });
  assert.deepEqual(parseRelease(null), {});
});

test('safeName removes Windows-illegal characters and trailing dots', () => {
  assert.equal(safeName('Orc: Warband / "Elite"?.'), 'Orc_ Warband _ _Elite__');
  assert.equal(safeName('   '), 'unnamed');
  assert.equal(safeName('CON.zip'), '_CON.zip');
  assert.equal(safeName('Console.zip'), 'Console.zip');
});

test('isMmfHost only matches MMF domains', () => {
  assert.ok(isMmfHost('https://www.myminifactory.com/download/1'));
  assert.ok(!isMmfHost('https://myminifactory.com.evil.net/x'));
});

test('looksLikeHtml catches error pages', () => {
  assert.ok(looksLikeHtml('<!DOCTYPE html><html>'));
  assert.ok(!looksLikeHtml('PK\u0003\u0004'));
});

const ROWS = [
  { originalId: 1, name: 'Bloat', creatorName: 'MMM', source: 'TRIBE', release: 'type:tribes-tier;tribe:16;yearmonth:202610', publishedAt: '2026-10-19T00:00:00Z' },
  { originalId: 1, name: 'Bloat', creatorName: 'MMM', source: 'USER_GROUP', release: '113928' },
  { originalId: 1, name: 'Bloat', creatorName: 'MMM', source: 'TRIBE', release: 'type:tribes-tier;tribe:16;yearmonth:202507' },
  { originalId: 2, name: 'Release: Hollow Graves', creatorName: 'Rescale', source: 'USER_GROUP', release: '60627', publishedAt: '2024-10-02T00:00:00Z' },
  { originalId: 3, name: 'Masked Ghost', creatorName: 'Rescale', source: 'USER_GROUP', release: '60627', publishedAt: '2024-10-01T00:00:00Z' },
  { originalId: 4, name: 'Thing', creatorName: 'Rescale', source: 'USER_GROUP', release: '99999' },
  { originalId: 5, name: 'Orcus', creatorName: 'CGF', source: 'TRIBE', release: 'type:loyalty-sub;tribe:275;monthAmount:3' },
  { originalId: 6, name: 'Ladders', creatorName: 'CMM', source: 'PURCHASE' },
  { originalId: 7, name: 'Barn', creatorName: 'Embernell', source: 'DOWNLOAD' },
  { originalId: 8, name: 'Thralls', creatorName: 'Archvillain', source: 'FRONTIER', release: '47687', campaignId: 2467 },
];

test('buildEntries merges duplicate rows into memberships', () => {
  const entries = buildEntries(ROWS);
  assert.equal(entries.length, 8);
  assert.equal(entries[0].memberships.length, 3);
});

test('bundleFor picks the right folder per source', () => {
  const entries = buildEntries(ROWS);
  const titles = deriveGroupTitles(entries);
  const b = (id) => bundleFor(entries.find((e) => e.id === id), titles);
  assert.equal(b(1), '2025-07', 'earliest Tribe month wins over a group');
  assert.equal(b(2), '2024-10 - Hollow Graves');
  assert.equal(b(3), '2024-10 - Hollow Graves', 'group title shared by members');
  assert.equal(b(4), 'Release 99999');
  assert.equal(b(5), 'Loyalty Rewards');
  assert.equal(b(6), 'Purchases');
  assert.equal(b(7), 'Free Downloads');
  assert.equal(b(8), 'Frontier 2467');
  assert.equal(bundleFor(entries.find((e) => e.id === 4), titles, { 99999: 'Curse of Briar' }), 'Curse of Briar');
  assert.deepEqual(destinationFor(entries[1], titles), ['Rescale', '2024-10 - Hollow Graves']);
});

test('importLibrary writes entries and applyExclusions filters creators', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mmf-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'lib.json');
  await writeFile(file, '﻿' + JSON.stringify(ROWS));
  const { entries, rawCount } = await importLibrary(file, { outPath: path.join(dir, 'library.json') });
  assert.equal(rawCount, ROWS.length);
  const { kept, excluded } = applyExclusions(entries, [' rescale ']);
  assert.equal(excluded.length, 3);
  assert.equal(kept.length, 5);
});

test('itemsForObject + resolveNameClashes', () => {
  const obj = { files: { items: [
    { id: 10, filename: 'Supported.zip', size: '100', download_url: 'https://www.myminifactory.com/download/1?archive_id=10' },
    { id: 11, filename: 'No URL.zip', size: '5' },
  ] } };
  const a = itemsForObject({ id: 1, name: 'A', creator: 'X' }, obj, ['X', 'B']);
  const b = itemsForObject({ id: 2, name: 'B', creator: 'X' }, { files: { items: [{ id: 20, filename: 'Supported.zip', size: '7', download_url: 'u' }] } }, ['X', 'B']);
  assert.equal(a.length, 1, 'files without a download_url are skipped');
  assert.equal(a[0].size, 100);
  const items = resolveNameClashes([...a, ...b]);
  assert.deepEqual(items.map((i) => i.filename), ['Supported [1].zip', 'Supported [2].zip']);
});

test('dedupeItems keeps one copy of a model sold both in a bundle and alone', () => {
  const url = 'https://www.myminifactory.com/download/x';
  const bundle = itemsForObject({ id: 900, name: 'Blighted Fields', creator: 'MMM' }, { files: { items: [
    { id: 1, filename: 'Bloat Steel Pose01.zip', size: '285376956', download_url: url },
    { id: 2, filename: 'Crypt Mimic.zip', size: '298699675', download_url: url },
  ] } }, ['MMM', '2026-10']);
  const single = itemsForObject({ id: 881, name: 'Bloat Steel', creator: 'MMM' }, { files: { items: [
    { id: 3, filename: 'Bloat Steel Pose01.zip', size: '285376956', download_url: url },
  ] } }, ['MMM', '2026-10']);
  const other = itemsForObject({ id: 5, name: 'X', creator: 'Someone Else' }, { files: { items: [
    { id: 4, filename: 'Bloat Steel Pose01.zip', size: '285376956', download_url: url },
  ] } }, ['Someone Else', 'P']);
  const r = dedupeItems([...single, ...bundle, ...other]);
  assert.equal(r.dupes, 1);
  assert.equal(r.bytesSaved, 285376956);
  const kept = r.items.find((i) => i.filename === 'Bloat Steel Pose01.zip' && i.creator === 'MMM');
  assert.equal(kept.objectId, 900, 'filed with the bundle');
  assert.deepEqual(kept.alsoIn, [881]);
  assert.equal(r.items.length, 3, 'other creators are never merged');
  assert.deepEqual(resolveNameClashes(r.items).map((i) => i.filename).filter((n) => n.includes('[')), []);
});

test('deriveGroupTitles prefers synced release names', () => {
  const entries = buildEntries([{ originalId: 1, name: 'A', creatorName: 'CGF', source: 'USER_GROUP', release: '64192' }]);
  assert.equal(deriveGroupTitles(entries, { 64192: { label: " January '25:  Hunger Incarnate ~ Fantasy " } })['64192'],
    "January '25:  Hunger Incarnate ~ Fantasy");
  assert.equal(deriveGroupTitles(entries)['64192'], 'Release 64192');
});

test('fetchWithRetry survives a dropped connection', async (t) => {
  const http = await import('node:http');
  const { fetchWithRetry } = await import('../src/http.js');
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls++;
    if (calls === 1) return req.socket.destroy();
    res.end('{"ok":true}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const retries = [];
  const res = await fetchWithRetry(`http://127.0.0.1:${server.address().port}/`, {}, { onRetry: (r) => retries.push(r.status) });
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual(retries, ['network error']);
});

test('loose-parts-only models become one whole-model zip; archives and PDFs stay as-is', () => {
  const entry = { id: 143070, name: 'Wendigo', creator: 'Rescale' };
  const dl = (n) => ({ id: n.length, filename: n, size: '10', download_url: 'https://www.myminifactory.com/download/1?x' });
  const loose = itemsForObject(entry, { files: { items: [dl('a.stl'), dl('b.lys')] } }, ['Rescale', 'Free']);
  assert.equal(loose.length, 1);
  assert.equal(loose[0].url, 'https://www.myminifactory.com/download/143070');
  assert.equal(loose[0].filename, 'Wendigo.zip');
  assert.equal(loose[0].wholeZip, true);
  assert.deepEqual(loose[0].replaces, ['a.stl', 'b.lys']);
  assert.equal(itemsForObject(entry, { files: { items: [dl('a.zip'), dl('b.rar')] } }, ['R', 'F']).length, 2);
  assert.equal(itemsForObject(entry, { files: { items: [dl('book1.pdf'), dl('book22.pdf')] } }, ['R', 'F']).length, 2);
});
