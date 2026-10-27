// OAuth2 Authorization Code flow against MyMiniFactory.
//
// login(): opens the browser to MMF's consent page, catches the redirect on a
// local server (http://localhost:<port>/callback), exchanges the code for
// tokens and stores them in data/tokens.local.json.
// getAccessToken(): returns a cached token, refreshing it when expired.
//
// Endpoint details confirmed from minihoard (a working Rust client): the token
// endpoint takes client_id/secret as HTTP Basic auth, with a form-encoded body.

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { TOKENS_PATH, readJson, writeJson } from './config.js';

export const AUTHORIZE_URL = 'https://auth.myminifactory.com/web/authorize';
export const TOKEN_URL = 'https://auth.myminifactory.com/v1/oauth/tokens';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const EXPIRY_MARGIN_S = 60;

const nowS = () => Math.floor(Date.now() / 1000);

function openInBrowser(url) {
  // rundll32 avoids cmd.exe's mangling of '&' in URLs.
  if (process.platform === 'win32') {
    execFile('rundll32', ['url.dll,FileProtocolHandler', url]);
  } else {
    execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
  }
}

function waitForCode(port, expectedState) {
  return new Promise((resolve, reject) => {
    const finish = (res, message, err, code) => {
      res.writeHead(err ? 400 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><body style="font-family:system-ui;padding:3rem"><h2>${message}</h2>`);
      clearTimeout(timer);
      server.close();
      err ? reject(err) : resolve(code);
    };

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const p = url.searchParams;
      if (p.get('error')) return finish(res, 'Authorization was denied. You can close this tab.', new Error(`MMF denied authorization: ${p.get('error')}`));
      if (p.get('state') !== expectedState) return finish(res, 'State mismatch. You can close this tab.', new Error('OAuth state mismatch; login aborted.'));
      if (!p.get('code')) return finish(res, 'No authorization code received.', new Error('Redirect had no code.'));
      finish(res, 'MMF Downloader is authorized. You can close this tab.', null, p.get('code'));
    });

    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Timed out waiting for the browser login (5 minutes).'));
    }, LOGIN_TIMEOUT_MS);

    server.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Could not listen on port ${port}: ${e.message}`));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function postToken(cfg, form) {
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(form),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Token endpoint returned ${res.status}: ${body.slice(0, 300)}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Token endpoint returned non-JSON: ${body.slice(0, 300)}`);
  }
}

async function saveTokens(t, previous = {}) {
  const tokens = {
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? previous.refresh_token ?? null,
    expires_at: nowS() + Number(t.expires_in ?? 3600) - EXPIRY_MARGIN_S,
    obtained_at: new Date().toISOString(),
  };
  await writeJson(TOKENS_PATH, tokens);
  return tokens;
}

export async function login(cfg) {
  const redirectUri = `http://localhost:${cfg.redirectPort}/callback`;
  const state = randomUUID();
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
  }).toString();

  const codePromise = waitForCode(cfg.redirectPort, state);
  console.log('Opening your browser to authorize MMF Downloader...');
  console.log(`If it does not open, paste this URL into your browser:\n  ${url}\n`);
  openInBrowser(url.toString());

  const code = await codePromise;
  const t = await postToken(cfg, { grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  if (!t.access_token) throw new Error('Token response had no access_token.');
  const saved = await saveTokens(t);
  if (!saved.refresh_token) {
    console.warn('Warning: no refresh_token returned; you will need to log in again when the token expires.');
  }
  return saved;
}

export async function getAccessToken(cfg) {
  const tokens = await readJson(TOKENS_PATH);
  if (!tokens?.access_token) throw new Error('Not logged in. Run: node mmf.js login');
  if (tokens.expires_at > nowS()) return tokens.access_token;
  if (!tokens.refresh_token) throw new Error('Access token expired and no refresh token stored. Run: node mmf.js login');
  const t = await postToken(cfg, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
  return (await saveTokens(t, tokens)).access_token;
}
