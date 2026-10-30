import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArchivesFromPage, itemsForObject } from '../extension/core/items.js';

// Shaped like MMF's model page (JSON inside a script, escaped slashes).
const PAGE = `<html><script>var data = {"name":"Master Wendigo","images":[{"url":"https:\\/\\/assets.myminifactory.com\\/x.jpg","download_url":null}],
"archives":[{"id":108451,"path":"Master Wendigo Lychee.zip","size":"86528557","download_url":"https:\\/\\/www.myminifactory.com\\/download\\/276218?archive_id=108451"},
{"id":108452,"path":"Odd \\"quoted\\" ] name.zip","size":"282028827","download_url":null}],"other":{"x":[1,2]}};</script></html>`;

test('core: parses the download list from a model page, same shape as the API', () => {
  const obj = parseArchivesFromPage(PAGE, 276218);
  assert.deepEqual(obj.files.items, [
    { id: 108451, filename: 'Master Wendigo Lychee.zip', size: 86528557, download_url: 'https://www.myminifactory.com/download/276218?archive_id=108451' },
    { id: 108452, filename: 'Odd "quoted" ] name.zip', size: 282028827, download_url: 'https://www.myminifactory.com/download/276218?archive_id=108452' },
  ]);
  assert.equal(parseArchivesFromPage('<html>Just a moment...</html>', 1), null);
  const items = itemsForObject({ id: 276218, name: 'Master Wendigo', creator: 'Mini Monster Mayhem' }, obj, ['Mini Monster Mayhem', '2026-10']);
  assert.deepEqual(items.map((i) => [i.key, i.filename, i.size]), [
    ['276218:108451', 'Master Wendigo Lychee.zip', 86528557],
    ['276218:108452', 'Odd _quoted_ ] name.zip', 282028827],
  ]);
});

test('core: loose-part pages (filesInfo) become one whole-model item, like the API', () => {
  const page = `<script>window.x = {"archives":[],"pdfFiles":[],"csrf_token":"t"};
    state.filesInfo[1544916] = { "name": "bigbyp.stl" } $(function(){});
    state.filesInfo[1544917] = { "name": "base.lys" }</script>`;
  const obj = parseArchivesFromPage(page, 244272);
  assert.deepEqual(obj.files.items.map((f) => [f.id, f.filename, f.size]), [[1544916, 'bigbyp.stl', null], [1544917, 'base.lys', null]]);
  assert.equal(obj.files.items[0].download_url, 'https://www.myminifactory.com/download/244272?downloadfile=bigbyp.stl');
  const items = itemsForObject({ id: 244272, name: 'Massive Mage Hand, Spell Effect', creator: 'Ranger Fox' }, obj, ['Ranger Fox', 'Purchases']);
  assert.deepEqual(items.map((i) => [i.key, i.filename, i.wholeZip]), [['244272:whole', 'Massive Mage Hand, Spell Effect.zip', true]]);
  assert.deepEqual(parseArchivesFromPage('<script>{"archives":[],"pdfFiles":[{"id":9,"path":"Rules.pdf","size":"100"}]}</script>', 5).files.items.map((f) => f.filename), ['Rules.pdf']);
});
