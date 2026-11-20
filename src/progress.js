'use strict';

/** A title counts as watched once 92% is reached, or when only credits remain. */
function isCompleted(position, duration) {
  if (!(duration > 0)) return false;
  const ratio = position / duration;
  return ratio >= 0.92 || (ratio >= 0.85 && duration - position <= 120);
}

class Progress {
  constructor(db, { now = Date.now } = {}) {
    this.now = now;
    this.q = {
      upsert: db.prepare(`INSERT INTO progress (device_id, media_id, position, duration, completed, updated_at)
                          VALUES (?, ?, ?, ?, ?, ?)
                          ON CONFLICT(device_id, media_id) DO UPDATE SET
                            position = excluded.position, duration = excluded.duration,
                            completed = MAX(progress.completed, excluded.completed),
                            updated_at = excluded.updated_at`),
      setState: db.prepare(`INSERT INTO progress (device_id, media_id, position, duration, completed, updated_at)
                            VALUES (?, ?, ?, ?, ?, ?)
                            ON CONFLICT(device_id, media_id) DO UPDATE SET
                              position = excluded.position, completed = excluded.completed,
                              updated_at = excluded.updated_at`),
      remove: db.prepare('DELETE FROM progress WHERE device_id = ? AND media_id = ?'),
      all: db.prepare('SELECT media_id, position, duration, completed, updated_at FROM progress WHERE device_id = ? ORDER BY updated_at DESC'),
    };
  }

  save(deviceId, mediaId, position, duration) {
    const completed = isCompleted(position, duration) ? 1 : 0;
    // Rewatching from the start of a finished title resets it to "in progress".
    if (!completed && position < 60) {
      this.q.setState.run(deviceId, mediaId, position, duration, 0, this.now());
    } else {
      this.q.upsert.run(deviceId, mediaId, position, duration, completed, this.now());
    }
    return { completed: !!completed };
  }

  markWatched(deviceId, mediaId, duration) {
    this.q.setState.run(deviceId, mediaId, 0, duration || 0, 1, this.now());
  }

  clear(deviceId, mediaId) { this.q.remove.run(deviceId, mediaId); }

  rows(deviceId) {
    return this.q.all.all(deviceId).map((r) => ({
      id: r.media_id, position: r.position, duration: r.duration,
      completed: !!r.completed, updatedAt: r.updated_at,
    }));
  }

  /**
   * Builds this device's "Continue watching" row: unfinished titles plus the
   * next episode of any series whose latest watched episode was finished.
   * One entry per series, most recent first.
   */
  continueWatching(deviceId, catalog, limit = 20) {
    const rows = this.rows(deviceId);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const seenShows = new Set();
    const out = [];
    for (const r of rows) {
      const item = catalog.get(r.id);
      if (!item) continue;
      if (item.kind === 'episode') {
        if (seenShows.has(item.showKey)) continue;
        seenShows.add(item.showKey);
      }
      if (!r.completed && r.position >= 15) {
        out.push({ id: r.id, position: r.position, duration: r.duration, updatedAt: r.updatedAt, upNext: false });
      } else if (r.completed && item.kind === 'episode') {
        const nxt = catalog.next(item);
        const np = nxt && byId.get(nxt.id);
        if (nxt && !(np && np.completed)) {
          out.push({ id: nxt.id, position: np ? np.position : 0, duration: np ? np.duration : 0, updatedAt: r.updatedAt, upNext: true });
        }
      }
      if (out.length >= limit) break;
    }
    return out;
  }
}

module.exports = { Progress, isCompleted };
