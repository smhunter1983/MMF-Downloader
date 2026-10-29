// Chrome native messaging host: lets the dashboard's "Start bridge" button
// launch `node mmf.js serve` in its own window. It understands exactly one
// command ({ cmd: 'startBridge' }) and does nothing else.
//
// Protocol (Chrome): each message is a 4-byte little-endian length followed by
// that many bytes of UTF-8 JSON, on stdin/stdout. stdout carries ONLY replies.

import { spawn } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_DIR } from './config.js';

export const HOST_NAME = 'com.mmf_downloader.bridge';
const MAX_MESSAGE = 64 * 1024;
const BRIDGE_URL = 'http://127.0.0.1:8766/status';

export function encodeMessage(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

// Reads one framed message from a readable stream.
export function readMessage(stream) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const done = (fn, v) => { stream.off('data', onData); stream.off('end', onEnd); stream.off('error', reject); fn(v); };
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 4) return;
      const len = buf.readUInt32LE(0);
      if (len > MAX_MESSAGE) return done(reject, new Error('Message too large'));
      if (buf.length < 4 + len) return;
      try { done(resolve, JSON.parse(buf.subarray(4, 4 + len).toString('utf8'))); }
      catch { done(reject, new Error('Message is not valid JSON')); }
    };
    const onEnd = () => done(reject, new Error('Input closed before a full message arrived'));
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', reject);
  });
}

export async function bridgeIsUp(fetchImpl = fetch) {
  try {
    const res = await fetchImpl(BRIDGE_URL, { headers: { 'X-MMF-Bridge': '1' }, signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

// PowerShell's -EncodedCommand takes base64 of UTF-16LE: no quoting pitfalls.
export const encodePs = (script) => Buffer.from(script, 'utf16le').toString('base64');
const psQuote = (s) => `'${s.replace(/'/g, "''")}'`; // PowerShell single-quoted literal

// Opens a visible PowerShell window titled "MMF Downloader bridge" running the
// bridge. A hidden PowerShell calls Start-Process, which gives the bridge its
// own new console window. (Node's `detached` would start it with no console
// at all, and PowerShell exits at once.) Nothing touches our stdout pipe.
export function launchBridge({ projectDir = PROJECT_DIR, nodePath = process.execPath, spawnImpl = spawn } = {}) {
  const mmf = path.join(projectDir, 'mmf.js');
  const inner = `$Host.UI.RawUI.WindowTitle = 'MMF Downloader bridge'; & ${psQuote(nodePath)} ${psQuote(mmf)} serve`;
  const outer = `Start-Process powershell.exe -WorkingDirectory ${psQuote(projectDir)} -ArgumentList '-NoExit','-NoProfile','-EncodedCommand','${encodePs(inner)}'`;
  const child = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encodePs(outer)], {
    cwd: projectDir,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on?.('error', () => {}); // reported via the "did not answer" timeout
  return child;
}

export async function handleMessage(msg, {
  isUp = bridgeIsUp, launch = launchBridge, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  waitMs = 15000, stepMs = 500, platform = process.platform,
} = {}) {
  if (msg?.cmd !== 'startBridge') return { ok: false, error: 'Unknown command' };
  if (platform !== 'win32') return { ok: false, error: 'Starting the bridge from Chrome is Windows only' };
  if (await isUp()) return { ok: true, alreadyRunning: true };
  launch();
  for (let waited = 0; waited < waitMs; waited += stepMs) {
    await sleep(stepMs);
    if (await isUp()) return { ok: true, started: true };
  }
  return { ok: false, error: 'Bridge window opened but did not answer within 15s. Check that window for an error.' };
}

async function main() {
  let reply;
  try {
    reply = await handleMessage(await readMessage(process.stdin));
  } catch (err) {
    reply = { ok: false, error: err.message };
  }
  // One line per call, so we can tell whether Chrome started the helper at all.
  const line = `${new Date().toISOString()} ${JSON.stringify(reply)}\n`;
  await appendFile(path.join(PROJECT_DIR, 'data', 'native-host', 'host.log'), line).catch(() => {});
  process.stdout.write(encodeMessage(reply), () => process.exit(0));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
