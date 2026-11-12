// Runs the 2.0 engine in a hidden background page (chrome.offscreen), so
// downloads continue with the dashboard closed. The dashboard talks to it
// with chrome.runtime messages: { to: 'engine', cmd, args }.

import { createEngine, NeedsFolderError } from './engine.js';
import * as store from './store.js';
import { folderDisk } from './disk.js';

let disk = null;
let diskFor = null;

async function folderInfo() {
  const handle = await store.get('dir');
  if (!handle) return { picked: false };
  return { picked: true, name: handle.name, permission: await handle.queryPermission({ mode: 'readwrite' }) };
}

async function getDisk() {
  const handle = await store.get('dir');
  if (!handle) throw new NeedsFolderError('Pick your archive folder first (📁 in the dashboard).');
  const perm = await handle.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') throw new NeedsFolderError('Chrome needs your OK to use the archive folder again: open the dashboard and click "Allow folder".');
  if (!disk || !(await diskFor.isSameEntry(handle))) { disk = folderDisk(handle); diskFor = handle; }
  return disk;
}

// The optional PDF folder (⚙): null when none is picked.
let pdfDisk = null;
let pdfDiskFor = null;

async function pdfFolderInfo() {
  const handle = await store.get('pdfDir');
  if (!handle) return { picked: false };
  return { picked: true, name: handle.name, permission: await handle.queryPermission({ mode: 'readwrite' }) };
}

async function getPdfDisk() {
  const handle = await store.get('pdfDir');
  if (!handle) return null;
  const perm = await handle.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') throw new NeedsFolderError('Chrome needs your OK to use the PDF folder again: open the dashboard and click "Allow folder".');
  if (!pdfDisk || !(await pdfDiskFor.isSameEntry(handle))) { pdfDisk = folderDisk(handle); pdfDiskFor = handle; }
  return pdfDisk;
}

let notifyTimer = null;
const engine = createEngine({
  store,
  getDisk,
  getPdfDisk,
  log: (m) => console.log('[engine]', m),
  onChange: () => {
    // Tell open dashboards (at most a few times a second).
    if (notifyTimer) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      chrome.runtime.sendMessage({ type: 'engine-changed' }).catch(() => {});
    }, 250);
  },
});

const ready = (async () => {
  const { resume } = await engine.init();
  if (resume) {
    try { await engine.start(); } catch (e) { console.log('[engine] not resuming:', e.message); }
  }
})();

const commands = {
  status: async () => ({ ...engine.status(), folder: await folderInfo(), pdfFolder: await pdfFolderInfo() }),
  tree: (opts) => ({ tree: engine.tree({ hidden: opts?.hidden === true }), newSince: engine.newSince() }),
  history: async () => ({ events: await engine.history() }),
  start: () => engine.start(),
  pause: () => engine.pause(),
  setSkip: ({ objectIds, skip }) => engine.setSkip(objectIds, skip),
  setHidden: ({ objectIds, hidden }) => engine.setHidden(objectIds, hidden),
  retryFailed: () => engine.retryFailed(),
  clearFailed: () => engine.clearFailed(),
  sync: () => engine.sync(),
  saveSettings: (patch) => engine.saveSettings(patch),
  locate: (where) => engine.locate(where),
  creators: async () => ({ creators: await engine.creators() }),
  folderChanged: () => { disk = null; diskFor = null; pdfDisk = null; pdfDiskFor = null; return { ok: true }; },
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.to !== 'engine') return false;
  const fn = commands[msg.cmd];
  if (!fn) { reply({ ok: false, error: `Unknown command ${msg.cmd}` }); return false; }
  ready
    .then(() => fn(msg.args ?? {}))
    .then((r) => reply(r ?? { ok: true }))
    .catch((e) => reply({ ok: false, error: e.message, needsFolder: e instanceof NeedsFolderError }));
  return true;
});
