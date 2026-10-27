// MMF Downloader extension: asks the local bridge for one file at a time,
// downloads it with Chrome (your real, logged-in browser session), and reports
// back so the bridge can verify and file it.
//
// MV3 service workers sleep when idle, so all state lives in chrome.storage
// and work is driven by events: download changes, alarms, and popup clicks.

const BRIDGE = 'http://127.0.0.1:8766';
const WATCHDOG = 'mmf-watchdog';
const RESUME = 'mmf-resume';

const getState = async () => (await chrome.storage.local.get({
  running: false,
  inflight: null,       // { key, downloadId, label }
  message: 'Idle',
  bridgeOk: null,
}));
const setState = (patch) => chrome.storage.local.set(patch);

async function bridge(pathname, body) {
  const res = await fetch(`${BRIDGE}${pathname}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-MMF-Bridge': '1', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Bridge HTTP ${res.status}`);
  return data;
}

// Reads your library list and release names from MMF using your logged-in
// Chrome session (read-only), and hands them to the bridge.
const MMF = 'https://www.myminifactory.com';

async function mmfJson(pathname) {
  const res = await fetch(`${MMF}${pathname}`, { credentials: 'include', headers: { Accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok || text.trimStart().startsWith('<')) {
    throw new Error(`MMF returned a web page for ${pathname} (logged out or a Cloudflare check). Open myminifactory.com, log in, and try again.`);
  }
  return JSON.parse(text);
}

async function syncLibrary() {
  await setState({ message: 'Syncing library list from MMF...' });
  const objectPreviews = await mmfJson('/api/data-library/objectPreviews');
  const creators = await mmfJson('/api/data-library/userGroups_metadata');
  const releases = {};
  for (const [i, c] of creators.entries()) {
    await setState({ message: `Syncing release names (${i + 1}/${creators.length}): ${c.name}` });
    for (const r of await mmfJson(`/api/data-library/userGroup_releases_metadata/${encodeURIComponent(c.id)}`)) {
      releases[r.id] = { label: r.label, createdAt: r.createdAt, creator: c.name };
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  const r = await bridge('/library', { objectPreviews, releases });
  const msg = `Library synced: ${r.objects} objects, ${r.releases} release names. Now run "node mmf.js plan".`;
  await setState({ message: msg });
  return r;
}

let pumping = false;

// Starts the next download if we're running and nothing is in flight.
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    const s = await getState();
    if (!s.running || s.inflight) return;

    let r;
    try {
      r = await bridge('/next', {});
      await setState({ bridgeOk: true });
    } catch (err) {
      await setState({ bridgeOk: false, message: 'Bridge not reachable. Is "node mmf.js serve" running? Retrying every minute.' });
      return;
    }

    if (r.action === 'download') {
      try {
        const downloadId = await chrome.downloads.download({
          url: r.item.url,
          filename: r.item.filename,
          conflictAction: 'uniquify',
          saveAs: false,
        });
        await setState({ resumeAt: null, inflight: { key: r.item.key, downloadId, label: r.item.label }, message: `Downloading ${r.item.label}` });
      } catch (err) {
        await bridge('/report', { key: r.item.key, ok: false, error: `START_FAILED: ${err.message}` }).catch(() => {});
        await setState({ message: `Could not start download: ${err.message}` });
        chrome.alarms.create(RESUME, { when: Date.now() + 5000 });
      }
    } else if (r.action === 'wait') {
      const resumeAt = Date.now() + r.ms;
      chrome.alarms.create(RESUME, { when: resumeAt });
      await setState({ resumeAt, message: `${r.reason}. Next download at ${new Date(resumeAt).toLocaleTimeString()}.` });
    } else if (r.action === 'paused') {
      await setState({ running: false, message: `Paused: ${r.reason}` });
    } else if (r.action === 'done') {
      await setState({ running: false, message: 'All done! Nothing left in the queue.' });
    }
  } finally {
    pumping = false;
  }
}

async function finish(downloadId, ok, error) {
  const s = await getState();
  if (!s.inflight || s.inflight.downloadId !== downloadId) return;
  let path = null;
  if (ok) {
    const [item] = await chrome.downloads.search({ id: downloadId });
    path = item?.filename ?? null;
  }
  try {
    const r = await bridge('/report', { key: s.inflight.key, ok, path, error });
    await setState({ inflight: null, message: r.paused ? 'Paused by bridge (see popup)' : `Finished ${s.inflight.label}` });
  } catch (err) {
    // Keep inflight so the watchdog retries the report once the bridge is back.
    await setState({ bridgeOk: false, message: `Could not report to bridge: ${err.message}` });
    return;
  }
  // Keep Chrome's download list tidy; the file itself stays where the bridge put it.
  chrome.downloads.erase({ id: downloadId }).catch(() => {});
  pump();
}

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state?.current === 'complete') finish(delta.id, true);
  else if (delta.state?.current === 'interrupted') finish(delta.id, false, delta.error?.current ?? 'INTERRUPTED');
});

// Watchdog: catches downloads that ended while the worker slept, retries a
// failed report, and keeps the loop moving.
async function watchdog() {
  const s = await getState();
  if (s.inflight) {
    const [item] = await chrome.downloads.search({ id: s.inflight.downloadId });
    if (!item) await finish(s.inflight.downloadId, false, 'DOWNLOAD_MISSING');
    else if (item.state === 'complete') await finish(item.id, true);
    else if (item.state === 'interrupted') await finish(item.id, false, item.error ?? 'INTERRUPTED');
    return;
  }
  pump();
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === WATCHDOG) watchdog();
  if (a.name === RESUME) pump();
});

const ensureWatchdog = () => chrome.alarms.create(WATCHDOG, { periodInMinutes: 1 });

// Toolbar click opens the dashboard as its own floating window (or focuses it).
chrome.action.onClicked.addListener(async () => {
  const { dashboardWindowId } = await chrome.storage.session.get('dashboardWindowId');
  if (dashboardWindowId) {
    try {
      await chrome.windows.update(dashboardWindowId, { focused: true, drawAttention: true });
      return;
    } catch { /* window was closed */ }
  }
  const win = await chrome.windows.create({ url: 'dashboard.html', type: 'popup', width: 820, height: 900, focused: true });
  await chrome.storage.session.set({ dashboardWindowId: win.id });
});
chrome.runtime.onInstalled.addListener(ensureWatchdog);
chrome.runtime.onStartup.addListener(ensureWatchdog);

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    if (msg.cmd === 'start') {
      await bridge('/resume', {}).catch(() => {});
      await setState({ running: true, message: 'Starting...' });
      ensureWatchdog();
      await pump();
    } else if (msg.cmd === 'pause') {
      await setState({ running: false, message: 'Paused. The current file (if any) will finish.' });
    } else if (msg.cmd === 'retryFailed') {
      await bridge('/retry-failed', {});
    } else if (msg.cmd === 'syncLibrary') {
      try {
        await syncLibrary();
      } catch (err) {
        await setState({ message: `Sync failed: ${err.message}` });
      }
    }
    reply({ ok: true });
  })().catch((err) => reply({ ok: false, error: err.message }));
  return true;
});

