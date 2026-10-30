import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readZipEntries as readCore, packedName, findPacked as findCore } from '../extension/core/zip.js';
import { mergeQueue } from '../extension/core/queue.js';
import { memoryDisk } from './engine-fakes.js';

// In-memory "files" for the shared core (the extension reads real files the same way).
const files = new Map();
const writeFile = async (name, data) => { files.set(name, Buffer.from(data)); };
const bytesReader = (b) => ({ size: b.byteLength, read: async (p, l) => b.subarray(p, p + l) });
const readZipEntries = async (name) => readCore(bytesReader(files.get(name)));
const findPacked = (dir, item, size) => findCore(item, size, async (n) => (files.has(`${dir}/${n}`) ? readZipEntries(`${dir}/${n}`) : null));
const path = { join: (...p) => p.join('/') };

// Minimal zip writer for tests. `claimed` overrides the size recorded in the
// central directory (to fake members over 4 GB); zip64 forces ZIP64 records.
function makeZip(entries, { zip64 = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data = Buffer.from('x'), claimed } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const size = claimed ?? data.length;
    const big = zip64 || size >= 0xffffffff;
    const extra = Buffer.alloc(big ? 4 + 24 : 0);
    if (big) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(size), 4);
      extra.writeBigUInt64LE(BigInt(size), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
    }
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(0x800, 8);
    c.writeUInt32LE(big ? 0xffffffff : size, 20);
    c.writeUInt32LE(big ? 0xffffffff : size, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt16LE(extra.length, 30);
    c.writeUInt32LE(big ? 0xffffffff : offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(c, nameBuf, extra);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const tailParts = [];
  if (zip64) {
    const z = Buffer.alloc(56);
    z.writeUInt32LE(0x06064b50, 0);
    z.writeBigUInt64LE(44n, 4);
    z.writeBigUInt64LE(BigInt(entries.length), 24);
    z.writeBigUInt64LE(BigInt(entries.length), 32);
    z.writeBigUInt64LE(BigInt(cd.length), 40);
    z.writeBigUInt64LE(BigInt(offset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(offset + cd.length), 8);
    loc.writeUInt32LE(1, 16);
    tailParts.push(z, loc);
  }
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
  e.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  e.writeUInt32LE(zip64 ? 0xffffffff : cd.length, 12);
  e.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  return Buffer.concat([...locals, cd, ...tailParts, e]);
}

let tmpN = 0;
const tmp = async () => `tmp${++tmpN}`;

test('zip: reads names and sizes, plain and ZIP64 (> 4 GB members)', async () => {
  const dir = await tmp();
  await writeFile(path.join(dir, 'a.zip'), makeZip([{ name: 'X_Supports.zip', data: Buffer.alloc(10) }, { name: 'Ünsupported.zip', data: Buffer.alloc(3) }]));
  assert.deepEqual([...await readZipEntries(path.join(dir, 'a.zip'))], [['X_Supports.zip', 10], ['Ünsupported.zip', 3]]);
  await writeFile(path.join(dir, 'b.zip'), makeZip([{ name: 'X_Supports.zip', claimed: 4421650203 }, { name: 'X_Unsupported.zip', claimed: 12 }], { zip64: true }));
  assert.deepEqual([...await readZipEntries(path.join(dir, 'b.zip'))], [['X_Supports.zip', 4421650203], ['X_Unsupported.zip', 12]]);
  await writeFile(path.join(dir, 'c.zip'), 'not a zip at all, just text padding......');
  await assert.rejects(readZipEntries(path.join(dir, 'c.zip')), /Not a zip/);
});

test('zip: packed names follow the combiner rule', () => {
  assert.equal(packedName('Razoraptor_Supports.zip'), 'Razoraptor.zip');
  assert.equal(packedName('Pack X_01_Unsupported.zip'), 'Pack X_01.zip');
  assert.equal(packedName('Thing_Supported.ZIP'), 'Thing.zip');
  assert.equal(packedName('BriarDragon.zip'), 'BriarDragon.zip');
  assert.equal(packedName('book.pdf'), null);
});

test('zip: findPacked matches by name+size, or by size for the combined name', async () => {
  const dir = await tmp();
  await writeFile(path.join(dir, 'Briar.zip'), makeZip([{ name: 'Briar_Supports.zip', claimed: 100 }, { name: 'Briar_Unsupported.zip', claimed: 200 }]));
  assert.equal(await findPacked(dir, { filename: 'Briar_Supports.zip' }, 100), 'Briar.zip');
  assert.equal(await findPacked(dir, { filename: 'Briar_Supports.zip' }, 101), null); // size must match
  assert.equal(await findPacked(dir, { filename: 'Briar.zip' }, 200), 'Briar.zip'); // duplicate bare download
  assert.equal(await findPacked(dir, { filename: 'Briar.zip' }, 999), null);
  assert.equal(await findPacked(dir, { filename: 'Briar_Supports.zip' }, null), 'Briar.zip'); // size unknown: name
  assert.equal(await findPacked(dir, { filename: 'Other_Supports.zip' }, 100), null); // no combined zip
  assert.equal(await findPacked(dir, { filename: 'Briarwood.zip' }, 100), null);
});

test('queue: files folded into a combined zip stay done (no re-download)', async () => {
  const disk = memoryDisk();
  disk.files.set('Rescale/2025-05/Raptor.zip', makeZip([{ name: 'Raptor_Supports.zip', claimed: 5_000_000_000 }, { name: 'Raptor_Unsupported.zip', claimed: 300 }], { zip64: true }));
  const base = { creator: 'Rescale', dest: ['Rescale', '2025-05'], objectFileCount: 2 };
  const planned = [
    { ...base, key: '1:1', objectId: 1, fileId: 1, filename: 'Raptor_Supports.zip', size: 5_000_000_000 },
    { ...base, key: '1:2', objectId: 1, fileId: 2, filename: 'Raptor_Unsupported.zip', size: 300 },
    { ...base, key: '2:9', objectId: 2, fileId: 9, filename: 'Raptor.zip', size: 300 }, // bare duplicate
    { ...base, key: '3:1', objectId: 3, fileId: 1, filename: 'Gone_Supports.zip', size: 50 },
  ];
  const existing = { items: planned.map((p) => ({ ...p, status: 'done', doneBytes: p.size })) };
  const q = await mergeQueue(existing, planned, disk);
  const by = Object.fromEntries(q.items.map((i) => [i.key, i]));
  assert.equal(by['1:1'].status, 'done');
  assert.equal(by['1:1'].packedIn, 'Raptor.zip');
  assert.equal(by['1:2'].status, 'done');
  assert.equal(by['2:9'].status, 'done');
  assert.equal(by['3:1'].status, 'pending'); // really missing: still a gap
  assert.equal(by['3:1'].packedIn, undefined);
});
