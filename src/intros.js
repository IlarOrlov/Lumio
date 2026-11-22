'use strict';
/*
 * Finds repeated intros in series and offers "Skip intro" in the player.
 *
 * How it works: the first minutes of every episode's audio are turned into a
 * Chromaprint fingerprint (ffmpeg's chromaprint muxer, ~8 values per second).
 * Episodes of the same season are compared with their neighbours at every
 * possible time offset; stretches where the audio matches (a title sequence,
 * a studio logo, an opening theme) show up as long runs of near-identical
 * values. A stretch that recurs in at least two other episodes becomes a skip
 * segment for that episode (median start/end of all its matches, so one
 * sloppy match can't make it cut into the story).
 *
 * The admin console can override any episode by hand ("manual"); manual
 * segments are never replaced by automatic detection. Fingerprints are cached
 * in the database, so re-detecting is quick.
 *
 * The same comparison over the last minutes finds the closing credits (a
 * logo and credit roll that recur at the end of every episode). Their start
 * is when an episode counts as watched, and when "Up next" appears.
 *
 * Work runs in the background at low CPU priority, one ffmpeg at a time, yielding between comparisons so
 * streaming stays smooth.
 */
const os = require('node:os');
const { spawn } = require('node:child_process');
const { SAFE_INPUT, asInput } = require('./media');

const STEP = 4096 / 3 / 11025;   // seconds per Chromaprint value (~0.124 s)
const SCAN_SECONDS = 600;        // look for intros in the first 10 minutes
const NEIGHBOURS = 4;            // compare each episode with up to 4 on each side
const MAX_BITS = 8;              // values "match" if at most 8 of 32 bits differ
const GAP = 6;                   // tolerate ~0.75 s of mismatch inside a run
const MIN_LEN = 4;               // seconds
const MAX_LEN = 150;             // seconds
const MIN_SUPPORT = 2;           // must recur in at least 2 other episodes
const MAX_SEGMENTS = 3;
const TAIL_SECONDS = 300;        // look for closing credits in the last 5 minutes
const CREDITS_NEAR_END = 20;     // credits run until (nearly) the end of the file

const SCHEMA = `
CREATE TABLE IF NOT EXISTS intro_fp (
  media_id TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime INTEGER NOT NULL, fp BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS intros (
  media_id TEXT PRIMARY KEY, segments TEXT NOT NULL, source TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS credits_fp (
  media_id TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime INTEGER NOT NULL, start REAL NOT NULL, fp BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS credits (
  media_id TEXT PRIMARY KEY, start REAL, size INTEGER NOT NULL, mtime INTEGER NOT NULL, updated_at INTEGER NOT NULL
);`;

