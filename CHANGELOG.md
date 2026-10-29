# Changelog

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
