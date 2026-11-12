# Changelog

## 2.3.1 (2026-11-11)

- README brought up to date for 2.3: settings, troubleshooting, and a new
  "Upgrading from 2.0" section.
- Two in-app tips now point at the Paste path rows in ⚙.

## 2.3.0 (2026-11-11)

Everything since 2.0.0 (the in-between 2.0.1 and 2.1.0 were never released).

- Optional PDF folder (⚙ > "Path for PDFs discovered" > Paste path). Once picked, every PDF
  you download from then on is also copied to
  `<PDF folder>\<Creator>\<the creator's file name>`. The archive keeps
  its own copy beside the zips.
- Nothing in the PDF folder is ever overwritten: the same file already
  there (or in that creator's `_Other` folder) is skipped, and a different
  file with the same name is left alone and noted in History.
- If Chrome needs your OK for the PDF folder again, downloads carry on and
  the waiting PDFs are copied at the next Start.
- PDFs downloaded before the folder was picked are not copied.
- Folder paths in ⚙ are set with Paste path: copy the path in your file
  browser, click the button. Chrome doesn't tell extensions where folders are, so
  a note then asks you to select the folder once in Chrome's own window
  (it opens only when you click, and starts at the Desktop). A ✓ shows when the
  path and the confirmed folder agree; a note explains when they don't
  (wrong level, or a creator's own folder picked by mistake).
- Works the same on Windows, Mac and Linux: the wording says "your file
  browser", and copied locations use that computer's kind of slashes.
- New **Skip busts** and **Skip statues** settings (⚙), both off by
  default. When on, files with "bust" / "statue" in the name are never
  downloaded and don't count against a model. The setting turns orange,
  and so does the count (e.g. 11/12) of any model that is complete except
  for them, with a tooltip saying why.
- **Don't want**: point at a model, release or creator and click it to hide
  it. Hidden models leave the list, its counts and New, and are never
  downloaded; a Sync keeps them hidden. **Hidden (n)** shows them, and
  **Restore** brings one back, badged NEW.
- "Skip these creators" is now "Skip creators", and its checkboxes line up.
- New **Clear failed** button beside Retry failed: unchecks the failed files
  so nothing keeps retrying them (tick the model again to get them later).
  "Expand" is now "Expand all" / "Collapse all", and the list buttons are
  all one size.
- With the PDF path set, a 📄 row in History copies the file's full
  location when clicked, like ✓ rows do.
- PDFs download from their own link. MMF gives PDFs a separate link from
  zips; asked for the zip way, it answers with the model's page, which
  2.0.0 took for a Cloudflare check and paused on, every time. Press Sync
  library once after updating: models with a PDF are read again.
- A pause for a web page now says which file, the HTTP status and the
  page's title, and tells a Cloudflare check from a log-in page.
- If MMF answers one file's link with the model's own page, only that file
  fails (asked once); the rest of the run carries on.

## 2.0.0 (2026-10-29)

Everything now runs inside Chrome: no Node, no bridge window, no command
line, no MyMiniFactory developer app or login step.

- Pick your archive folder once (📁); the extension writes there directly.
  Chrome's "Allow on every visit" keeps the permission across restarts.
- Downloads run in a hidden background page: the dashboard can be closed,
  and a run interrupted by a Chrome restart resumes by itself.
- File lists come from each model's MMF page (no official API needed).
- Files are written in 16 MB batches while the next batch downloads.
- A model with a single loose part is saved as that file (e.g. `.stl`)
  instead of failing as "not a zip".
- Settings (⚙) save as you change them: downloads per hour (warns above
  150), retry wait after a refusal (at least 5 minutes), an optional full
  folder path for copied locations, and a checklist of creators to skip.
- NEW badges clear once a model is downloaded.
- ✓ copies the file location (an extension can't open Explorer), and the
  📌 pin is gone (same reason).
- Removed: the Node bridge, `mmf.js`, `install-host` and the Start bridge
  button. 1.x remains available as the v1.0.4 release.

## 1.0.4 (2026-10-29)

- If MMF refuses a download (SERVER_FORBIDDEN), wait 10 minutes and retry by
  itself once before pausing (`forbiddenRetryMinutes`). Seen twice in a
  long run; a plain Start fixed it both times. Logged-out still pauses at once.
- "Show in Explorer" (✓) brings the Explorer window to the front.
- Start bridge shows Chrome's exact error; the button keeps a fixed size.

Known issue: on current Chrome (seen on 156) the Start bridge button can fail
with "Specified native messaging host not found" even when everything is
registered correctly. Start the bridge with `node mmf.js serve` instead.

## 1.0.3 (2026-10-28)

- Library tree: **NEW** badges on models that the latest Sync brought in
  ("3 new" on creators and releases), plus a **New (n)** button to show only them.
- Last column: ✓ = already in your archive (checked or not); n/m = partly.

## 1.0.2 (2026-10-28)

- History: filter by creator (dropdown, or click a creator's name); totals
  follow the chosen creator; covers the whole log, not just the last 500.

## 1.0.1 (2026-10-28)

- **Sync library** now also builds the download list (no more "run node mmf.js
  plan"); new models come in checked, ready for Start.
- History button moved up to the header.

## 1.0.0 (2026-10-28)

First full release, used to archive a 2,546-file, 1.9 TB library.

- Library sync through your logged-in Chrome; file lists from MMF's official API.
- Creator ▸ Release ▸ Model dashboard with Get/Skip, per-batch progress, ETA.
- Downloads through real Chrome, verified (size, zip structure, STL structure)
  and filed as `Creator\Release\file`; web pages pause the run instead.
- Hourly cap with automatic pause and resume; survives restarts (Start bridge).
- Duplicate files sold in bundles and solo are downloaded once.
- Whole-model zips for models with only loose parts; single-file models named
  after their page title.
- History panel: what was downloaded, retried or failed, and when.
- `tools\Combine-RescalePairs.ps1`: fold Supported/Unsupported zip pairs into
  one zip per creature; the downloader recognises the combined zips.
- Never overwrites a different file already in the archive.

Known issues: a few very old models' auto-made "whole model" zips are not
served as zips by MMF (seen on 2 of 2,546); download those by hand.
