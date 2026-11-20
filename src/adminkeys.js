'use strict';
/*
 * One-time keys for unlocking the admin console.
 *
 * The launcher asks for a key over a unix socket inside the owner-only data
 * directory (dir 0700, socket 0600), so only the same OS user can get one.
 * The key then appears briefly in the browser's command line (visible to
 * other local users via /proc), so each key is single-use and expires after
 * 60 seconds: by the time anyone could copy it, it's worthless.
 */
const fs = require('node:fs');
const net = require('node:net');
const { randomToken, safeEqual } = require('./auth');

class AdminKeys {
  constructor({ ttlMs = 60_000, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.keys = new Map(); // key -> expiry
  }

  issue() {
    this.prune();
    if (this.keys.size >= 20) this.keys.delete(this.keys.keys().next().value);
    const key = randomToken(32);
    this.keys.set(key, this.now() + this.ttlMs);
    return key;
  }

  /** True once per valid, unexpired key. */
  consume(candidate) {
    this.prune();
    if (typeof candidate !== 'string') return false;
    for (const key of this.keys.keys()) {
      if (safeEqual(key, candidate)) {
        this.keys.delete(key);
        return true;
      }
    }
    return false;
  }

  prune() {
    const t = this.now();
    for (const [k, exp] of this.keys) if (exp < t) this.keys.delete(k);
  }

  /** Serves a fresh key to each local connection on an owner-only unix socket. */
  listen(socketPath) {
    try { fs.unlinkSync(socketPath); } catch { /* not there */ }
    const server = net.createServer((conn) => {
      conn.end(this.issue());
    });
    const old = process.umask(0o177);
    return new Promise((resolve, reject) => {
      server.once('error', (e) => { process.umask(old); reject(e); });
      server.listen(socketPath, () => {
        process.umask(old);
        fs.chmodSync(socketPath, 0o600);
        resolve(server);
      });
    });
  }
}

module.exports = { AdminKeys };
