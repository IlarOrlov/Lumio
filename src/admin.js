'use strict';
/*
 * Admin console. Listens on 127.0.0.1 only (never the LAN). Access requires
 * a single-use, 60-second key the desktop launcher fetches over an owner-only
 * unix socket (see adminkeys.js), exchanged for an HttpOnly, SameSite=Strict
 * session cookie.
 * Every POST additionally needs a CSRF header and a same-origin Origin.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readRaw, writeRaw, validateMediaDir, isValidHostName, resolveFromRoot, DEFAULTS } = require('./config');
const { hashPassword, safeEqual, randomToken } = require('./auth');
const { createNetworkGuard } = require('./netguard');
const { securityHeaders, parseCookies, sendJson, sendError, readJson, loadStatic } = require('./http-util');
const { generateCert, certInfo, localIps } = require('./tls');
const service = require('./service');
const log = require('./log');

const VIDEO_EXT = /\.(mkv|mp4|m4v|webm|mov)$/i;
const DEVICE_RE = /^[A-Za-z0-9_-]{16}$/;
const COOKIE = 'lumio_admin';

function createAdmin(runtime, { keys, port }) {
  const statics = loadStatic(path.join(__dirname, '..', 'admin'));
  const sessions = new Map(); // sid -> { csrf, exp }
  let failures = 0;
  let lockedUntil = 0;

  const rawCfg = () => ({ ...DEFAULTS, ...(readRaw() || {}) });
  const save = (patch) => {
    const cur = readRaw() || {};
    const next = { ...DEFAULTS, ...cur, ...patch };
    if (!cur.dataDir) delete next.dataDir;
    writeRaw(next);
    return next;
  };

  function session(req) {
    const sid = parseCookies(req.headers.cookie)[COOKIE];
    const s = sid && sessions.get(sid);
    if (!s || s.exp < Date.now()) return null;
    s.exp = Date.now() + 12 * 3_600_000;
    return s;
  }

  function hostOk(req) {
    return req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`;
  }
  function originOk(req) {
    const o = req.headers.origin;
    return o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
  }

  function publicConfig() {
    const c = rawCfg();
    const certPath = resolveFromRoot(c.tlsCert);
    const cert = certInfo(certPath);
    const urlHost = c.publicHost || localIps()[0] || '127.0.0.1';
    return {
      port: c.port, https: c.https, publicHost: c.publicHost, mediaDirs: c.mediaDirs,
      allowedNetworks: c.allowedNetworks, allowedHosts: c.allowedHosts, sessionDays: c.sessionDays,
      maxTranscodes: c.maxTranscodes, rescanMinutes: c.rescanMinutes,
      hasPassword: /^scrypt\$/.test(c.passwordHash || ''),
      vmIps: localIps(),
      url: `${c.https ? 'https' : 'http'}://${urlHost}:${c.port}`,
      cert: cert ? { ...cert, coversPublicHost: !c.publicHost || cert.sans.includes(c.publicHost) } : null,
    };
  }

  function validatePatch(b) {
    const patch = {};
    if (b.mediaDirs !== undefined) {
      if (!Array.isArray(b.mediaDirs) || b.mediaDirs.length > 32) throw new Error('Invalid media folders');
      patch.mediaDirs = [...new Set(b.mediaDirs.map(validateMediaDir))];
    }
    if (b.port !== undefined) {
      const p = Number(b.port);
      if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error('Port must be 1024-65535');
      if (p === port) throw new Error(`Port ${p} is used by the admin console`);
      patch.port = p;
    }
    if (b.https !== undefined) patch.https = !!b.https;
    if (b.publicHost !== undefined) {
      const h = String(b.publicHost).trim().toLowerCase();
      if (h && !isValidHostName(h)) throw new Error('Host PC address must be an IP address or hostname');
      patch.publicHost = h;
    }
    if (b.allowedNetworks !== undefined) {
      if (!Array.isArray(b.allowedNetworks) || !b.allowedNetworks.length) throw new Error('Keep at least one allowed network');
      const list = b.allowedNetworks.map((s) => String(s).trim()).filter(Boolean);
      createNetworkGuard(list); // throws on invalid CIDR
      if (list.some((c) => /^0\.0\.0\.0\/0$|^::\/0$/.test(c))) throw new Error('Allowing the whole internet is not permitted');
      patch.allowedNetworks = list;
    }
    if (b.allowedHosts !== undefined) {
      const list = (Array.isArray(b.allowedHosts) ? b.allowedHosts : []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
      if (list.some((h) => !isValidHostName(h))) throw new Error('Invalid hostname in allowed hosts');
      patch.allowedHosts = list;
    }
    const ints = { sessionDays: [1, 3650], maxTranscodes: [1, 16], rescanMinutes: [1, 1440] };
    for (const [k, [lo, hi]] of Object.entries(ints)) {
      if (b[k] === undefined) continue;
      const n = Number(b[k]);
      if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${k} must be between ${lo} and ${hi}`);
      patch[k] = n;
    }
    return patch;
  }

  function regenerateCert() {
    const c = rawCfg();
    generateCert(resolveFromRoot(c.tlsCert), resolveFromRoot(c.tlsKey), [c.publicHost]);
    log.info('new TLS certificate generated');
  }

  function listDir(p) {
    const real = fs.realpathSync(path.resolve(p || os.homedir()));
    const entries = fs.readdirSync(real, { withFileTypes: true });
    const dirs = [];
    let videos = 0;
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) dirs.push(e.name);
      else if (VIDEO_EXT.test(e.name)) videos += 1;
    }
    dirs.sort((a, b) => a.localeCompare(b));
    return { path: real, parent: real === '/' ? null : path.dirname(real), dirs, videos, home: os.homedir() };
  }

  async function route(req, res, url) {
    const p = url.pathname;
    const m = req.method;

    if (m === 'GET' && statics.has(p === '/' ? '/index.html' : p)) {
      const f = statics.get(p === '/' ? '/index.html' : p);
      res.writeHead(200, { 'Content-Type': f.type, 'Content-Length': f.body.length, 'Cache-Control': 'no-cache' });
      return res.end(f.body);
    }

    if (m === 'POST' && p === '/api/auth') {
      if (Date.now() < lockedUntil) return sendError(res, 429, 'Too many attempts, wait a minute');
      const b = await readJson(req, 1024);
      if (!keys.consume(b.token)) {
        if (++failures >= 10) { lockedUntil = Date.now() + 60_000; failures = 0; }
        return sendError(res, 401, 'This admin link was already used or has expired. Open the console with the Lumio desktop icon.');
      }
      failures = 0;
      const sid = randomToken(32);
      const csrf = randomToken(24);
      sessions.set(sid, { csrf, exp: Date.now() + 12 * 3_600_000 });
      res.setHeader('Set-Cookie', `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`);
      return sendJson(res, 200, { csrf });
    }

    const s = session(req);
    if (!s) return sendError(res, 401, 'Admin session required');
    if (m === 'GET' && p === '/api/session') return sendJson(res, 200, { csrf: s.csrf });
    if (m === 'POST') {
      const h = req.headers['x-lumio-csrf'];
      if (typeof h !== 'string' || !safeEqual(h, s.csrf)) return sendError(res, 403, 'Invalid CSRF token');
    }

    // ----- status & config -----
    if (m === 'GET' && p === '/api/status') {
      return sendJson(res, 200, { ...runtime.status(), config: publicConfig(), autostart: await service.autostartStatus(), compact: runtime.compactor.status() });
    }
    if (m === 'POST' && p === '/api/config') {
      const patch = validatePatch(await readJson(req));
      const before = rawCfg();
      save(patch);
      const c = rawCfg();
      if (c.https && (!certInfo(resolveFromRoot(c.tlsCert)) || (patch.publicHost !== undefined && patch.publicHost !== before.publicHost))) {
        regenerateCert();
      }
      if (runtime.isConfigured()) await runtime.restart();
      return sendJson(res, 200, { ok: true, error: runtime.error });
    }
    if (m === 'POST' && p === '/api/password') {
      const b = await readJson(req, 2048);
      const pw = typeof b.password === 'string' ? b.password : '';
      if (pw.length < 12 || pw.length > 256) return sendError(res, 400, 'Password must be 12-256 characters');
      save({ passwordHash: await hashPassword(pw) });
      if (b.signOutAll) runtime.sessions.endAllSessions();
      log.info(`household password changed${b.signOutAll ? '; all devices signed out' : ''}`);
      if (runtime.isConfigured()) await runtime.restart();
      return sendJson(res, 200, { ok: true, error: runtime.error });
    }
    if (m === 'POST' && p === '/api/cert') {
      regenerateCert();
      await runtime.restart();
      return sendJson(res, 200, { ok: true, error: runtime.error });
    }
    if (m === 'GET' && p === '/api/cert.pem') {
      const pem = fs.readFileSync(resolveFromRoot(rawCfg().tlsCert));
      res.writeHead(200, { 'Content-Type': 'application/x-pem-file', 'Content-Disposition': 'attachment; filename="lumio.crt"' });
      return res.end(pem);
    }
    if (m === 'GET' && p === '/api/windows-helper') {
      const body = Buffer.from(runtime.windowsHelper({ autoApply: true }));
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="Lumio-Windows-Setup.cmd"', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
      return res.end(body);
    }
    if (m === 'POST' && (p === '/api/host/apply' || p === '/api/host/dismiss')) {
      const pending = runtime.pendingHost;
      if (!pending) return sendError(res, 404, 'Nothing pending');
      if (p.endsWith('apply')) runtime.applyHost(pending.ip); else runtime.pendingHost = null;
      return sendJson(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/server') {
      const b = await readJson(req);
      if (b.action === 'start') await runtime.start();
      else if (b.action === 'stop') await runtime.stop();
      else if (b.action === 'restart') await runtime.restart();
      else if (b.action === 'quit') { sendJson(res, 200, { ok: true }); return service.shutdown(); }
      else return sendError(res, 400, 'Unknown action');
      return sendJson(res, 200, { ok: true, error: runtime.error });
    }
    if (m === 'POST' && p === '/api/autostart') {
      const b = await readJson(req);
      return sendJson(res, 200, await service.setAutostart(!!b.enabled));
    }
    if (m === 'GET' && p === '/api/logs') {
      return sendJson(res, 200, { lines: log.recent(Number(url.searchParams.get('since')) || 0) });
    }
    if (m === 'GET' && p === '/api/fs') {
      try { return sendJson(res, 200, listDir(url.searchParams.get('path'))); } catch (e) { return sendError(res, 400, 'Cannot open that folder'); }
    }

    // ----- library -----
    if (m === 'POST' && p === '/api/rescan') {
      runtime.requireCatalog().rescan();
      return sendJson(res, 200, runtime.status().library);
    }
    if (m === 'GET' && p === '/api/library') {
      const cat = runtime.requireCatalog();
      const movies = []; const shows = [];
      for (const it of cat.items.values()) if (it.kind === 'movie') movies.push({ title: it.title, year: it.year, size: it.size, file: path.basename(it.path) });
      for (const sh of cat.shows.values()) shows.push({ name: sh.name, episodes: sh.episodes.length, seasons: new Set(sh.episodes.map((e) => e.season)).size, size: sh.episodes.reduce((a, e) => a + e.size, 0) });
      movies.sort((a, b) => a.title.localeCompare(b.title));
      shows.sort((a, b) => a.name.localeCompare(b.name));
      return sendJson(res, 200, { movies, shows });
    }

    // ----- devices -----
    if (m === 'GET' && p === '/api/devices') {
      const cat = runtime.catalog;
      return sendJson(res, 200, runtime.sessions.listDevices().map((d) => {
        const rows = runtime.progress.rows(d.id);
        return {
          id: d.id, name: d.name, createdAt: d.created_at, lastSeen: d.last_seen,
          watched: rows.filter((r) => r.completed).length,
          history: rows.slice(0, 30).map((r) => {
            const it = cat && cat.get(r.id);
            return {
              title: it ? (it.kind === 'episode' ? `${it.show} S${String(it.season).padStart(2, '0')}E${String(it.episode).padStart(2, '0')}` : it.title) : '(file removed)',
              position: r.position, duration: r.duration, completed: r.completed, updatedAt: r.updatedAt,
            };
          }),
        };
      }));
    }
    if (m === 'POST' && (p === '/api/devices/rename' || p === '/api/devices/revoke')) {
      const b = await readJson(req);
      if (!DEVICE_RE.test(String(b.id))) return sendError(res, 400, 'Invalid device');
      if (p.endsWith('revoke')) return sendJson(res, 200, { ok: runtime.sessions.revokeDevice(b.id) });
      const name = String(b.name || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 40);
      if (!name) return sendError(res, 400, 'Invalid name');
      return sendJson(res, 200, { ok: runtime.sessions.renameDevice(b.id, name) });
    }

    // ----- storage compaction -----
    if (m === 'POST' && p === '/api/compact/analyze') {
      runtime.requireCatalog();
      const b = await readJson(req);
      const minMb = Math.max(0, Number.isFinite(Number(b.minMb)) ? Number(b.minMb) : 50);
      runtime.compactor.analyze(minMb * 1024 * 1024, [40, 48, 64].includes(Number(b.audioKbps)) ? Number(b.audioKbps) : 48).catch((e) => { runtime.compactor.state.phase = 'idle'; runtime.compactor.state.error = e.message; });
      return sendJson(res, 202, { ok: true });
    }
    if (m === 'POST' && p === '/api/compact/start') {
      const b = await readJson(req, 64 * 1024);
      const opts = {
        ids: Array.isArray(b.ids) ? b.ids.filter((x) => /^[0-9a-f]{20}$/.test(x)) : [],
        crf: b.crf, preset: b.preset, audioKbps: b.audioKbps,
        audioLangs: String(b.audioLangs || '').split(',').map((x) => x.trim()).filter((x) => /^[a-z]{2,3}$/i.test(x)),
        mode: b.mode === 'copy' ? 'copy' : 'replace',
        outDir: b.mode === 'copy' ? validateMediaDir(String(b.outDir || '')) : null,
      };
      if (runtime.compactor.state.phase === 'encoding') return sendError(res, 409, 'Already running');
      runtime.compactor.run(opts).catch((e) => { runtime.compactor.state.phase = 'done'; runtime.compactor.state.error = e.message; });
      return sendJson(res, 202, { ok: true });
    }
    if (m === 'POST' && p === '/api/compact/cancel') {
      runtime.compactor.cancel();
      return sendJson(res, 200, { ok: true });
    }

    return sendError(res, 404, 'Not found');
  }

  return async function adminHandler(req, res) {
    securityHeaders(res, { https: false });
    try {
      const remote = req.socket.remoteAddress;
      if (!(remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1')) { res.writeHead(403); return res.end(); }
      if (!hostOk(req)) return sendError(res, 421, 'Unknown host');
      if (!['GET', 'POST'].includes(req.method)) return sendError(res, 405, 'Method not allowed');
      if (req.method === 'POST' && !originOk(req)) return sendError(res, 403, 'Cross-origin request refused');
      const url = new URL(req.url, 'http://admin.invalid');
      await route(req, res, url);
    } catch (e) {
      if (e && e.status) return sendError(res, e.status, e.message);
      return sendError(res, 400, (e && e.message) || 'Error');
    }
  };
}

module.exports = { createAdmin };
