// The owned-library list. MMF's official API has no "my library" endpoint, so
// the list comes from the website's internal endpoint, saved by hand from a
// logged-in browser:
//   https://www.myminifactory.com/api/data-library/objectPreviews
//
// One object can appear in several rows (e.g. a Tribe month AND a creator
// release group). We keep every membership so the bundle folder can be chosen
// deliberately instead of by whichever row came first.

import { readFile } from 'node:fs/promises';
import { LIBRARY_PATH, readJson, writeJson } from './config.js';
import { safeName } from './names.js';

export const LIBRARY_URL = 'https://www.myminifactory.com/api/data-library/objectPreviews';

// "type:tribes-tier;owner:1448840;tribe:772;tier:1845;yearmonth:202606" -> object
export function parseRelease(release) {
  const out = {};
  for (const kv of String(release ?? '').split(';')) {
    const i = kv.indexOf(':');
    if (i > 0) out[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  return out;
}

const toMonth = (yyyymm) => (/^\d{6}$/.test(yyyymm ?? '') ? `${yyyymm.slice(0, 4)}-${yyyymm.slice(4)}` : null);

// One library row -> a membership describing which bundle it came from.
export function membershipOf(row) {
  const source = row.source ?? 'UNKNOWN';
  const rel = parseRelease(row.release);
  if (source === 'TRIBE') {
    return { source, kind: rel.type ?? 'tribe', month: toMonth(rel.yearmonth), tribe: rel.tribe ?? null };
  }
  if (source === 'USER_GROUP') return { source, kind: 'group', groupId: String(row.release ?? '') || null };
  if (source === 'FRONTIER') return { source, kind: 'frontier', campaignId: row.campaignId ?? null };
  return { source, kind: source.toLowerCase() };
}

export function buildEntries(rows) {
  const byId = new Map();
  for (const r of rows) {
    const id = r.originalId ?? r.id;
    if (id == null) continue;
    let e = byId.get(id);
    if (!e) {
      e = {
        id,
        name: r.name ?? '',
        creator: r.creatorName ?? r.creatorUsername ?? 'Unknown Creator',
        creatorId: r.creatorId ?? null,
        publishedAt: r.publishedAt ?? null,
        addedAt: r.libraryAddedAt ?? null,
        memberships: [],
      };
      byId.set(id, e);
    }
    const m = membershipOf(r);
    if (!e.memberships.some((x) => JSON.stringify(x) === JSON.stringify(m))) e.memberships.push(m);
  }
  return [...byId.values()];
}

export async function importLibrary(savedFile, { outPath = LIBRARY_PATH } = {}) {
  const text = (await readFile(savedFile, 'utf8')).replace(/^﻿/, '');
  if (text.trimStart().startsWith('<')) {
    throw new Error('That file is a web page, not JSON. Make sure you were logged in when you saved it.');
  }
  const raw = JSON.parse(text);
  const list = Array.isArray(raw) ? raw : raw.items ?? raw.data ?? raw.objects;
  if (!Array.isArray(list)) {
    throw new Error(`Unexpected shape. Top-level keys: ${Object.keys(raw).join(', ')}`);
  }
  const entries = buildEntries(list);
  await writeJson(outPath, { importedAt: new Date().toISOString(), entries });
  return { rawCount: list.length, entries, sample: list.slice(0, 2) };
}

export async function loadLibrary() {
  const lib = await readJson(LIBRARY_PATH);
  if (!lib) throw new Error('No library imported yet. Run: node mmf.js library <saved-file.json>');
  if (lib.entries.some((e) => !e.memberships)) {
    throw new Error('Library was imported by an older version. Re-run: node mmf.js library data\\objectPreviews.json');
  }
  return lib.entries;
}

// Creators whose content lives elsewhere (config "excludeCreators"),
// matched case-insensitively on display name.
export function applyExclusions(entries, excludeCreators = []) {
  const skip = new Set(excludeCreators.map((c) => c.trim().toLowerCase()));
  const kept = [];
  const excluded = [];
  for (const e of entries) (skip.has(String(e.creator).trim().toLowerCase()) ? excluded : kept).push(e);
  return { kept, excluded };
}

// Release groups have an id but no title in the library list. The real
// titles come from data/releases.json (synced by the Chrome extension from
// MMF's "Shared with me" view). Without it, best effort: a member object named
// "Release: Hollow Graves" names the group, dated by its earliest object.
const RELEASE_NAME = /^\s*release\s*[:\-–]\s*(.+?)\s*$/i;

export function deriveGroupTitles(entries, releases = {}) {
  const groups = new Map();
  for (const e of entries) {
    for (const m of e.memberships) {
      if (m.kind !== 'group' || !m.groupId) continue;
      const g = groups.get(m.groupId) ?? { title: null, month: null };
      const hit = RELEASE_NAME.exec(e.name);
      if (hit && !g.title) g.title = hit[1];
      const month = e.publishedAt ? e.publishedAt.slice(0, 7) : null;
      if (month && (!g.month || month < g.month)) g.month = month;
      groups.set(m.groupId, g);
    }
  }
  const titles = {};
  for (const [id, g] of groups) {
    const label = releases[id]?.label?.trim();
    titles[id] = label || [g.month, g.title ?? `Release ${id}`].filter(Boolean).join(' - ');
  }
  return titles;
}

// Picks the bundle folder for an object. Priority: Tribe month, creator
// release group, other Tribe rewards, then one-off sources. `overrides` maps
// a group id to a hand-chosen title (config "bundleTitles").
export function bundleFor(entry, groupTitles = {}, overrides = {}) {
  const ms = entry.memberships ?? [];
  const months = ms.filter((m) => m.kind === 'tribes-tier' && m.month).map((m) => m.month).sort();
  if (months.length) return months[0];

  const group = ms.find((m) => m.kind === 'group' && m.groupId);
  if (group) return overrides[group.groupId] ?? groupTitles[group.groupId] ?? `Release ${group.groupId}`;

  const kinds = new Set(ms.map((m) => m.kind));
  if (kinds.has('loyalty-sub')) return 'Loyalty Rewards';
  if (kinds.has('welcome-pack')) return 'Welcome Pack';
  if (kinds.has('store')) return 'Tribe Store';
  const frontier = ms.find((m) => m.kind === 'frontier');
  if (frontier) return frontier.campaignId ? `Frontier ${frontier.campaignId}` : 'Frontier';
  if (kinds.has('purchase')) return 'Purchases';
  if (kinds.has('download')) return 'Free Downloads';
  return 'Other';
}

export function destinationFor(entry, groupTitles, overrides) {
  return [safeName(entry.creator), safeName(bundleFor(entry, groupTitles, overrides))];
}
