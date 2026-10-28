// One-time setup for the dashboard's "Start bridge" button: registers the
// native messaging host with Chrome for the current Windows user (HKCU, no
// admin) and allows only the MMF Downloader extension to call it.

import path from 'node:path';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PROJECT_DIR, DATA_DIR } from './config.js';
import { HOST_NAME } from './native-host.js';

const run = promisify(execFile);
const EXT_ID = /^[a-p]{32}$/;
export const REG_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// Finds the id Chrome gave our unpacked extension, in every Chrome profile.
export async function findExtensionIds(userDataDir, extensionDir) {
  const ids = new Set();
  let profiles = [];
  try { profiles = await readdir(userDataDir, { withFileTypes: true }); } catch { return []; }
  for (const p of profiles.filter((d) => d.isDirectory())) {
    for (const file of ['Secure Preferences', 'Preferences']) {
      const f = path.join(userDataDir, p.name, file);
      if (!existsSync(f)) continue;
      let settings;
      try { settings = JSON.parse(await readFile(f, 'utf8'))?.extensions?.settings; } catch { continue; }
      for (const [id, s] of Object.entries(settings ?? {})) {
        if (EXT_ID.test(id) && typeof s?.path === 'string' && samePath(s.path, extensionDir)) ids.add(id);
      }
    }
  }
  return [...ids];
}

export function hostManifest(cmdPath, ids) {
  return {
    name: HOST_NAME,
    description: 'Starts the MMF Downloader bridge',
    path: cmdPath,
    type: 'stdio',
    allowed_origins: ids.map((id) => `chrome-extension://${id}/`),
  };
}

export async function installHost({ extraIds = [], log = console.log } = {}) {
  if (process.platform !== 'win32') throw new Error('install-host is Windows only.');
  const bad = extraIds.filter((id) => !EXT_ID.test(id));
  if (bad.length) throw new Error(`Not a Chrome extension id: ${bad.join(', ')}`);

  const userData = path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'User Data');
  const found = await findExtensionIds(userData, path.join(PROJECT_DIR, 'extension'));
  const ids = [...new Set([...found, ...extraIds])];
  if (!ids.length) {
    throw new Error('Could not find the MMF Downloader extension in Chrome. Load it first (chrome://extensions → Load unpacked), or pass its id: node mmf.js install-host <id>');
  }

  const dir = path.join(DATA_DIR, 'native-host');
  await mkdir(dir, { recursive: true });
  const cmdPath = path.join(dir, 'mmf-bridge-host.cmd');
  const hostJs = path.join(PROJECT_DIR, 'src', 'native-host.js');
  await writeFile(cmdPath, `@echo off\r\n"${process.execPath}" "${hostJs}" %*\r\n`);
  const manifestPath = path.join(dir, `${HOST_NAME}.json`);
  await writeFile(manifestPath, JSON.stringify(hostManifest(cmdPath, ids), null, 2));
  await run('reg', ['add', REG_KEY, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f']);

  log(`Registered "Start bridge" helper for extension ${ids.join(', ')}.`);
  log('Reload the extension in chrome://extensions, then reopen the dashboard.');
  return { ids, manifestPath, cmdPath };
}
