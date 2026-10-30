import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseRelease, buildEntries, applyExclusions, deriveGroupTitles, bundleFor, destinationFor,
} from '../extension/core/library.js';
import { safeName } from '../extension/core/names.js';
import { looksLikeHtml } from '../extension/core/zip.js';
import { resolveNameClashes, itemsForObject, dedupeItems } from '../extension/core/items.js';

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

test('applyExclusions filters creators (case and spaces ignored)', () => {
  const entries = buildEntries(ROWS);
  const { kept, excluded } = applyExclusions(entries, [' rescale ']);
  assert.equal(excluded.length, 3);
  assert.equal(kept.length, 5);
});

test('itemsForObject + resolveNameClashes', () => {
  const url = 'https://www.myminifactory.com/download/1?archive_id=1';
  const obj = (ids) => ({ files: { items: ids.map(([id, name, size]) => ({ id, filename: name, size: String(size), download_url: url })) } });
  const a = itemsForObject({ id: 1, name: 'A', creator: 'X' }, { files: { items: [
    { id: 10, filename: 'Supported.zip', size: '100', download_url: url },
    { id: 12, filename: 'Unsupported.zip', size: '90', download_url: url },
    { id: 11, filename: 'No URL.zip', size: '5' },
  ] } }, ['X', 'B']);
  const b = itemsForObject({ id: 2, name: 'B', creator: 'X' }, obj([[20, 'Supported.zip', 7], [21, 'Lychee.zip', 8]]), ['X', 'B']);
  assert.equal(a.length, 2, 'files without a download_url are skipped');
  assert.equal(a[0].size, 100);
  const items = resolveNameClashes([...a, ...b]);
  assert.deepEqual(items.map((i) => i.filename), ['Supported [1].zip', 'Unsupported.zip', 'Supported [2].zip', 'Lychee.zip']);
});

test('single-file models are named after the MMF page title (keeps race/class)', () => {
  const url = 'https://www.myminifactory.com/download/9?archive_id=9';
  const [kevin] = itemsForObject({ id: 9, name: 'Kevin Bightwood - Half-orc Barbarian', creator: 'Artificers_Mini' },
    { files: { items: [{ id: 1, filename: 'Kevin Brightwood.zip', size: '50', download_url: url }] } }, ['Artificers_Mini', 'Welcome Pack']);
  assert.equal(kevin.filename, 'Kevin Bightwood - Half-orc Barbarian.zip');
  assert.equal(kevin.originalFilename, 'Kevin Brightwood.zip');
  const pair = itemsForObject({ id: 8, name: 'Wendigo', creator: 'Rescale' },
    { files: { items: [{ id: 1, filename: 'Wendigo_Supports.zip', size: '5', download_url: url }, { id: 2, filename: 'Wendigo_Unsupported.zip', size: '6', download_url: url }] } }, ['R', 'X']);
  assert.deepEqual(pair.map((i) => i.filename), ['Wendigo_Supports.zip', 'Wendigo_Unsupported.zip'], 'multi-file models keep creator names');
  // A solo listing renamed after its title still dedupes against the bundle's copy.
  const bundle = itemsForObject({ id: 7, name: 'Release: Duskhelm', creator: 'Rescale' },
    { files: { items: [{ id: 3, filename: 'Wendigo_Supports.zip', size: '5', download_url: url }, { id: 4, filename: 'Other.zip', size: '1', download_url: url }] } }, ['R', 'X']);
  const solo = itemsForObject({ id: 6, name: 'Wendigo Supported', creator: 'Rescale' },
    { files: { items: [{ id: 5, filename: 'Wendigo_Supports.zip', size: '5', download_url: url }] } }, ['R', 'X']);
  assert.equal(solo[0].filename, 'Wendigo Supported.zip');
  assert.equal(dedupeItems([...solo, ...bundle]).dupes, 1);
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

