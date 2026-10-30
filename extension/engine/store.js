// Everything 2.0 keeps lives in the extension's own IndexedDB: the download
// queue, settings, the archive folder handle (a handle can be stored; a path
// can't), cached model file lists and the history log.

const DB_NAME = 'mmf-downloader';
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('objects')) db.createObjectStore('objects');
      if (!db.objectStoreNames.contains('history')) db.createObjectStore('history', { autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const result = fn(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Storage transaction aborted'));
  });
}

export const get = (key, storeName = 'kv') => run(storeName, 'readonly', (s) => s.get(key));
export const set = (key, value, storeName = 'kv') => run(storeName, 'readwrite', (s) => { s.put(value, key); });
export const del = (key, storeName = 'kv') => run(storeName, 'readwrite', (s) => { s.delete(key); });

export const getObject = (id) => get(String(id), 'objects');
export const setObject = (id, obj) => set(String(id), obj, 'objects');

export function appendHistory(event) {
  return run('history', 'readwrite', (s) => { s.add({ t: new Date().toISOString(), ...event }); });
}

// Newest first, up to `limit`.
export async function readHistory(limit = 10000) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const out = [];
    const req = db.transaction('history').objectStore('history').openCursor(null, 'prev');
    req.onsuccess = () => {
      const c = req.result;
      if (!c || out.length >= limit) return resolve(out);
      out.push(c.value);
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
}
