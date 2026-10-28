import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { encodeMessage, readMessage, handleMessage, launchBridge } from '../src/native-host.js';
import { findExtensionIds, hostManifest } from '../src/install-host.js';

test('native host: framing round-trips, including split chunks', async () => {
  const s = new PassThrough();
  const p = readMessage(s);
  const buf = encodeMessage({ cmd: 'startBridge', note: 'é' });
  s.write(buf.subarray(0, 3));
  s.write(buf.subarray(3, 9));
  s.write(buf.subarray(9));
  assert.deepEqual(await p, { cmd: 'startBridge', note: 'é' });
});

test('native host: rejects oversized and truncated messages', async () => {
  const big = new PassThrough();
  const head = Buffer.alloc(4); head.writeUInt32LE(10 * 1024 * 1024);
  const p1 = readMessage(big); big.write(head);
  await assert.rejects(p1, /too large/);
  const cut = new PassThrough();
  const p2 = readMessage(cut); cut.end(encodeMessage({ a: 1 }).subarray(0, 6));
  await assert.rejects(p2, /closed/);
});

test('native host: only startBridge, and never launches twice', async () => {
  let launched = 0;
  const opts = { platform: 'win32', launch: () => launched++, sleep: async () => {} };
  assert.equal((await handleMessage({ cmd: 'rm -rf' }, { ...opts, isUp: async () => false })).ok, false);
  assert.deepEqual(await handleMessage({ cmd: 'startBridge' }, { ...opts, isUp: async () => true }), { ok: true, alreadyRunning: true });
  assert.equal(launched, 0);

  let checks = 0;
  const r = await handleMessage({ cmd: 'startBridge' }, { ...opts, isUp: async () => ++checks > 3 });
  assert.deepEqual(r, { ok: true, started: true });
  assert.equal(launched, 1);

  const never = await handleMessage({ cmd: 'startBridge' }, { ...opts, isUp: async () => false, waitMs: 2000 });
  assert.equal(never.ok, false);
  assert.equal(launched, 2);
  assert.equal((await handleMessage({ cmd: 'startBridge' }, { ...opts, platform: 'linux' })).ok, false);
});

test('native host: launches the bridge via Start-Process with quoted paths', () => {
  let call;
  launchBridge({ projectDir: "C:\\it's here", nodePath: 'C:\\node\\node.exe', spawnImpl: (...a) => { call = a; return {}; } });
  const [cmd, args, opts] = call;
  assert.equal(cmd, 'powershell.exe');
  assert.equal(opts.stdio, 'ignore'); // must never touch Chrome's stdout pipe
  const decode = (b64) => Buffer.from(b64, 'base64').toString('utf16le');
  const outer = decode(args.at(-1));
  assert.match(outer, /^Start-Process powershell\.exe -WorkingDirectory 'C:\\it''s here' -ArgumentList '-NoExit','-NoProfile','-EncodedCommand','([A-Za-z0-9+/=]+)'$/);
  const inner = decode(outer.match(/'([A-Za-z0-9+/=]{20,})'$/)[1]);
  assert.match(inner, /WindowTitle = 'MMF Downloader bridge'; & 'C:\\node\\node.exe' 'C:\\it''s here[\\/]mmf.js' serve$/);
});

test('install-host: finds the extension id by its folder, in any profile', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mmf-chrome-'));
  const ext = path.join(root, 'proj', 'extension');
  const mine = 'pgnkhjhdpiiiebndpjbkdbldkdccmdoe';
  await mkdir(path.join(root, 'Default'));
  await mkdir(path.join(root, 'Profile 2'));
  await writeFile(path.join(root, 'Default', 'Secure Preferences'), JSON.stringify({ extensions: { settings: {
    [mine]: { path: ext }, aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: { path: path.join(root, 'other') },
  } } }));
  await writeFile(path.join(root, 'Profile 2', 'Preferences'), '{not json');
  assert.deepEqual(await findExtensionIds(root, ext), [mine]);
  assert.deepEqual(await findExtensionIds(path.join(root, 'missing'), ext), []);
  assert.deepEqual(hostManifest('C:\\h.cmd', [mine]).allowed_origins, [`chrome-extension://${mine}/`]);
});
