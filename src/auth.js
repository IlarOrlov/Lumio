'use strict';
const crypto = require('node:crypto');

// ---------- Password hashing (scrypt, memory-hard) ----------

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 64 };
const MAXMEM = 128 * SCRYPT.N * SCRYPT.r * 2;

function scryptAsync(password, salt, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, params.keylen, {
      N: params.N, r: params.r, p: params.p, maxmem: MAXMEM,
    }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scryptAsync(String(password), Buffer.from(saltB64, 'base64'), {
    N: Number(N), r: Number(r), p: Number(p), keylen: expected.length,
  });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// ---------- Login throttling ----------
// Behind VMware NAT port forwarding every client shares one source IP, so a
// per-IP limiter is meaningless. Instead a single global limiter locks login
// for everyone after repeated failures, doubling the lock each time.

class LoginLimiter {
  constructor({ windowMs = 15 * 60_000, maxPerWindow = 8, baseLockMs = 60_000, maxLockMs = 60 * 60_000, now = Date.now } = {}) {
    Object.assign(this, { windowMs, maxPerWindow, baseLockMs, maxLockMs, now });
    this.failures = [];      // timestamps of failed attempts (global)
    this.lockedUntil = 0;
    this.lockCount = 0;
  }

  retryAfterMs() {
    return Math.max(0, this.lockedUntil - this.now());
  }

  recordFailure() {
    const t = this.now();
    this.failures = this.failures.filter((f) => t - f < this.windowMs);
    this.failures.push(t);
    if (this.failures.length >= this.maxPerWindow) {
      const lock = Math.min(this.baseLockMs * 2 ** this.lockCount, this.maxLockMs);
      this.lockedUntil = t + lock;
      this.lockCount += 1;
      this.failures = [];
    }
  }

  recordSuccess() {
    this.failures = [];
    this.lockCount = 0;
    this.lockedUntil = 0;
  }
}

// ---------- Sessions ----------

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

class Sessions {
  constructor(db, { sessionDays = 180, now = Date.now } = {}) {
    this.db = db;
    this.ttl = sessionDays * 86_400_000;
    this.now = now;
    this.q = {
      insertDevice: db.prepare('INSERT INTO devices (id, name, user_agent, created_at, last_seen) VALUES (?, ?, ?, ?, ?)'),
      insertSession: db.prepare('INSERT INTO sessions (token_hash, device_id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'),
      find: db.prepare(`SELECT s.device_id, s.csrf, s.expires_at, d.name FROM sessions s
                        JOIN devices d ON d.id = s.device_id WHERE s.token_hash = ?`),
      touch: db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?'),
      deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
      purge: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
      listDevices: db.prepare('SELECT id, name, user_agent, created_at, last_seen FROM devices ORDER BY last_seen DESC'),
      deleteDevice: db.prepare('DELETE FROM devices WHERE id = ?'),
      renameDevice: db.prepare('UPDATE devices SET name = ? WHERE id = ?'),
      findByName: db.prepare('SELECT id FROM devices WHERE name = ? COLLATE NOCASE ORDER BY last_seen DESC LIMIT 1'),
      endAll: db.prepare('DELETE FROM sessions'),
      deleteAllDevices: db.prepare('DELETE FROM devices'),
    };
  }

  /**
   * Signs a device in and returns a fresh session token. Signing in again with
   * the same device name (e.g. after "sign out everywhere") reattaches to that
   * device, so its watch history is kept.
   */
  createDeviceSession(deviceName, userAgent) {
    const t = this.now();
    const token = randomToken(32);
    const existing = this.q.findByName.get(deviceName);
    const deviceId = existing ? existing.id : randomToken(12);
    if (existing) this.q.touch.run(t, deviceId);
    else this.q.insertDevice.run(deviceId, deviceName, String(userAgent || '').slice(0, 300), t, t);
    this.q.insertSession.run(sha256(token), deviceId, randomToken(24), t, t + this.ttl);
    return { token, deviceId };
  }

  /** Returns {deviceId, deviceName, csrf} for a valid token, else null. */
  lookup(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const hash = sha256(token);
    const row = this.q.find.get(hash);
    if (!row) return null;
    if (row.expires_at < this.now()) {
      this.q.deleteSession.run(hash);
      return null;
    }
    this.q.touch.run(this.now(), row.device_id);
    return { deviceId: row.device_id, deviceName: row.name, csrf: row.csrf, tokenHash: hash };
  }

  destroy(tokenHash) { this.q.deleteSession.run(tokenHash); }
  purgeExpired() { this.q.purge.run(this.now()); }
  listDevices() { return this.q.listDevices.all(); }
  revokeDevice(id) { return this.q.deleteDevice.run(id).changes > 0; }
  renameDevice(id, name) { return this.q.renameDevice.run(name, id).changes > 0; }
  /** Removes every device with its sessions and watch history. Returns how many. */
  revokeAllDevices() { return Number(this.q.deleteAllDevices.run().changes); }
  /** Signs out every device (history is kept; devices sign in again by name). */
  endAllSessions() { this.q.endAll.run(); }
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

module.exports = { hashPassword, verifyPassword, LoginLimiter, Sessions, safeEqual, sha256, randomToken };
