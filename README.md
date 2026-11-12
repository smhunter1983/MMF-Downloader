# MMF Downloader

A Chrome extension that archives your **MyMiniFactory library** into a folder
you choose, organised as `Creator\Release\file`, and keeps it up to date as new
releases come out.

Everything runs inside Chrome, using your normal logged-in MMF session. There is
nothing else to install: no Node, no command line, no MMF developer account.

## Install

1. Download this repository: green **Code** button → **Download ZIP**, and
   unzip it somewhere permanent (or `git clone`). Chrome loads the extension
   from that folder, so don't delete or move it afterwards.
2. In Chrome, open `chrome://extensions`, turn on **Developer mode** (top
   right), click **Load unpacked** and pick the `extension` folder.
3. Pin **MMF Downloader** to the toolbar and click it. The dashboard opens in
   its own window.
4. Log in to [myminifactory.com](https://www.myminifactory.com) in Chrome if
   you aren't already.

## First run

1. **📁 Pick folder**: choose where your archive lives (or should live). Chrome
   asks to let the extension edit that folder: allow it. After a Chrome
   restart it asks once more; choose **"Allow on every visit"** and it stops
   asking. Optionally, in **⚙**, paste that folder's full path too (see
   Settings): Chrome never tells an extension where a folder is, and with the
   path, clicking ✓ in the list copies a location you can paste straight into
   your file browser.
2. **Sync library**: reads your MMF library (purchases, Tribe months, creator
   releases, free downloads) and builds the download list. The first Sync
   visits every model's page (about 1.5 s each, so a large library takes a
   while); later Syncs only visit new models. Files already in your folder
   are recognised and marked done.
3. Review the **Creator ▸ Release ▸ Model** list: everything is checked
   (Get); untick what you don't want (Skip). The filter box plus **Check
   all / Uncheck all** work on what's shown; **Expand all** opens every
   creator. Don't keep busts or statues? Turn on **Skip busts** / **Skip
   statues** in ⚙ before you Start.
4. **Start**. You can close the dashboard; downloads carry on in the
   background as long as Chrome is open.

## Day to day

- **Sync library** whenever creators release something. Models it hasn't
  seen before get a **NEW** badge (until downloaded), and **New (n)** shows
  only those.
- **Don't want** (shows when you point at a row) hides a model, a release or
  a whole creator: out of the list, the counts and New, and never downloaded.
  **Hidden (n)** lists them; **Restore** puts one back, badged NEW.
- In the list, **✓** = already in your archive; **n/m** = partly downloaded;
  an **orange n/m** = complete except busts or statues you chose to skip
  (hover it for details). Clicking any of them copies the file or folder
  location (Chrome extensions can't open folders themselves; with your
  folder's path set in ⚙, the copied location can be pasted straight into
  your file browser).
- **Retry failed** queues failed files again; **Clear failed** stops trying
  them (they are unticked; tick the model again to get them later).
- **History** shows what was downloaded, retried or failed, and when; filter
  it by creator, type or text.
- If Chrome closes mid-run (restart, Windows Update), the run resumes by
  itself next time Chrome starts.

## Settings (⚙)

