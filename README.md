# MMF Downloader

Archives a MyMiniFactory library to local disk.

MMF's download links sit behind a Cloudflare browser check, so downloads go
through **your real Chrome** (via a small extension). Everything else
(library list, file lists, queue, verification, filing) is Node.

```
 MMF API ──> node mmf.js plan ──> data\queue.json
                                       │
 Chrome extension <── node mmf.js serve (localhost bridge)
   downloads file ──> Downloads\MMF-staging ──> verified ──> archive\Creator\Bundle\
```

Node 20+, no npm dependencies.

## One-time setup

1. **Register an MMF app** (free): log in to MyMiniFactory, go to
   Settings → Developers (`https://www.myminifactory.com/settings/developer`) →
   *Register a new OAuth Application*.
   - Client key: any unique slug, e.g. `yourname-library-archiver`
   - Redirect URI: `http://localhost:8765/callback`
   - The client secret arrives by email.
2. Copy `config.example.json` to `config.local.json` and fill in `clientId`,
   `clientSecret` and `archiveRoot` (where the archive should live).
   `config.local.json` and `data\` are git-ignored; they never get committed.
3. `node mmf.js login` → approve in the browser. MMF's OAuth page has no Google
   button, so a Google-only account needs a password first ("Forgot password?").
4. Chrome → `chrome://extensions` → turn on **Developer mode** → **Load unpacked**
   → pick the `extension` folder. Pin "MMF Downloader" to the toolbar; clicking it
   opens the floating dashboard (📌 keeps it on top, Windows).

## Each run

1. `node mmf.js serve` and leave it running.
2. Chrome toolbar → MMF Downloader → dashboard → **Sync library** (pulls your
   library list and release names through your logged-in Chrome; read-only).
3. `node mmf.js bundles` to preview the Creator\Bundle folders (optional).
4. `node mmf.js plan` builds the queue (first run takes about 1.5 hours; it's
   paced and cached, so later runs take seconds and only add what's new).
   The running bridge picks up the new queue automatically.
5. In the dashboard, review Creator ▸ Release ▸ Model with sizes, untick anything
   you don't want (Get/Skip; filter box + Check all / Uncheck all), then **Start**.
   At the hourly cap it waits and resumes on its own (countdown shown).
   Click **Done** on any row to show it in Explorer.
   Choices are remembered across re-plans and can be changed mid-run.

`node mmf.js status` shows progress any time. Stop/start freely; it resumes.

## Settings (config.local.json)

| Key | Default | Meaning |
|---|---|---|
| `archiveRoot` | | Where finished files are filed |
| `excludeCreators` | `[]` | Creator names to skip (e.g. ones that moved off MMF) |
| `bundleTitles` | `{}` | `{ "60627": "Hollow Graves" }` to name a release group by hand |
| `maxDownloadsPerHour` | `120` | Hourly cap (community reports ~150/h from MMF) |
| `apiDelayMs` | `3000` | Gap between API calls during `plan` |

## Folder naming

`Creator\Bundle\file.zip`, where Bundle is the earliest Tribe month (`2026-10`),
else the creator's release name as MMF shows it (synced by the extension, e.g.
`2024 - 10 _ October release - Hollow Graves`), else `Loyalty Rewards`,
`Welcome Pack`, `Purchases`, `Free Downloads`, `Frontier <campaign>`.

## Safety behaviour

- The bridge only listens on 127.0.0.1 and only answers the extension.
- It only moves files from the staging folder whose name matches the expected item.
- Every file is checked (exact size from MMF, zip header and end-of-archive record).
  Web pages (Cloudflare check, logged out) **pause the run** instead of failing everything.
- Bad files are retried up to 3 times, then marked failed (dashboard → "Retry failed").
- Models with only loose parts download as one whole-model zip (like the site's
  Download button); loose files it replaces are moved to `_to_delete`, never deleted.
- Re-running `plan` marks files already in the archive as done (gap check), and
  moves already-filed files if their folder name changed instead of re-downloading.
- Models sold both inside a bundle and on their own (same creator, file name and
  exact size) are downloaded once and filed with the bundle.

## Tests

`npm test`

## Status

Personal project, private for now. Uses MMF's official API plus a few of the
website's own library endpoints (read through your logged-in browser), which
may change without notice.
