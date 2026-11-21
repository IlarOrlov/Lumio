'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VIDEO_EXT = new Set(['.mkv', '.mp4', '.m4v', '.webm', '.mov']);
const SUB_EXT = new Set(['.srt', '.vtt']);
const IMAGE_EXT = ['.webp', '.jpg', '.jpeg', '.png'];
const POSTER_STEMS = ['poster', 'folder', 'cover'];
const SEASON_DIR = /^(season|staffel|saison|temporada|сезон)[\s._-]*\d+$|^s\d{1,2}$/i;

/** Poster files in a directory (every format present, e.g. poster.webp + poster.png). */
function postersIn(dir, names) {
  for (const stem of POSTER_STEMS) {
    const found = IMAGE_EXT.map((x) => stem + x).filter((n) => names.has(n)).map((n) => path.join(dir, n));
    if (found.length) return found;
  }
  return [];
}
const postersCache = new Map();
function postersOfDir(dir) {
  if (!postersCache.has(dir)) {
    let names = new Set();
    try { names = new Set(fs.readdirSync(dir).map((n) => n.toLowerCase())); } catch { /* unreadable */ }
    postersCache.set(dir, postersIn(dir, names));
  }
  return postersCache.get(dir);
}

const JUNK = /\b(2160p|1080p|720p|480p|4k|uhd|hdr10?|dv|bluray|blu-ray|bdrip|brrip|web-?dl|webrip|web|hdtv|dvdrip|remux|x264|x265|h\.?264|h\.?265|hevc|avc|aac\d?(\.\d)?|ac3|dts(-hd)?|ddp?\d(\.\d)?|atmos|10bit|proper|repack|extended|unrated|imax)\b.*$/i;

function mediaId(absPath) {
  return crypto.createHash('sha256').update(absPath).digest('hex').slice(0, 20);
}

function cleanTitle(s) {
  s = s.replace(/\[[^\]]*\]/g, ' ').replace(/[._]+/g, ' ');
  // Cut release tags, but never the first word ("Remux Film", "Web Therapy")
  const junk = JUNK.exec(s);
  if (junk && junk.index > 0 && s.slice(0, junk.index).trim()) s = s.slice(0, junk.index);
  return s
    .replace(/[\s\-–(]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parses a file path into movie or episode metadata. */
function parseName(absPath) {
  const base = path.basename(absPath, path.extname(absPath));
  const ep = /^(.*?)[\s._-]*(?:s(\d{1,2})[\s._-]*e(\d{1,3})|(\d{1,2})x(\d{2,3}))(?:[\s._-]*e\d{1,3})*(.*)$/i.exec(base);
  if (ep) {
    const season = Number(ep[2] ?? ep[4]);
    const episode = Number(ep[3] ?? ep[5]);
    let show = cleanTitle(ep[1]);
    if (!show) {
      // "Show/Season 1/S01E02.mkv" -> take the folder name above "Season X"
      let dir = path.dirname(absPath);
      if (/^(season|series|s)\s*\d+$/i.test(path.basename(dir))) dir = path.dirname(dir);
      show = cleanTitle(path.basename(dir));
    }
    const epTitle = cleanTitle(ep[6].replace(/^[\s._-]+/, ''));
    return { kind: 'episode', show, season, episode, title: epTitle || `Episode ${episode}` };
  }
  const yearMatch = /^(.*?)[\s._([]+((?:19|20)\d{2})(?:[\s._)\]]|$)/.exec(base);
  if (yearMatch) {
    return { kind: 'movie', title: cleanTitle(yearMatch[1]) || base, year: Number(yearMatch[2]) };
  }
  return { kind: 'movie', title: cleanTitle(base) || base, year: null };
}

function showKey(name) {
  return crypto.createHash('sha256').update(name.toLowerCase()).digest('hex').slice(0, 16);
}

/**
 * Walks media directories without following symlinks out of the library,
 * returning a Map of id -> item. Every served path comes from this map, so
 * user input is never joined into a filesystem path.
 */
function scanLibrary(mediaDirs) {
  const items = new Map();
  const roots = mediaDirs.map((d) => fs.realpathSync(d));
  const insideRoot = (p) => roots.some((r) => p === r || p.startsWith(r + path.sep));
  postersCache.clear();

  const walk = (dir, depth) => {
    if (depth > 12) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const names = new Set(entries.map((e) => e.name.toLowerCase()));
    const dirPosters = postersIn(dir, names);

    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      let full = path.join(dir, e.name);
      let stat;
      try {
        if (e.isSymbolicLink()) {
          full = fs.realpathSync(full);
          if (!insideRoot(full)) continue; // refuse links that escape the library
        }
        stat = fs.statSync(full);
      } catch { continue; }

      if (stat.isDirectory()) { walk(full, depth + 1); continue; }
      if (!stat.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!VIDEO_EXT.has(ext)) continue;
      if (/\bsample\b/i.test(e.name) && stat.size < 300 * 1024 * 1024) continue;

      const stem = e.name.slice(0, -ext.length);
      const sidecarSubs = entries
        .filter((s) => SUB_EXT.has(path.extname(s.name).toLowerCase()) && s.name.startsWith(stem))
        .map((s) => {
          const lang = s.name.slice(stem.length, -path.extname(s.name).length).replace(/^[._-]+/, '');
          return { path: path.join(dir, s.name), label: lang || 'External' };
        });
      const ownPosters = IMAGE_EXT.map((x) => stem + x).filter((n) => names.has(n.toLowerCase())).map((n) => path.join(dir, n));

      const meta = parseName(full);
      const id = mediaId(full);
      items.set(id, {
        id,
        path: full,
        ext,
        size: stat.size,
        mtime: Math.floor(stat.mtimeMs),
        addedAt: Math.floor(stat.birthtimeMs || stat.mtimeMs),
        ...meta,
        showKey: meta.kind === 'episode' ? showKey(meta.show) : null,
        // Episodes keep their own frame thumbnail unless the file has its own picture;
        // a poster in the series folder (or a season folder) becomes the series poster.
        posters: ownPosters.length ? ownPosters : (meta.kind === 'episode' ? [] : dirPosters),
        showPosters: meta.kind === 'episode'
          ? (SEASON_DIR.test(path.basename(dir)) ? [...postersOfDir(path.dirname(dir)), ...dirPosters] : dirPosters)
          : [],
        sidecarSubs,
      });
    }
  };

  for (const root of roots) walk(root, 0);
  return items;
}

/** Groups episodes into shows with ordered seasons and episodes. */
function buildShows(items) {
  const shows = new Map();
  for (const it of items.values()) {
    if (it.kind !== 'episode') continue;
    let show = shows.get(it.showKey);
    if (!show) {
      show = { key: it.showKey, name: it.show, episodes: [], posters: [], addedAt: 0 };
      shows.set(it.showKey, show);
    }
    show.episodes.push(it);
    show.addedAt = Math.max(show.addedAt, it.addedAt);
    if (!show.posters.length && it.showPosters.length) show.posters = it.showPosters;
  }
  for (const show of shows.values()) {
    show.episodes.sort((a, b) => a.season - b.season || a.episode - b.episode || a.path.localeCompare(b.path));
  }
  return shows;
}

function nextEpisode(shows, item) {
  if (!item || item.kind !== 'episode') return null;
  const show = shows.get(item.showKey);
  if (!show) return null;
  const i = show.episodes.findIndex((e) => e.id === item.id);
  return i >= 0 && i + 1 < show.episodes.length ? show.episodes[i + 1] : null;
}

module.exports = { scanLibrary, buildShows, nextEpisode, parseName, mediaId, cleanTitle };
