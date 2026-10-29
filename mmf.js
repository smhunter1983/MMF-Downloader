#!/usr/bin/env node
// MMF Downloader CLI. Run `node mmf.js help` for commands.

import path from 'node:path';
import { loadConfig, readJson, writeJson, OBJECTS_DIR, RELEASES_PATH, PREVIEWS_PATH } from './src/config.js';
import { login } from './src/auth.js';
import { createApi } from './src/api.js';
import { importLibrary, loadLibrary, applyExclusions, deriveGroupTitles, bundleFor, LIBRARY_URL } from './src/library.js';
import { buildPlan } from './src/plan.js';
import { loadQueue, summarize } from './src/queue.js';
import { createBridge } from './src/bridge.js';
import { installHost } from './src/install-host.js';

const HELP = `
MMF Downloader

  node mmf.js login                 Authorize with MMF in your browser
  node mmf.js whoami                Check the login works
  node mmf.js library <file.json>   Import your saved library list
  node mmf.js bundles               Preview the Creator\\Bundle folders
  node mmf.js inspect <id>          Show what MMF returns for one object
  node mmf.js plan [--refresh]      Fetch file lists and build the download queue
                                    (re-run any time: it also finds gaps)
  node mmf.js serve                 Start the bridge for the Chrome extension
  node mmf.js status                Show queue progress
  node mmf.js install-host [id]     One-time: enable the dashboard's "Start bridge"
                                    button (Windows, current user only)

Library list: while logged in to MMF in Chrome, open
  ${LIBRARY_URL}
then press Ctrl+S and save it as data\\objectPreviews.json
`;

const gb = (b) => `${(b / 1073741824).toFixed(1)} GB`;
const flag = (name) => process.argv.includes(`--${name}`);

function printSummary(q) {
  const s = summarize(q);
  console.log(`Files: ${s.done} done, ${s.pending} pending, ${s.failed} failed (${s.total} total)`);
  console.log(`Data:  ${gb(s.bytesDone)} of ${gb(s.bytesTotal)}`);
}

async function cmdLibrary(file) {
  const { rawCount, entries: all } = await importLibrary(file);
  const cfg = await loadConfig().catch(() => ({ excludeCreators: [] }));
  const { kept, excluded } = applyExclusions(all, cfg.excludeCreators);
  if (excluded.length) console.log(`Excluded ${excluded.length} object(s) from: ${cfg.excludeCreators.join(', ')}`);
  const creators = new Set(kept.map((e) => e.creator));
  console.log(`To archive: ${kept.length} unique objects (${all.length} imported from ${rawCount} rows), ${creators.size} creators.`);
}

async function cmdBundles() {
  const cfg = await loadConfig();
  const { kept } = applyExclusions(await loadLibrary(), cfg.excludeCreators);
  const titles = deriveGroupTitles(kept, await readJson(RELEASES_PATH, {}));
  const folders = new Map();
  for (const e of kept) {
    const k = `${e.creator}\\${bundleFor(e, titles, cfg.bundleTitles)}`;
    folders.set(k, (folders.get(k) ?? 0) + 1);
  }
  const sorted = [...folders].sort(([a], [b]) => a.localeCompare(b));
  for (const [k, n] of sorted) console.log(`${String(n).padStart(4)}  ${k}`);
  console.log(`\n${sorted.length} folders.`);
}

async function cmdInspect(cfg, id) {
  const obj = await createApi(cfg).object(id);
  await writeJson(path.join(OBJECTS_DIR, `${id}.json`), obj);
  const files = obj.files?.items ?? [];
  console.log(`${obj.id}  ${obj.name}`);
  console.log(`  designer: ${obj.designer?.name ?? obj.designer?.username ?? '?'}`);
  console.log(`  files:    ${obj.files?.total_count ?? files.length}`);
  for (const f of files.slice(0, 20)) console.log(`    - ${f.filename}  (${(Number(f.size) / 1048576).toFixed(1)} MB)`);
  if (files.length > 20) console.log(`    ... ${files.length - 20} more`);
}

