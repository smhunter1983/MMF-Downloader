# Changelog

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
