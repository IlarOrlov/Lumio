'use strict';
const { scanLibrary, buildShows, nextEpisode } = require('./library');
const { PROBE_VERSION } = require('./media');

/**
 * Holds the scanned library plus cached ffprobe results. Probing runs in the
 * background with limited concurrency; results are persisted in SQLite and
 * reused while a file's size and mtime are unchanged.
 */
class Catalog {
  constructor(db, mediaDirs, { probe, log = console } = {}) {
    this.db = db;
    this.mediaDirs = mediaDirs;
    this.probeFn = probe;
    this.log = log;
    this.items = new Map();
    this.shows = new Map();
    this.probes = new Map();
    this.inflight = new Map();
    this.scanning = false;
    this.q = {
      get: db.prepare('SELECT size, mtime, info FROM probes WHERE media_id = ?'),
      put: db.prepare('INSERT OR REPLACE INTO probes (media_id, size, mtime, info) VALUES (?, ?, ?, ?)'),
    };
  }

  rescan() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      this.items = scanLibrary(this.mediaDirs);
      this.shows = buildShows(this.items);
      this.log.info?.(`[lumio] library: ${this.items.size} files, ${this.shows.size} series`);
    } finally {
      this.scanning = false;
    }
    this.probeAllInBackground();
  }

  get(id) {
    return typeof id === 'string' && /^[0-9a-f]{20}$/.test(id) ? this.items.get(id) || null : null;
  }

  cachedProbe(item) {
    const mem = this.probes.get(item.id);
    if (mem && mem.size === item.size && mem.mtime === item.mtime && mem.info.v === PROBE_VERSION) return mem.info;
    const row = this.q.get.get(item.id);
    if (row && row.size === item.size && row.mtime === item.mtime) {
      const info = JSON.parse(row.info);
      if (info.v !== PROBE_VERSION) return null;
      this.probes.set(item.id, { size: item.size, mtime: item.mtime, info });
      return info;
    }
    return null;
  }

  async probe(item) {
    const cached = this.cachedProbe(item);
    if (cached) return cached;
    if (this.inflight.has(item.id)) return this.inflight.get(item.id);
    const p = this.probeFn(item.path).then((info) => {
      this.probes.set(item.id, { size: item.size, mtime: item.mtime, info });
      this.q.put.run(item.id, item.size, item.mtime, JSON.stringify(info));
      return info;
    }).finally(() => this.inflight.delete(item.id));
    this.inflight.set(item.id, p);
    return p;
  }

  async probeAllInBackground(concurrency = 3) {
    const queue = [...this.items.values()].filter((it) => !this.cachedProbe(it));
    const worker = async () => {
      while (queue.length) {
        const it = queue.shift();
        try { await this.probe(it); } catch (e) { this.log.warn?.(`[lumio] probe failed for one file: ${e.message.slice(0, 120)}`); }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  next(item) { return nextEpisode(this.shows, item); }

  /** Public, path-free representation of an item. */
  summary(item) {
    const info = this.cachedProbe(item);
    const base = {
      id: item.id, kind: item.kind, title: item.title, year: item.year ?? null,
      addedAt: item.addedAt, duration: info ? info.duration : null,
      resolution: info && info.video ? `${info.video.height}p` : null,
    };
    if (item.kind === 'episode') {
      Object.assign(base, { show: item.show, showKey: item.showKey, season: item.season, episode: item.episode });
    }
    return base;
  }

  showSummary(show) {
    return {
      key: show.key, name: show.name, addedAt: show.addedAt,
      episodeCount: show.episodes.length,
      seasons: [...new Set(show.episodes.map((e) => e.season))].length,
      thumbId: show.episodes[0].id,
      poster: show.posters.length > 0,
    };
  }
}

module.exports = { Catalog };
