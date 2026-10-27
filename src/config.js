// Loads config.local.json (secrets + settings) and resolves project paths.
// Secrets live only in *.local.json files, which .gitignore keeps out of git.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(PROJECT_DIR, 'data');
export const CONFIG_PATH = path.join(PROJECT_DIR, 'config.local.json');
export const TOKENS_PATH = path.join(DATA_DIR, 'tokens.local.json');
export const LIBRARY_PATH = path.join(DATA_DIR, 'library.json');
export const OBJECTS_DIR = path.join(DATA_DIR, 'objects');
export const LOG_PATH = path.join(DATA_DIR, 'run-log.jsonl');
export const QUEUE_PATH = path.join(DATA_DIR, 'queue.json');
export const UNAVAILABLE_PATH = path.join(DATA_DIR, 'unavailable.json');
export const PREVIEWS_PATH = path.join(DATA_DIR, 'objectPreviews.json');
export const RELEASES_PATH = path.join(DATA_DIR, 'releases.json');

const DEFAULTS = {
  redirectPort: 8765,
  apiDelayMs: 3000,
  downloadDelayMs: 5000,
  excludeCreators: [],
  bundleTitles: {},
  bridgePort: 8766,
  maxDownloadsPerHour: 120,
  stagingFolderName: 'MMF-staging',
};

export async function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `No config found. Copy config.example.json to config.local.json and fill in clientSecret.\n  (${CONFIG_PATH})`
    );
  }
  const cfg = { ...DEFAULTS, ...JSON.parse(await readFile(CONFIG_PATH, 'utf8')) };
  for (const key of ['clientId', 'clientSecret', 'archiveRoot']) {
    if (!cfg[key] || String(cfg[key]).startsWith('PASTE_')) {
      throw new Error(`config.local.json is missing "${key}".`);
    }
  }
  return cfg;
}

export async function readJson(file, fallback = undefined) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(await readFile(file, 'utf8'));
}

// Write via temp file + rename so a crash never leaves half-written JSON.
export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, file);
}
