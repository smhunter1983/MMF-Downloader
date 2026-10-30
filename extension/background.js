// MMF Downloader 2.0 background script: opens the dashboard and keeps the
// hidden engine page (engine.html) running. All the work happens there.

const ENGINE_URL = 'engine.html';

async function ensureEngine() {
  if (await chrome.offscreen.hasDocument()) return;
  try {
    await chrome.offscreen.createDocument({
      url: ENGINE_URL,
      reasons: ['BLOBS'],
      justification: 'Downloads your MyMiniFactory library into the folder you picked',
    });
  } catch (e) {
    if (!/single offscreen document/i.test(e.message)) throw e; // created meanwhile
  }
}

// A run that was going when Chrome closed carries on (the engine decides).
chrome.runtime.onStartup.addListener(() => { ensureEngine(); });
chrome.runtime.onInstalled.addListener(() => { ensureEngine(); });

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.to !== 'background') return false;
  if (msg.cmd === 'ensureEngine') {
    ensureEngine().then(() => reply({ ok: true }), (e) => reply({ ok: false, error: e.message }));
    return true;
  }
  return false;
});

// Toolbar button: open the dashboard as its own window, at its last size.
const DEFAULT_SIZE = { width: 1060, height: 900 };
const clamp = (n, lo, hi, d) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d);

chrome.action.onClicked.addListener(async () => {
  const { dashboardWindowId } = await chrome.storage.session.get('dashboardWindowId');
  if (dashboardWindowId) {
    try {
      await chrome.windows.update(dashboardWindowId, { focused: true, drawAttention: true });
      return;
    } catch { /* window was closed */ }
  }
  const { dashboardSize: s } = await chrome.storage.local.get('dashboardSize');
  const win = await chrome.windows.create({
    url: 'dashboard.html', type: 'popup', focused: true,
    width: clamp(s?.width, 480, 4000, DEFAULT_SIZE.width), height: clamp(s?.height, 400, 3000, DEFAULT_SIZE.height),
  });
  await chrome.storage.session.set({ dashboardWindowId: win.id });
});

chrome.windows.onBoundsChanged?.addListener(async (win) => {
  const { dashboardWindowId } = await chrome.storage.session.get('dashboardWindowId');
  if (win.id !== dashboardWindowId || win.state !== 'normal') return;
  await chrome.storage.local.set({ dashboardSize: { width: win.width, height: win.height } });
});
