'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { loadConfig, readRaw, writeRaw, resolveFromRoot, DEFAULTS } = require('./config');
const { randomToken, safeEqual } = require('./auth');
const { generateCert, certInfo, localIps } = require('./tls');
const { buildWindowsHelper } = require('./winhelper');
const { openDb } = require('./db');
const { Sessions, LoginLimiter } = require('./auth');
const { Catalog } = require('./catalog');
const { Progress } = require('./progress');
const { Compactor } = require('./compact');
const { createApp } = require('./app');
const media = require('./media');
const log = require('./log');

/**
 * Owns the database and the streaming (LAN) listener. The admin console uses
 * it to start, stop and reconfigure streaming without restarting the process.
 */
class Runtime {
  constructor() {
    const raw = readRaw() || {};
    this.dataDir = resolveFromRoot(raw.dataDir || DEFAULTS.dataDir);
    this.db = openDb(this.dataDir);
    this.sessions = new Sessions(this.db, { sessionDays: raw.sessionDays || DEFAULTS.sessionDays });
    this.progress = new Progress(this.db);
    this.limiter = new LoginLimiter();
    this.catalog = null;
    this.cfg = null;
    this.server = null;
    this.handler = null;
    this.timers = [];
    this.error = null;
    this.startedAt = null;
    this.compactor = new Compactor({ db: this.db, catalog: () => this.requireCatalog(), log });
    this.helperTokens = new Map(); // single-use tokens for the Windows helper -> expiry
  }

  /** Generates the Windows setup helper with a fresh single-use report token (2 h). */
  windowsHelper() {
    const raw = { ...DEFAULTS, ...(readRaw() || {}) };
    const now = Date.now();
    for (const [k, exp] of this.helperTokens) if (exp < now) this.helperTokens.delete(k);
    const token = randomToken(32);
    this.helperTokens.set(token, now + 2 * 3_600_000);
    const cert = raw.https ? certInfo(resolveFromRoot(raw.tlsCert)) : null;
    const vmIp = localIps().find((ip) => net.isIPv4(ip));
    return buildWindowsHelper({ vmIp, port: raw.port, https: !!raw.https, fingerprint: cert && cert.fingerprint, token });
  }

  /** Called by the helper: records the Windows PC's LAN IP, renews the cert, restarts. */
  hostReport(token, hostIp) {
    if (!net.isIPv4(hostIp) || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostIp)) {
      throw Object.assign(new Error('Expected a private IPv4 address'), { status: 400 });
    }
    let valid = false;
    for (const [k, exp] of this.helperTokens) {
      if (typeof token === 'string' && safeEqual(k, token) && exp >= Date.now()) { this.helperTokens.delete(k); valid = true; break; }
    }
    if (!valid) throw Object.assign(new Error('Invalid or expired helper token'), { status: 403 });
    const raw = { ...DEFAULTS, ...(readRaw() || {}) };
    const cur = readRaw() || {};
    writeRaw({ ...cur, publicHost: hostIp });
    if (raw.https) generateCert(resolveFromRoot(raw.tlsCert), resolveFromRoot(raw.tlsKey), [hostIp]);
    log.info(`Windows helper reported host PC address ${hostIp}; certificate renewed`);
    setTimeout(() => this.restart(), 500); // after the response is sent
    return { ok: true };
  }

  requireCatalog() {
    if (!this.catalog) throw new Error('Start the streaming server first');
    return this.catalog;
  }

  isConfigured() {
    const raw = readRaw();
    return !!(raw && /^scrypt\$/.test(raw.passwordHash || '') && Array.isArray(raw.mediaDirs) && raw.mediaDirs.length);
  }

  async start() {
    if (this.server) return;
    this.error = null;
    try {
      const cfg = loadConfig();
      media.checkFfmpeg();
      this.cfg = cfg;
      this.sessions.ttl = cfg.sessionDays * 86_400_000;
      this.catalog = new Catalog(this.db, cfg.mediaDirs, { probe: media.probe, log });
      this.catalog.rescan();
      this.handler = createApp({
        cfg, catalog: this.catalog, sessions: this.sessions, progress: this.progress, limiter: this.limiter, log,
        helper: { download: () => this.windowsHelper(), report: (t, ip) => this.hostReport(t, ip) },
      });
      const server = cfg.https
        ? https.createServer({ cert: fs.readFileSync(cfg.tlsCert), key: fs.readFileSync(cfg.tlsKey), minVersion: 'TLSv1.2' }, this.handler)
        : http.createServer(this.handler);
      server.headersTimeout = 15_000;
      server.requestTimeout = 30_000;
      server.keepAliveTimeout = 10_000;
      server.maxHeadersCount = 50;
      server.maxConnections = 200;
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(cfg.port, cfg.host, () => { server.off('error', reject); resolve(); });
      });
      server.on('error', (e) => log.error('server error:', e.message));
      this.server = server;
      this.startedAt = Date.now();
      this.timers.push(setInterval(() => this.catalog && this.catalog.rescan(), cfg.rescanMinutes * 60_000));
      this.timers.push(setInterval(() => this.sessions.purgeExpired(), 3_600_000));
      log.info(`streaming on ${cfg.https ? 'https' : 'http'}://${cfg.host}:${cfg.port}`);
      if (!cfg.https) log.warn('HTTPS is off: the password and cookies travel unencrypted on your network.');
    } catch (e) {
      this.error = e.code === 'EADDRINUSE' ? `Port ${this.cfg && this.cfg.port} is already in use by another program.` : e.message;
      log.error(`could not start streaming: ${this.error}`);
      this.server = null;
    }
  }

  async stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    if (this.server) {
      const s = this.server;
      this.server = null;
      await new Promise((r) => { s.close(r); s.closeAllConnections(); });
      log.info('streaming stopped');
    }
    this.startedAt = null;
  }

  async restart() {
    if (this.closed) return;
    await this.stop();
    await this.start();
  }

  status() {
    const lib = this.catalog;
    let movies = 0; let episodes = 0; let bytes = 0;
    if (lib) for (const it of lib.items.values()) { if (it.kind === 'movie') movies += 1; else episodes += 1; bytes += it.size; }
    return {
      configured: this.isConfigured(),
      running: !!this.server,
      error: this.error,
      startedAt: this.startedAt,
      library: lib ? { movies, episodes, shows: lib.shows.size, bytes } : null,
      activeStreams: this.handler ? this.handler.active.remux + this.handler.active.transcode : 0,
      transcodes: this.handler ? this.handler.active.transcode : 0,
    };
  }

  async close() {
    this.closed = true;
    this.compactor.cancel();
    await this.stop();
    this.db.close();
  }
}

module.exports = { Runtime, dataPath: (rt, f) => path.join(rt.dataDir, f) };
