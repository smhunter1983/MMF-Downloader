// Thin client for the official MMF API v2 (https://www.myminifactory.com/api/v2).

import { makePacer, fetchWithRetry, explainFailure, looksLikeHtml, CloudflareBlockError } from './http.js';
import { getAccessToken } from './auth.js';

export const API_BASE = 'https://www.myminifactory.com/api/v2';

export function createApi(cfg, { log = console.log } = {}) {
  const pace = makePacer(cfg.apiDelayMs);
  let calls = 0;

  async function get(pathname) {
    await pace();
    calls++;
    const token = await getAccessToken(cfg);
    const res = await fetchWithRetry(`${API_BASE}${pathname}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    }, {
      onRetry: ({ status, waitMs }) => log(`  API ${status}, retrying in ${Math.round(waitMs / 1000)}s`),
    });
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