| Setting | Default | Meaning |
|---|---|---|
| Downloads per hour | 120 | Pace of downloads. Above ~150/hour MMF has been reported to refuse downloads or flag accounts, so the dashboard warns you. |
| If MMF refuses a download, retry after | 10 min (at least 5) | MMF occasionally refuses one download in a long run. The run waits this long and retries once by itself; if it's refused again, it pauses. |
| Path of archive folder | (empty) | Optional. Copy your archive folder's path in your file browser and click **Paste path**. Used only for copied locations. A ✓ beside it means it matches the folder you picked with 📁; ⚠ means it doesn't (a note below says why). |
| Path for PDFs discovered | (off) | Optional. Copy a folder's path in your file browser and click **Paste path**, then click **Select and Confirm PDF Location** and pick that same folder in Chrome's window (once: Chrome only lets an extension save into a folder picked there). From then on every PDF you download is also copied to `<that folder>\<Creator>\` under the creator's file name; the archive keeps its copy. Nothing there is overwritten, and a file you moved to `<Creator>\_Other` counts as already there. 📄 rows in History copy the PDF's location. **Clear** stops the copying. |
| Skip busts | off | Files or models with "bust" in the name (like `BUSTS.zip` or `Overlord Bust.zip`) are never downloaded, and a model counts as complete without them: its count shows in orange (for example 11/12). Busts already downloaded are left alone. Turn it off and busts are ordinary files again. |
| Skip statues | off | The same as Skip busts, for files or models with "statue" in the name (like `Dragon Statue.zip`). Each has its own switch. |
| Skip creators | none | A checklist of every creator in your library; ticked ones are left out (e.g. creators who moved off MMF). |

Settings save as you change them.

## Folder layout

`Creator\Release\file`, where Release is:
- the Tribe month (`2026-10`), or
- the creator's release name as MMF shows it
  (`2024 - 10 _ October release - Hollow Graves`), or
- `Loyalty Rewards`, `Welcome Pack`, `Tribe Store`, `Purchases`,
  `Free Downloads`, `Frontier <campaign>`.

What you get is exactly what the model page's Download dialog offers: the
creator's zips as-is (Supported and Unsupported). Models with only loose parts
come as one whole-model zip (a model with a single loose part comes as that
file). Single-file models are named after their page title, so
`Kevin Brightwood.zip` arrives as `Kevin Brightwood - Half-orc Barbarian.zip`.
Files sold both inside a bundle and on their own are downloaded once and filed
with the bundle.

## Safety

- Read-only on MMF: it reads your library and model pages and downloads your
  files, like clicking Download yourself, at a gentle pace.
- Every file is checked before it's filed: exact size, zip structure
  (end-of-archive record), STL structure (triangle count / `endsolid`). A web
  page instead of a file is never saved: a log-in page or Cloudflare check
  pauses the run; the model's own page (MMF didn't accept that one link) fails
  just that file and the run carries on.
- Downloads are written as `<name>.partial` next to their final place and
  renamed only once checked. It never overwrites a different file already in
  your archive.
- Loose parts replaced by a whole-model zip are moved to `_to_delete`, never
  deleted.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Chrome needs your OK to use the archive folder again" | Click **Allow folder**, choose **Allow on every visit** |
| "Paused: MMF sent a web page instead of …" | The message says which page. A Cloudflare check: open myminifactory.com in Chrome and let it finish. A log-in page: log in. Then **Start** |
| A file failed with "MMF did not accept this file's download link" | **Sync library**, then **Retry failed** |
| "MMF refused a download… retrying by itself" | Nothing to do: it retries after the wait. If it's refused again it pauses; check you're logged in, then **Start** |
| Some files failed | **Retry failed**; or **Clear failed** to stop trying them |
| A count is orange | Not a problem: the model is complete except busts or statues you chose to skip |
| Something you don't want keeps showing up | Point at it and click **Don't want**; **Hidden (n)** → **Restore** brings it back |
| Nothing happens after a Chrome update | `chrome://extensions` → reload MMF Downloader |

## Upgrading from 2.0

Download the new version, replace the files in your extension folder, then in
`chrome://extensions` click the reload arrow on MMF Downloader. Press **Sync
library** once: models with a PDF are read again so their PDFs download
properly. Your settings, list and history are kept.

## Upgrading from 1.x

1.x used a Node "bridge" and a command line; 2.0 does everything in Chrome.
Load the new `extension` folder, pick your existing archive folder and Sync:
files already there are recognised and not downloaded again. Untick anything
you had skipped in 1.x. The last 1.x release is
[v1.0.4](https://github.com/smhunter1983/MMF-Downloader/releases/tag/v1.0.4).

## Tests

`npm test` (Node 20+) runs the tests for the extension's logic and engine.

## Status

Personal hobby project, not affiliated with MyMiniFactory. Use it only for
models you own, and respect creators' licences. It relies on MyMiniFactory's
website (library list and model pages), which may change without notice.

## License

MIT (see [LICENSE](LICENSE)). Provided as is, with no warranty.
