'use strict';

/**
 * A title counts as watched once the viewer reaches its closing credits.
 * creditsAt comes from credit detection (src/intros.js); without it, only the
 * last 3% (at least 40 s) counts, where credits are in practice.
 */
function isCompleted(position, duration, creditsAt = null) {
  if (!(duration > 0)) return false;
  if (creditsAt > 0 && creditsAt < duration && duration - creditsAt <= 600) return position >= creditsAt - 1;
  return duration - position <= Math.max(40, duration * 0.03);
}

class Progress {
  constructor(db, { now = Date.now, creditsOf = () => null } = {}) {
    this.now = now;
    this.creditsOf = creditsOf; // mediaId -> where its closing credits start, or null
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
      one: db.prepare('SELECT completed FROM progress WHERE device_id = ? AND media_id = ?'),
      all: db.prepare('SELECT media_id, position, duration, completed, updated_at FROM progress WHERE device_id = ? ORDER BY updated_at DESC'),
    };
  }

  /**
   * Stores the position. "Watched" sticks once the credits were reached:
   * opening a finished episode again doesn't un-watch it (History can).
   */
  save(deviceId, mediaId, position, duration) {
    const completed = isCompleted(position, duration, this.creditsOf(mediaId)) ? 1 : 0;
    this.q.upsert.run(deviceId, mediaId, position, duration, completed, this.now());
    const row = this.q.one.get(deviceId, mediaId);
    return { completed: !!(row && row.completed) };
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
   * Builds this device's "Continue watching" row, most recent first:
   * unfinished films, and one entry per series pointing at where the viewer is.
   */
  continueWatching(deviceId, catalog, limit = 20) {
    const rows = this.rows(deviceId);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const shows = new Map(); // showKey -> rows of that series, most recent first
    const out = [];
    for (const r of rows) {
      const item = catalog.get(r.id);
      if (!item) continue;
      if (item.kind === 'episode') {
        if (!shows.has(item.showKey)) {
          shows.set(item.showKey, []);
          out.push({ showKey: item.showKey, updatedAt: r.updatedAt });
        }
        shows.get(item.showKey).push({ ...r, item });
      } else if (!r.completed && r.position >= 15) {
        out.push({ id: r.id, position: r.position, duration: r.duration, updatedAt: r.updatedAt, upNext: false });
      }
    }
    const result = [];
    for (const entry of out) {
      const e = entry.showKey ? resumeEpisode(shows.get(entry.showKey), byId, catalog, this.creditsOf) : entry;
      if (e) result.push({ ...e, updatedAt: entry.updatedAt });
      if (result.length >= limit) break;
    }
    return result;
  }
}

const order = (it) => (it.season || 0) * 100000 + (it.episode || 0);

/**
 * Where a series continues. An episode the viewer was really into (a minute
 * or more, unfinished) and touched last wins, so rewatching an old episode
 * resumes it. Otherwise the series continues from the furthest episode
 * reached: if it was finished, the first unfinished episode after it.
 * Opening episode 7 means the viewer is on episode 7, even when episodes 1-6
 * were watched before progress existed or only a few seconds were saved.
 */
function resumeEpisode(showRows, byId, catalog, creditsOf = () => null) {
  const [latest] = showRows;
  if (latest.position >= 60 && !isCompleted(latest.position, latest.duration, creditsOf(latest.id))) {
    return { id: latest.id, position: latest.position, duration: latest.duration, upNext: false };
  }
  const furthest = showRows.reduce((a, b) => (order(b.item) > order(a.item) ? b : a));
  if (!furthest.completed) {
    const started = furthest.position >= 15;
    return { id: furthest.id, position: started ? furthest.position : 0, duration: furthest.duration, upNext: !started };
  }
  let nxt = catalog.next(furthest.item);
  while (nxt && byId.get(nxt.id) && byId.get(nxt.id).completed) nxt = catalog.next(nxt);
  if (!nxt) return null; // series finished
  const np = byId.get(nxt.id);
  return { id: nxt.id, position: np && np.position >= 15 ? np.position : 0, duration: np ? np.duration : 0, upNext: !(np && np.position >= 15) };
}

module.exports = { Progress, isCompleted, resumeEpisode };
