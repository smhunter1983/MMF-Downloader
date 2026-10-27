// Thin client for the official MMF API v2 (https://www.myminifactory.com/api/v2).

import { makePacer, fetchWithRetry, explainFailure, looksLikeHtml, CloudflareBlockError } from './http.js';
import { getAccessToken as defaultGetToken } from './auth.js';

export const API_BASE = 'https://www.myminifactory.com/api/v2';

export function createApi(cfg, { log = console.log, getAccessToken = defaultGetToken } = {}) {
  const pace = makePacer(cfg.apiDelayMs);
  let calls = 0;

  async function request(pathname, token) {
    return fetchWithRetry(`${API_BASE}${pathname}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    }, {
      onRetry: ({ status, waitMs }) => log(`  API ${status}, retrying in ${Math.round(waitMs / 1000)}s`),
    });
  }

  async function get(pathname) {
    await pace();
    calls++;
    let res = await request(pathname, await getAccessToken(cfg));
    if (res.status === 401) {
      // MMF can revoke a token before its stated expiry: refresh once, retry.
      await res.body?.cancel();
      log('  API 401, refreshing login and retrying');
      res = await request(pathname, await getAccessToken(cfg, { force: true }));
    }
    if (!res.ok) throw await explainFailure(res);
    const text = await res.text();
    if (looksLikeHtml(text)) throw new CloudflareBlockError(`API returned an HTML page for ${pathname}`);
    return JSON.parse(text);
  }

  return {
    get,
    get callCount() { return calls; },
    whoami: () => get('/user'),
    object: (id) => get(`/objects/${encodeURIComponent(id)}`),
    objectFiles: (id) => get(`/objects/${encodeURIComponent(id)}/files`),
  };
}
