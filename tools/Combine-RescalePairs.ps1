<#
.SYNOPSIS
  Fold Rescale Miniatures' per-creature "X_Supports.zip" + "X_Unsupported.zip"
  into one "X.zip" that holds both, as-is.

.DESCRIPTION
  DRY RUN BY DEFAULT. Nothing is written until -Execute. Originals are never
  deleted unless -DeleteOriginals; without it they are MOVED into a
  "_combined_originals" folder beside the new zip for you to delete later.

  Pairing: the zip name with a trailing _Supports / _Supported / _Unsupported
  removed is the creature. Any folder group of 2+ zips sharing that stem is
  combined. A bare "X.zip" beside the pair is handled when it is provably a
  duplicate (byte-identical to X_Unsupported.zip: removed) or provably the
  unlabelled unsupported half (only X_Supports.zip beside it: renamed);
  anything else is skipped and listed for you to decide.

  The MMF Downloader recognises files inside these combined zips (same naming
  rule), so a later "node mmf.js plan" does not download them again.

  Safety while downloads may still be running:
    - a release folder is held (not touched at all) if any zip in it changed
      in the last -StableMinutes (default 60);
    - each source zip's size is read twice, 5 s apart, and must not change;
    - the outer zip is written as .partial and renamed only after 7z verifies
      it (7z t) and every inner zip's size matches its original.
  Outer zip is STORE mode (-mx0): the inner zips are already compressed, so
  this is a copy, not a recompress: I/O bound.

.EXAMPLE
  .\Combine-RescalePairs.ps1                                 # plan only
  .\Combine-RescalePairs.ps1 -Execute                        # do it, park originals
  .\Combine-RescalePairs.ps1 -Execute -DeleteOriginals
  .\Combine-RescalePairs.ps1 -Execute -Only "2024 - 07*"     # one release folder
#>
[CmdletBinding()]
param(
  # Default: <archiveRoot from config.local.json>\Rescale Miniatures
  [string]$Root,
  [string]$SevenZip = "C:\Program Files\7-Zip\7z.exe",
  [switch]$Execute,
  [switch]$DeleteOriginals,
  [int]$StableMinutes = 60,
  [string]$Only = "*"
)

$ErrorActionPreference = "Stop"
if (-not $Root) {
  $cfgPath = Join-Path (Split-Path $PSScriptRoot -Parent) "config.local.json"
  if (-not (Test-Path $cfgPath)) { throw "Pass -Root, or create config.local.json (archiveRoot) first." }
  $Root = Join-Path (Get-Content -Raw $cfgPath | ConvertFrom-Json).archiveRoot "Rescale Miniatures"
}
if (-not (Test-Path $SevenZip)) { throw "7-Zip not found at $SevenZip (install it, or pass -SevenZip)" }
if (-not (Test-Path $Root)) { throw "Root not found: $Root" }

$suffix = '(?i)[ _-]*(supports|supported|unsupported)$'
$log = Join-Path $Root ("_combine-log_{0:yyyyMMdd-HHmm}.txt" -f (Get-Date))
function Say($m) { $line = "{0:HH:mm:ss} {1}" -f (Get-Date), $m; Write-Host $line; if ($Execute) { Add-Content -LiteralPath $log -Value $line } }