const pop = (x) => {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const round1 = (x) => Math.round(x * 10) / 10;

/**
 * All matching runs between fingerprints a and b, at every time offset.
 * Returns [{ aStart, aEnd, bStart, bEnd }] in seconds.
 */
function matchRuns(a, b) {
  const out = [];
  const minPts = Math.ceil(MIN_LEN / STEP);
  const maxPts = Math.ceil(MAX_LEN / STEP);
  const push = (st, last, hits, sh) => {
    const len = last - st + 1;
    if (len >= minPts && len <= maxPts && hits / len > 0.6) {
      out.push({ aStart: st * STEP, aEnd: (last + 1) * STEP, bStart: (st - sh) * STEP, bEnd: (last + 1 - sh) * STEP });
    }
  };
  for (let sh = -(b.length - minPts); sh <= a.length - minPts; sh++) {
    const lo = Math.max(0, sh);
    const hi = Math.min(a.length, b.length + sh);
    let st = -1; let last = -1; let hits = 0;
    for (let i = lo; i < hi; i++) {
      if (pop(a[i] ^ b[i - sh]) <= MAX_BITS) {
        if (st < 0 || i - last > GAP) { if (st >= 0) push(st, last, hits, sh); st = i; hits = 0; }
        last = i; hits += 1;
      }
    }
    if (st >= 0) push(st, last, hits, sh);
  }
  return out;
}

/**
 * Turns the matches found for one episode into skip segments: overlapping
 * matches are clustered; clusters seen in >= MIN_SUPPORT other episodes win.
 * matches: [{ start, end, other }]
 */
function segmentsFrom(matches) {
  const sorted = [...matches].sort((x, y) => x.start - y.start);
  const clusters = [];
  for (const m of sorted) {
    const c = clusters.find((k) => m.start < k.hi + 1 && m.end > k.lo - 1);
    if (c) { c.lo = Math.min(c.lo, m.start); c.hi = Math.max(c.hi, m.end); c.items.push(m); c.others.add(m.other); } else {
      clusters.push({ lo: m.start, hi: m.end, items: [m], others: new Set([m.other]) });
    }
  }
  return clusters
    .filter((c) => c.others.size >= MIN_SUPPORT)
    .map((c) => ({ start: (() => { const st = median(c.items.map((m) => m.start)); return st < 1.5 ? 0 : round1(st); })(), end: round1(median(c.items.map((m) => m.end))), support: c.others.size }))
    .filter((s) => s.end - s.start >= MIN_LEN)
    .sort((x, y) => y.support - x.support || (y.end - y.start) - (x.end - x.start))
    .slice(0, MAX_SEGMENTS)
    .sort((x, y) => x.start - y.start)
    .map(({ start, end }) => ({ start, end }));
}

/**
 * Start of the closing credits, in seconds into the fingerprinted tail, from
 * the tail's recurring segments: the segment that runs to (nearly) the end,
 * extended back over directly adjoining recurring segments. null if none.
 */
function creditsFrom(matches, tailLen) {
  const segs = segmentsFrom(matches);
  let i = segs.length - 1;
  while (i >= 0 && segs[i].end < tailLen - CREDITS_NEAR_END) i -= 1;
  if (i < 0) return null;
  let start = segs[i].start;
  while (i > 0 && segs[i - 1].end >= start - 3) { i -= 1; start = segs[i].start; }
  return start;
}

/** Validates/normalises segments from the admin console. */
function cleanSegments(list, duration) {
  if (!Array.isArray(list) || list.length > MAX_SEGMENTS) throw Object.assign(new Error(`Up to ${MAX_SEGMENTS} segments per episode`), { status: 400 });
  const max = Number.isFinite(duration) && duration > 0 ? duration : 6 * 3600;
  const out = list.map((s) => ({ start: Number(s && s.start), end: Number(s && s.end) })).map((s) => {
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < 0 || s.end <= s.start || s.end > max || s.end - s.start > 15 * 60) {
      throw Object.assign(new Error('Each segment needs a start before its end, inside the episode (max 15 min)'), { status: 400 });
    }
    return { start: round1(s.start), end: round1(s.end) };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < out.length; i++) if (out[i].start < out[i - 1].end) throw Object.assign(new Error('Segments overlap'), { status: 400 });
  return out;
}

const yieldNow = () => new Promise((r) => setImmediate(r));

class IntroDetector {
  constructor({ db, catalog, log = console }) {
    db.exec(SCHEMA);
    this.db = db;
    this.catalog = catalog; // () => Catalog
    this.log = log;
    this.queue = [];        // show keys
    this.force = new Set(); // show keys to re-detect even if already done
    this.running = false;
    this.cancelled = false;
    this.child = null;
    this.currentKey = null;
    this.state = { phase: 'idle', show: null, done: 0, total: 0, error: null };
    this.q = {
      getFp: db.prepare('SELECT size, mtime, fp FROM intro_fp WHERE media_id = ?'),
      putFp: db.prepare('INSERT OR REPLACE INTO intro_fp (media_id, size, mtime, fp) VALUES (?, ?, ?, ?)'),
      get: db.prepare('SELECT segments, source, updated_at FROM intros WHERE media_id = ?'),
      put: db.prepare('INSERT OR REPLACE INTO intros (media_id, segments, source, updated_at) VALUES (?, ?, ?, ?)'),
      del: db.prepare('DELETE FROM intros WHERE media_id = ?'),
      getTailFp: db.prepare('SELECT size, mtime, start, fp FROM credits_fp WHERE media_id = ?'),
      putTailFp: db.prepare('INSERT OR REPLACE INTO credits_fp (media_id, size, mtime, start, fp) VALUES (?, ?, ?, ?, ?)'),
      getCredits: db.prepare('SELECT start, size, mtime FROM credits WHERE media_id = ?'),
      putCredits: db.prepare('INSERT OR REPLACE INTO credits (media_id, start, size, mtime, updated_at) VALUES (?, ?, ?, ?, ?)'),
    };
  }

  /** Skip segments for one item: { segments, source } or null when unknown. */
  get(mediaId) {
    const row = this.q.get.get(mediaId);
    return row ? { segments: JSON.parse(row.segments), source: row.source, updatedAt: row.updated_at } : null;
  }

  /** Where the closing credits begin (seconds), or null when unknown. */
  creditsAt(mediaId) {
    const row = this.q.getCredits.get(mediaId);
    return row && Number.isFinite(row.start) ? row.start : null;
  }

  /** True when the credits of this exact file (size/mtime) were looked for. */
  creditsChecked(item) {
    const row = this.q.getCredits.get(item.id);
    return !!row && row.size === item.size && row.mtime === item.mtime;
  }

  setManual(item, segments) {
    const clean = cleanSegments(segments, (this.catalog().cachedProbe(item) || {}).duration);
    this.q.put.run(item.id, JSON.stringify(clean), 'manual', Date.now());
    return clean;
  }

  /** Drops the manual override and re-detects the episode's series. */
  resetToAuto(item) {
    this.q.del.run(item.id);
    this.schedule(item.showKey, { force: true });
  }

  /** Copies one episode's segments to every episode of its season (as manual). */
  applyToSeason(item) {
    const cur = this.get(item.id);
    const show = this.catalog().shows.get(item.showKey);
    if (!cur || !show) return 0;
    let n = 0;
    for (const ep of show.episodes) {
      if (ep.season !== item.season) continue;
      const dur = (this.catalog().cachedProbe(ep) || {}).duration;
      const fits = cur.segments.filter((s) => !Number.isFinite(dur) || s.end <= dur);
      this.q.put.run(ep.id, JSON.stringify(fits), 'manual', Date.now());
      n += 1;
    }
    return n;
  }

  /** Queues series whose episodes have no result yet (or all, with force). */
  schedule(showKey = null, { force = false } = {}) {
    const cat = this.catalog();
    const keys = showKey ? [showKey] : [...cat.shows.keys()];
    for (const k of keys) {
      const show = cat.shows.get(k);
      if (!show) continue;
      const pending = force || show.episodes.some((e) => !this.q.get.get(e.id) || !this.creditsChecked(e));
      if (!pending || (!force && k === this.currentKey)) continue; // already being checked
      if (force) this.force.add(k);
      if (!this.queue.includes(k)) this.queue.push(k);
    }
    if (!this.running && this.queue.length) this.run().catch((e) => { this.state.error = e.message; this.running = false; });
  }

  async run() {
    this.running = true;
    this.cancelled = false;
    this.state.error = null;
    while (this.queue.length && !this.cancelled) {
      const key = this.queue.shift();
      const force = this.force.delete(key);
      this.currentKey = key;
      try { await this.detectShow(key, { force }); } catch (e) {
        this.state.error = e.message;
        this.log.warn?.(`intro detection failed for a series: ${e.message}`);
      }
    }
    this.running = false;
    this.currentKey = null;
    this.state.phase = 'idle';
    this.state.show = null;
  }

  cancel() {
    this.cancelled = true;
    this.queue = [];
    if (this.child) this.child.kill('SIGKILL');
  }

  status() { return { ...this.state, queued: this.queue.length }; }

  async detectShow(key, { force = false } = {}) {
    const cat = this.catalog();
    const show = cat.shows.get(key);
    if (!show) return;
    const seasons = new Map();
    for (const ep of show.episodes) {
      if (!seasons.has(ep.season)) seasons.set(ep.season, []);
      seasons.get(ep.season).push(ep);
    }
    const total = show.episodes.length;
    Object.assign(this.state, { phase: 'fingerprinting', show: show.name, done: 0, total });
    let found = 0;
    let credited = 0;
    for (const eps of seasons.values()) {
      eps.sort((a, b) => a.episode - b.episode);
      const fps = [];
      for (const ep of eps) {
        if (this.cancelled) return;
        fps.push(await this.fingerprint(ep));
        this.state.done += 1;
      }
      this.state.phase = 'comparing';
      const matches = eps.map(() => []);
      for (let i = 0; i < eps.length; i++) {
        for (let j = i + 1; j < eps.length && j - i <= NEIGHBOURS; j++) {
          if (this.cancelled) return;
          if (!fps[i] || !fps[j]) continue;
          for (const r of matchRuns(fps[i], fps[j])) {
            matches[i].push({ start: r.aStart, end: r.aEnd, other: j });
            matches[j].push({ start: r.bStart, end: r.bEnd, other: i });
          }
          await yieldNow(); // keep the server responsive
        }
      }
      for (let i = 0; i < eps.length; i++) {
        const prev = this.q.get.get(eps[i].id);
        if (prev && prev.source === 'manual') continue;
        if (prev && !force) continue;
        this.q.put.run(eps[i].id, JSON.stringify(segmentsFrom(matches[i])), 'auto', Date.now());
      }
      for (const ep of eps) { const r = this.get(ep.id); if (r && r.segments.length) found += 1; }
      credited += await this.detectCredits(eps, { force });
      this.state.phase = 'fingerprinting';
    }
    this.log.info?.(`intros: ${show.name}: skip segments found in ${found} of ${total} episodes, credits in ${credited}`);
  }

  /** Finds the closing credits of one season's episodes (cached per file). */
  async detectCredits(eps, { force = false } = {}) {
    if (!force && eps.every((e) => this.creditsChecked(e))) return eps.filter((e) => this.creditsAt(e.id) !== null).length;
    const tails = [];
    for (const ep of eps) {
      if (this.cancelled) return 0;
      tails.push(await this.tailFingerprint(ep));
    }
    const matches = eps.map(() => []);
    for (let i = 0; i < eps.length; i++) {
      for (let j = i + 1; j < eps.length && j - i <= NEIGHBOURS; j++) {
        if (this.cancelled) return 0;
        if (!tails[i] || !tails[j]) continue;
        for (const r of matchRuns(tails[i].fp, tails[j].fp)) {
          matches[i].push({ start: r.aStart, end: r.aEnd, other: j });
          matches[j].push({ start: r.bStart, end: r.bEnd, other: i });
        }
        await yieldNow();
      }
    }
    let n = 0;
    for (let i = 0; i < eps.length; i++) {
      const t = tails[i];
      const rel = t ? creditsFrom(matches[i], t.fp.length * STEP) : null;
      const start = rel === null ? null : round1(t.start + rel);
      this.q.putCredits.run(eps[i].id, start, eps[i].size, eps[i].mtime, Date.now());
      if (start !== null) n += 1;
    }
    return n;
  }

  /** Chromaprint of the last TAIL_SECONDS of audio; start = where the tail begins in the file. */
  async tailFingerprint(item) {
    const row = this.q.getTailFp.get(item.id);
    if (row && row.size === item.size && row.mtime === item.mtime) {
      const b = row.fp;
      return { start: row.start, fp: new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) };
    }
    const duration = (this.catalog().cachedProbe(item) || {}).duration;
    if (!(duration > 60)) return null;
    const start = Math.max(0, duration - TAIL_SECONDS);
    const buf = await this.chromaprint(item, ['-ss', start.toFixed(3)], TAIL_SECONDS + 5);
    if (!buf || buf.length < 4 * Math.ceil(MIN_LEN / STEP)) return null;
    const usable = buf.subarray(0, buf.length - (buf.length % 4));
    this.q.putTailFp.run(item.id, item.size, item.mtime, start, usable);
    return { start, fp: new Uint32Array(usable.buffer.slice(usable.byteOffset, usable.byteOffset + usable.byteLength)) };
  }

  /** Chromaprint of the first SCAN_SECONDS of audio (cached by file size/mtime). */
  async fingerprint(item) {
    const row = this.q.getFp.get(item.id);
    if (row && row.size === item.size && row.mtime === item.mtime) {
      const b = row.fp;
      return new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    }
    const buf = await this.chromaprint(item, [], SCAN_SECONDS);
    if (!buf || buf.length < 4 * Math.ceil(MIN_LEN / STEP)) return null;
    const usable = buf.subarray(0, buf.length - (buf.length % 4));
    this.q.putFp.run(item.id, item.size, item.mtime, usable);
    return new Uint32Array(usable.buffer.slice(usable.byteOffset, usable.byteOffset + usable.byteLength));
  }

  /** Raw Chromaprint values of `seconds` of the first audio track, starting at seekArgs. */
  chromaprint(item, seekArgs, seconds) {
    return new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', [
        '-hide_banner', '-nostdin', '-v', 'error', ...SAFE_INPUT, ...seekArgs, '-t', String(seconds), '-i', asInput(item.path),
        '-map', '0:a:0', '-vn', '-sn', '-ac', '1', '-f', 'chromaprint', '-fp_format', 'raw', 'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
      this.child = child;
      try { os.setPriority(child.pid, 19); } catch { /* best effort */ }
      const out = [];
      let size = 0;
      const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
      child.stdout.on('data', (c) => { size += c.length; if (size > 4 * 1024 * 1024) child.kill('SIGKILL'); else out.push(c); });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        this.child = null;
        if (code === 0) resolve(Buffer.concat(out)); else resolve(null); // no audio / unreadable: skip this episode
      });
    });
  }
}

module.exports = { IntroDetector, matchRuns, segmentsFrom, creditsFrom, cleanSegments, STEP };