async function cmdPlan(cfg) {
  const started = Date.now();
  const { queue, unavailable, errors, fetched, cached, dupes, bytesSaved } = await buildPlan(cfg, createApi(cfg), { refresh: flag('refresh') });
  console.log(`\nPlanned in ${((Date.now() - started) / 60000).toFixed(1)} min (${fetched} fetched from MMF, ${cached} from cache).`);
  if (dupes) console.log(`Skipped ${dupes} duplicate files (models also sold inside a bundle), saving ${gb(bytesSaved)}.`);
  printSummary(queue);
  if (errors.length) console.log(`${errors.length} object(s) could not be loaded this time; run "node mmf.js plan" again to retry them.`);
  if (unavailable.length) console.log(`${unavailable.length} object(s) had nothing to download; see data\\unavailable.json`);
}

// Library list + release names pushed by the extension's "Sync" button.
async function receiveLibrary({ objectPreviews, releases }) {
  if (!Array.isArray(objectPreviews) || !objectPreviews.every((r) => r && (r.originalId ?? r.id) != null)) {
    throw new Error('Library sync sent an unexpected format');
  }
  if (!releases || typeof releases !== 'object' || Array.isArray(releases)) {
    throw new Error('Library sync sent unexpected release names');
  }
  await writeJson(PREVIEWS_PATH, objectPreviews);
  await writeJson(RELEASES_PATH, releases);
  const { entries } = await importLibrary(PREVIEWS_PATH);
  console.log(`Library synced from Chrome: ${entries.length} objects, ${Object.keys(releases).length} release names.`);
  return { objects: entries.length, releases: Object.keys(releases).length };
}

// "Sync library" in the dashboard runs plan in the bridge right after the sync.
function planFromDashboard(cfg) {
  return async ({ log }) => {
    const r = await buildPlan(cfg, createApi(cfg, { log }), { log });
    const s = summarize(r.queue);
    return { fetched: r.fetched, cached: r.cached, pending: s.pending, failed: s.failed, errors: r.errors.length, unavailable: r.unavailable.length };
  };
}

async function cmdServe(cfg) {
  const bridge = createBridge(cfg, { onLibrary: receiveLibrary, onPlan: planFromDashboard(cfg) });
  const port = await bridge.start();
  console.log(`Bridge listening on http://127.0.0.1:${port}`);
  printSummary(bridge.queue);
  console.log(`Archive: ${cfg.archiveRoot}`);
  console.log(`Cap: ${cfg.maxDownloadsPerHour} downloads/hour. Press Start in the Chrome extension. Ctrl+C to stop.\n`);
  const stop = async () => { await bridge.stop(); process.exit(0); };
  process.on('SIGINT', stop);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') return console.log(HELP);

  if (cmd === 'library') {
    if (!rest[0]) throw new Error('Usage: node mmf.js library <saved-file.json>');
    return cmdLibrary(rest[0]);
  }
  if (cmd === 'status') return printSummary(await loadQueue());
  if (cmd === 'bundles') return cmdBundles();
  if (cmd === 'install-host') return installHost({ extraIds: rest });

  const cfg = await loadConfig();
  if (cmd === 'login') {
    const t = await login(cfg);
    console.log(`Logged in. Token valid until ${new Date(t.expires_at * 1000).toLocaleString()}.`);
  } else if (cmd === 'whoami') {
    const me = await createApi(cfg).whoami();
    console.log(`Authenticated as: ${me.username ?? JSON.stringify(me)}`);
  } else if (cmd === 'inspect') {
    if (!rest[0]) throw new Error('Usage: node mmf.js inspect <objectId>');
    await cmdInspect(cfg, rest[0]);
  } else if (cmd === 'plan') {
    await cmdPlan(cfg);
  } else if (cmd === 'serve') {
    await cmdServe(cfg);
  } else {
    console.log(`Unknown command "${cmd}".`);
    console.log(HELP);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exitCode = 1;
});

