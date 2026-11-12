import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArchivesFromPage, itemsForObject, isStaleObject, PAGE_FORMAT } from '../extension/core/items.js';
import { describePage } from '../extension/core/zip.js';

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

test('core: PDFs use their own download link from the page, never ?archive_id=', () => {
  // Shape copied from a real model page (Mammoth Factory, object 875541).
  const html = `<script>x = {"archives":[{"id":617264,"path":"Rite v1.1 - Adventure PDF.pdf.zip","size":"50826177","download_url":"https:\\/\\/www.myminifactory.com\\/download\\/875541?archive_id=617264"}],"pdfFiles":[{"id":10325,"name":"Rite of the Black Feather v1.1.pdf","status":"upload-completed","size":"51385676","createdAt":"2026-11-09T16:28:44+00:00","watermarkable":null,"downloadOriginalUrl":"\\/download\\/pdf\\/10325\\/watermark","downloadInfoUrl":"\\/download\\/pdf\\/10325\\/download-info"}],"csrf_token":"t"}</script>`;
  const obj = parseArchivesFromPage(html, 875541);
  assert.equal(obj.format, PAGE_FORMAT);
  assert.deepEqual(obj.files.items.map((f) => [f.id, f.filename, f.size, f.download_url]), [
    [617264, 'Rite v1.1 - Adventure PDF.pdf.zip', 50826177, 'https://www.myminifactory.com/download/875541?archive_id=617264'],
    [10325, 'Rite of the Black Feather v1.1.pdf', 51385676, 'https://www.myminifactory.com/download/pdf/10325/watermark'],
  ]);
  // No link on the page, or one pointing somewhere else: the standard PDF link.
  const url = (pdf) => parseArchivesFromPage(`{"archives":[],"pdfFiles":[${JSON.stringify(pdf)}]}`, 5).files.items[0].download_url;
  assert.equal(url({ id: 9, path: 'Rules.pdf', size: '100' }), 'https://www.myminifactory.com/download/pdf/9/watermark');
  assert.equal(url({ id: 9, name: 'Rules.pdf', downloadOriginalUrl: 'https://evil.example/download/x' }), 'https://www.myminifactory.com/download/pdf/9/watermark');
  assert.equal(url({ id: 9, name: 'Rules.pdf', downloadOriginalUrl: '/login' }), 'https://www.myminifactory.com/download/pdf/9/watermark');
});

test('core: only remembered file lists with a PDF, saved by an older build, are read again', () => {
  const list = (names, format) => ({ id: 1, ...(format ? { format } : {}), files: { items: names.map((n, i) => ({ id: i, filename: n })) } });
  assert.equal(isStaleObject(list(['A.zip', 'Book.PDF'])), true);
  assert.equal(isStaleObject(list(['A.zip', 'Book.pdf.zip'])), false);
  assert.equal(isStaleObject(list(['A.zip', 'Book.pdf'], PAGE_FORMAT)), false);
  assert.equal(isStaleObject(null), false);
});

test('core: a stray web page is described by its title and where it came from', () => {
  const M = 'https://www.myminifactory.com';
  assert.deepEqual(describePage('<!DOCTYPE html><html><head><title>Just a moment...</title>', `${M}/download/1?archive_id=2`), { title: 'Just a moment...', kind: 'check' });
  assert.deepEqual(describePage('<!doctype html><title>\n  3D Printable Rite &amp; Feather\n   by Mammoth Factory </title>', `${M}/object/3d-print-rite-875541`), { title: '3D Printable Rite & Feather by Mammoth Factory', kind: 'model' });
  assert.equal(describePage('<html><title>Login | MyMiniFactory</title>', `${M}/login`).kind, 'login');
  assert.equal(describePage('<html><title>Log in</title>', '').kind, 'login');
  assert.deepEqual(describePage('<html><body>hi', ''), { title: '', kind: 'unknown' });
  // A check page wins even when it is shown at a model address.
  assert.equal(describePage('<html><title>Attention Required! | Cloudflare</title>', `${M}/object/3d-print-1`).kind, 'check');
});