Write-Host "Root: $Root"
$folders = Get-ChildItem -LiteralPath $Root -Directory | Where-Object { $_.Name -like $Only -and $_.Name -notlike "_*" }
$plan = @(); $skipped = @(); $unstable = @(); $unpaired = @(); $fixes = @()
foreach ($f in $folders) {
  $zips = @(Get-ChildItem -LiteralPath $f.FullName -File | Where-Object { $_.Extension -ieq ".zip" })
  if (-not $zips) { continue }
  $newest = ($zips | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime
  $folderStable = $newest -lt (Get-Date).AddMinutes(-$StableMinutes)
  foreach ($g in ($zips | Group-Object { $_.BaseName -replace $suffix, '' })) {
    if ($g.Count -lt 2) {
      if ($g.Group[0].BaseName -match $suffix) { $unpaired += [pscustomobject]@{ Folder = $f.Name; Name = $g.Group[0].Name } }
      continue
    }
    if (-not $folderStable) { $unstable += [pscustomobject]@{ Folder = $f.Name; Creature = $g.Name; Newest = $newest }; continue }
    $out = Join-Path $f.FullName ($g.Name + ".zip")
    $sources = @($g.Group)
    $bare = $g.Group | Where-Object { $_.FullName -ieq $out }
    $fix = $null
    if ($bare) {
      # A bare "X.zip" beside the pair. Measured 28 Oct 2026: three were
      # byte-identical duplicate downloads of X_Unsupported.zip; one
      # (Doomstride_Drag.zip) WAS the unsupported half, just unlabelled.
      $others = @($g.Group | Where-Object { $_.FullName -ine $out })
      $unsup = $others | Where-Object { $_.Name -match '(?i)_unsupported\.zip$' } | Select-Object -First 1
      if ($unsup -and $unsup.Length -eq $bare.Length -and (Get-FileHash -LiteralPath $bare.FullName -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $unsup.FullName -Algorithm SHA256).Hash) {
        $fix = [pscustomobject]@{ Kind = 'dup'; File = $bare; Text = "remove duplicate $($bare.Name) (byte-identical to $($unsup.Name))" }
        $sources = $others
      } elseif (-not $unsup -and $others.Count -eq 1 -and $others[0].Name -match '(?i)_(supports|supported)\.zip$') {
        $renamed = Join-Path $f.FullName ($g.Name + "_Unsupported.zip")
        $fix = [pscustomobject]@{ Kind = 'rename'; File = $bare; To = $renamed; Text = "rename $($bare.Name) -> $($g.Name)_Unsupported.zip (the unlabelled unsupported half)" }
        $sources = @($others[0], [pscustomobject]@{ Name = ($g.Name + "_Unsupported.zip"); FullName = $renamed; DirectoryName = $f.FullName; Length = $bare.Length })
      } else {
        $skipped += [pscustomobject]@{ Folder = $f.Name; Creature = $g.Name; Why = "bare $($g.Name).zip exists ($([math]::Round($bare.Length/1MB)) MB), not a duplicate of: " + ($others.Name -join ', ') }; continue
      }
      if ($sources.Count -lt 2 -and $fix.Kind -ne 'rename') { continue }
    }
    if ($fix) { $fixes += [pscustomobject]@{ Folder = $f.Name; Fix = $fix } }
    $plan += [pscustomobject]@{ Folder = $f.Name; Creature = $g.Name; Out = $out; Fix = $fix; Sources = @($sources | Sort-Object Name); GB = [math]::Round(($sources | Measure-Object Length -Sum).Sum / 1GB, 2) }
  }
}

$totalGB = [math]::Round(($plan | Measure-Object GB -Sum).Sum, 1)
Write-Host ""
Write-Host ("PLAN: {0} creature zips to make from {1} source zips, {2} GB" -f $plan.Count, ($plan | ForEach-Object { $_.Sources.Count } | Measure-Object -Sum).Sum, $totalGB)
$plan | Group-Object Folder | ForEach-Object { Write-Host ("  {0,-55} {1,3} creatures  {2,7} GB" -f $_.Name, $_.Count, [math]::Round(($_.Group | Measure-Object GB -Sum).Sum, 1)) }
if ($fixes) { Write-Host ""; Write-Host "FIRST (as each creature is made):"; $fixes | ForEach-Object { Write-Host ("  {0}\ {1}" -f $_.Folder, $_.Fix.Text) } }
if ($unstable) { Write-Host ""; Write-Host ("HELD (folder still changing in the last $StableMinutes min, untouched): {0}" -f $unstable.Count); $unstable | Group-Object Folder | ForEach-Object { Write-Host ("  {0}  ({1} creatures, newest {2})" -f $_.Name, $_.Count, $_.Group[0].Newest) } }
if ($skipped) { Write-Host ""; Write-Host ("SKIPPED - decide by hand: {0}" -f $skipped.Count); $skipped | ForEach-Object { Write-Host ("  {0}\{1}: {2}" -f $_.Folder, $_.Creature, $_.Why) } }
if ($unpaired) { Write-Host ""; Write-Host ("NO PARTNER (left as they are): {0}" -f $unpaired.Count); $unpaired | ForEach-Object { Write-Host ("  {0}\{1}" -f $_.Folder, $_.Name) } }
if (-not $Execute) { Write-Host ""; Write-Host "Dry run. Add -Execute to write (originals parked in _combined_originals; add -DeleteOriginals to remove them after verification)."; return }

Write-Host ""; Say "EXECUTE: $($plan.Count) creatures, $totalGB GB. Log: $log"
$done = 0; $failed = 0; $held = 0; $doneGB = 0; $t0 = Get-Date
foreach ($p in $plan) {
  $partial = $null
  try {
    # Per-file stability: size unchanged across 5 s (real files only).
    $real = @($p.Sources | Where-Object { $_ -is [System.IO.FileInfo] })
    $before = $real | ForEach-Object { (Get-Item -LiteralPath $_.FullName).Length }
    Start-Sleep -Seconds 5
    $after = $real | ForEach-Object { (Get-Item -LiteralPath $_.FullName).Length }
    if (($before -join ',') -ne ($after -join ',')) { Say "HOLD  $($p.Creature): a source is still growing"; $held++; continue }

    if ($p.Fix -and $p.Fix.Kind -eq 'dup') {
      Remove-Item -LiteralPath $p.Fix.File.FullName -Force
      Say ("DUP   {0}" -f $p.Fix.Text)
    } elseif ($p.Fix -and $p.Fix.Kind -eq 'rename') {
      Move-Item -LiteralPath $p.Fix.File.FullName -Destination $p.Fix.To
      Say ("NAME  {0}" -f $p.Fix.Text)
    }

    $names = @($p.Sources | ForEach-Object { $_.Name })
    $partial = $p.Out + ".partial"
    if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
    Say ("MAKE  {0}  <- {1}  ({2} GB)" -f $p.Creature, ($names -join ' + '), $p.GB)
    Push-Location -LiteralPath $p.Sources[0].DirectoryName
    try {
      & $SevenZip a -tzip -mx0 -bso0 -bsp0 -- $partial @names | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "7z a exit $LASTEXITCODE" }
      & $SevenZip t -bso0 -bsp0 -- $partial | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "7z t exit $LASTEXITCODE (archive failed verification)" }
      # Exactly the sources, each at its original size.
      $listing = & $SevenZip l -slt -- $partial
      $inArchive = @($listing | Where-Object { $_ -like "Path = *" } | Select-Object -Skip 1)
      if ($inArchive.Count -ne $p.Sources.Count) { throw "archive holds $($inArchive.Count) entries, expected $($p.Sources.Count)" }
      foreach ($s in $p.Sources) {
        $idx = [array]::IndexOf($listing, ("Path = " + $s.Name))
        if ($idx -lt 0) { throw "$($s.Name) missing from archive listing" }
        $sizeLine = ($listing[($idx + 1)..($idx + 12)] | Where-Object { $_ -like "Size = *" } | Select-Object -First 1)
        if (-not $sizeLine -or [int64]($sizeLine -replace 'Size = ', '') -ne [int64]$s.Length) { throw "$($s.Name): size inside archive does not match original" }
      }
      Move-Item -LiteralPath $partial -Destination $p.Out
    } finally { Pop-Location }

    if ($DeleteOriginals) {
      $p.Sources | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }
      Say ("OK    {0}.zip  (originals deleted)" -f $p.Creature)
    } else {
      $park = Join-Path $p.Sources[0].DirectoryName "_combined_originals"
      New-Item -ItemType Directory -Force -Path $park | Out-Null
      $p.Sources | ForEach-Object { Move-Item -LiteralPath $_.FullName -Destination (Join-Path $park $_.Name) }
      Say ("OK    {0}.zip  (originals -> _combined_originals)" -f $p.Creature)
    }
    $done++; $doneGB += $p.GB
  } catch {
    $failed++
    Say ("FAIL  {0}: {1}  (originals untouched; partial removed)" -f $p.Creature, $_.Exception.Message)
    if ($partial -and (Test-Path -LiteralPath $partial)) { Remove-Item -LiteralPath $partial -Force }
  }
  $mins = ((Get-Date) - $t0).TotalMinutes
  if ($done -gt 0) {
    $rate = $doneGB / [Math]::Max(0.1, $mins)
    $leftGB = [math]::Max(0, $totalGB - $doneGB)
    Say ("      {0}/{1} done, {2} failed - {3:n1} GB/min - ~{4:n0} min left" -f $done, $plan.Count, $failed, $rate, ($leftGB / [Math]::Max(0.01, $rate)))
  }
}
Say ("DONE  {0} made, {1} failed, {2} held. Elapsed {3:hh\:mm\:ss}" -f $done, $failed, $held, ((Get-Date) - $t0))
if ($failed) { exit 1 }
