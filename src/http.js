// Shared HTTP helpers: pacing, retry/backoff, and Cloudflare/HTML detection.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Only MMF's own hosts ever receive our bearer token.
export function isMmfHost(url) {
  const host = new URL(url).hostname.toLowerCase();
  return host === 'myminifactory.com' || host.endsWith('.myminifactory.com');
}

export class CloudflareBlockError extends Error {}
export class AuthError extends Error {}

// Spaces calls out so we never exceed a requests-per-interval budget.
export function makePacer(minGapMs) {
  let last = 0;
  return async () => {
    const wait = last + minGapMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
  };
}

export function looksLikeHtml(text) {
  const head = text.trimStart().slice(0, 200).toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html') || head.includes('cloudflare');
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const BACKOFF_MS = [2000, 8000, 32000, 120000];
const MAX_RETRY_AFTER_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60 * 1000;

// fetch() with a timeout, retrying network failures and 429/5xx with backoff
// (honouring Retry-After, capped).
export async function fetchWithRetry(url, init = {}, { onRetry, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (attempt >= BACKOFF_MS.length) throw new Error(`Network error after ${attempt + 1} tries: ${err.message}`);
      onRetry?.({ status: err.name === 'TimeoutError' ? 'timeout' : 'network error', waitMs: BACKOFF_MS[attempt], attempt: attempt + 1 });
      await sleep(BACKOFF_MS[attempt]);
      continue;
    }
    if (!RETRYABLE.has(res.status) || attempt >= BACKOFF_MS.length) return res;

    const retryAfter = Number(res.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS)
      : BACKOFF_MS[attempt];
    onRetry?.({ status: res.status, waitMs, attempt: attempt + 1 });
    await res.body?.cancel();
    await sleep(waitMs);
  }
}

// Classifies a failed response so callers can pause instead of failing en masse.
export async function explainFailure(res) {
  const text = await res.text().catch(() => '');
  let err;
  if (res.status === 401) err = new AuthError(`401 Unauthorized: ${text.slice(0, 200)}`);
  else if (res.status === 403 && looksLikeHtml(text)) {
    err = new CloudflareBlockError('403 with an HTML page (likely a Cloudflare challenge)');
  } else if (res.status === 403) err = new AuthError(`403 Forbidden: ${text.slice(0, 200)}`);
  else err = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  err.status = res.status;
  return err;
}
