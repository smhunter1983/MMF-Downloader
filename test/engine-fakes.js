// In-memory stand-ins for the 2.0 engine's storage, archive folder and MMF.
import { readZipEntries } from '../extension/core/zip.js';

export function memoryStore() {
  const kv = new Map();
  const objects = new Map();
  const hist = [];
  return {
    kv, objects, hist,
    get: async (k) => structuredClone(kv.get(k)),
    set: async (k, v) => { kv.set(k, structuredClone(v)); },
    getObject: async (id) => structuredClone(objects.get(String(id))),
    setObject: async (id, o) => { objects.set(String(id), structuredClone(o)); },
    appendHistory: async (e) => { hist.push({ t: new Date().toISOString(), ...e }); },
    readHistory: async (limit) => hist.slice(-limit).reverse(),
  };
}

const reader = (bytes) => ({ size: bytes.byteLength, read: async (p, l) => bytes.subarray(p, p + l) });

export function memoryDisk() {
  const files = new Map(); // "a/b/c.zip" -> Uint8Array
  const key = (parts) => parts.join('/');
  return {
    files,
    sizeOf: async (parts) => files.get(key(parts))?.byteLength ?? null,
    file: async (parts) => files.get(key(parts)) ?? null,
    move: async (from, to) => {
      if (!files.has(key(from))) throw new Error(`Not found: ${key(from)}`);
      if (files.has(key(to))) throw new Error(`Already exists: ${key(to)}`);
      files.set(key(to), files.get(key(from)));
      files.delete(key(from));
    },
    zipEntries: async (parts) => (files.has(key(parts)) ? readZipEntries(reader(files.get(key(parts)))) : null),
    remove: async (parts) => { files.delete(key(parts)); },
    writer: async (parts) => {
      const chunks = [];
      return {
        write: async (b) => { chunks.push(new Uint8Array(b)); },
        close: async () => { files.set(key(parts), Buffer.concat(chunks)); },
        abort: async () => {},
      };
    },
    reader: async (parts) => reader(files.get(key(parts))),
  };
}

// A minimal stored zip with one member.
export function makeZip(name, content) {
  const data = Buffer.from(content);
  const fname = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(fname.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(fname.length, 28);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + fname.length, 12);
  eocd.writeUInt32LE(local.length + fname.length + data.length, 16);
  return Buffer.concat([local, fname, data, central, fname, eocd]);
}

// A valid binary STL with n triangles.
export function makeStl(n = 2) {
  const b = Buffer.alloc(84 + 50 * n);
  b.writeUInt32LE(n, 80);
  return b;
}

// Fake fetch: routes is { url: () => Response | [status, body, headers] }.
export function fakeFetch(routes) {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    const r = routes[url];
    if (!r) return new Response('not found', { status: 404 });
    const out = typeof r === 'function' ? r(calls.filter((c) => c === url).length) : r;
    if (out instanceof Response) return out;
    const [status, body, headers] = out;
    return new Response(body, { status, headers });
  };
  f.calls = calls;
  return f;
}

// A clock that sleep() advances instantly.
export function fakeClock(start = Date.parse('2026-11-01T12:00:00Z')) {
  let t = start;
  return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } };
}
