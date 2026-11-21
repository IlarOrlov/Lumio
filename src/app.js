'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { verifyPassword, safeEqual } = require('./auth');
const { createNetworkGuard, createHostGuard } = require('./netguard');
const {
  securityHeaders, parseCookies, sendJson, sendError, readJson, readForm, loadStatic, sendFileRange, MIME,
} = require('./http-util');
const media = require('./media');
const { caPaths } = require('./tls');
const { legacyCss } = require('./legacycss');

const ID_RE = /^[0-9a-f]{20}$/;
const SHOW_RE = /^[0-9a-f]{16}$/;
const DEVICE_RE = /^[A-Za-z0-9_-]{16}$/;
const ADMIN_ONLY = new Set(['/api/devices', '/api/devices/rename', '/api/devices/revoke', '/api/rescan', '/api/windows-helper']);

function cleanName(v) {
  // Device names are shown in the UI; strip control chars and cap the length.
  return String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 40);
}

function num(v, { min = 0, max = 1e7 } = {}) {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function createApp({ cfg, catalog, sessions, progress, limiter, log = console, helper = null, intros = null }) {
  const isAllowedIp = createNetworkGuard(cfg.allowedNetworks);
  const isAllowedHost = createHostGuard(cfg.allowedHosts);
  const statics = loadStatic(path.join(__dirname, '..', 'public'));
  if (statics.has('/style.css')) {
    const body = Buffer.from(legacyCss(statics.get('/style.css').body.toString('utf8')));
    statics.set('/style.legacy.css', { body, type: statics.get('/style.css').type });
  }
  const thumbsDir = path.join(cfg.dataDir, 'thumbs');
  const cookieName = cfg.https ? '__Host-lumio' : 'lumio';
  const active = { transcode: 0, remux: 0 };
  let diagTimes = [];

  function setSessionCookie(res, token, maxAgeSec) {
    const attrs = [`${cookieName}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
    if (cfg.https) attrs.push('Secure');
    res.setHeader('Set-Cookie', attrs.join('; '));
  }

  function originOk(req) {
    const origin = req.headers.origin;
    if (origin === undefined) {
      const site = req.headers['sec-fetch-site'];
      return site === undefined || site === 'same-origin' || site === 'none';
    }
    const scheme = cfg.https ? 'https' : 'http';
    return origin === `${scheme}://${req.headers.host}`;
  }

  function auth(req) {
    const token = parseCookies(req.headers.cookie)[cookieName];
    return token ? sessions.lookup(token) : null;
  }

  // ---------- handlers ----------

  /** Checks the household password and creates the device session. */
  async function signIn(req, res, password, deviceName) {
    const wait = limiter.retryAfterMs();
    if (wait > 0) {
      res.setHeader('Retry-After', Math.ceil(wait / 1000));
      return { status: 429, error: `Too many failed attempts. Try again in ${Math.ceil(wait / 60000)} min.` };
    }
    password = typeof password === 'string' ? password.slice(0, 256) : '';
    const ok = password.length > 0 && await verifyPassword(password, cfg.passwordHash);
    if (!ok) {
      limiter.recordFailure();
      log.warn?.(`[lumio] failed login from ${req.socket.remoteAddress}`);
      return { status: 401, error: 'Wrong password' };
    }
    limiter.recordSuccess();
    const name = cleanName(deviceName) || 'Unnamed device';
    const { token, deviceId } = sessions.createDeviceSession(name, req.headers['user-agent']);
    setSessionCookie(res, token, cfg.sessionDays * 86400);
    log.info?.(`[lumio] new device signed in: "${name}"`);
    return { status: 200, deviceId };
  }

  async function login(req, res) {
    const body = await readJson(req, 2048);
    const r = await signIn(req, res, body.password, body.deviceName);
    return r.status === 200 ? sendJson(res, 200, { ok: true, deviceId: r.deviceId }) : sendError(res, r.status, r.error);
  }

  /** Plain HTML form post (browsers where the sign-in script can't run, e.g. older TVs). */
  async function formLogin(req, res) {
    const form = await readForm(req, 2048);
    const r = await signIn(req, res, form.get('password'), form.get('device'));
    const to = r.status === 200 ? '/' : `/login?e=${r.status === 429 ? 'locked' : 'wrong'}`;
    res.writeHead(303, { Location: to, 'Cache-Control': 'no-store' });
    return res.end();
  }

  function libraryView() {
    const movies = [];
    for (const it of catalog.items.values()) if (it.kind === 'movie') movies.push(catalog.summary(it));
    movies.sort((a, b) => a.title.localeCompare(b.title));
    const shows = [...catalog.shows.values()].map((s) => catalog.showSummary(s))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { movies, shows };
  }

  async function mediaDetails(item, caps) {
    const info = await catalog.probe(item);
    const nxt = catalog.next(item);
    const subtitles = [
      ...info.subtitles.filter((s) => s.text).map((s) => ({
        key: `e${s.index}`, label: s.title || s.language || `Track ${s.index + 1}`, language: s.language,
      })),
      ...item.sidecarSubs.map((s, i) => ({ key: `x${i}`, label: s.label, language: s.label })),
    ];
    return {
      ...catalog.summary(item),
      duration: info.duration,
      plan: media.playbackPlan(item, info, 0, caps).mode,
      audio: info.audio.map((a) => ({
        index: a.index, label: [a.title || a.language || `Track ${a.index + 1}`, a.channels > 2 ? `${a.channels}ch` : ''].filter(Boolean).join(' · '),
        default: a.default,
      })),
      subtitles,
      next: nxt ? catalog.summary(nxt) : null,
      intros: item.kind === 'episode' && intros ? ((intros.get(item.id) || {}).segments || []) : [],
    };
  }

  async function play(req, res, item, url) {
    const info = await catalog.probe(item);
    const audioIndex = Math.min(num(url.searchParams.get('audio'), { max: 64 }) ?? 0, Math.max(0, info.audio.length - 1));
    const plan = media.playbackPlan(item, info, audioIndex, media.parseCaps(url.searchParams.get('caps')));
    if (plan.mode === 'direct') {
      return sendFileRange(req, res, item.path, item.size, MIME[item.ext] || 'application/octet-stream');
    }
    const kind = plan.mode === 'transcode' ? 'transcode' : 'remux';
    const limit = kind === 'transcode' ? cfg.maxTranscodes : cfg.maxTranscodes * 3;
    if (active[kind] >= limit) return sendError(res, 503, 'Server is busy, try again shortly');
    const start = num(url.searchParams.get('t'), { max: info.duration + 1 }) ?? 0;

    active[kind] += 1;
    const child = media.spawnStream(item.path, {
      start, videoMode: plan.videoMode, codec: plan.codec, audioIndex, hasAudio: info.audio.length > 0,
    });
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active[kind] -= 1;
      if (child.exitCode === null) child.kill('SIGKILL');
    };
    res.on('close', release);
    child.on('close', release);
    child.on('error', () => { release(); sendError(res, 500, 'Streaming failed'); });
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
    child.stdout.pipe(res);
  }

  function subtitles(req, res, item, key, url) {
    const info = catalog.cachedProbe(item);
    if (!info) return sendError(res, 404, 'Not ready');
    const start = num(url.searchParams.get('t'), { max: info.duration + 1 }) ?? 0;
    let child;
    const m = /^([ex])(\d{1,3})$/.exec(key);
    if (!m) return sendError(res, 404, 'Not found');
    const idx = Number(m[2]);
    if (m[1] === 'e') {
      const s = info.subtitles.find((x) => x.index === idx && x.text);
      if (!s) return sendError(res, 404, 'Not found');
      child = media.spawnSubtitles(item.path, { start, embeddedIndex: idx });
    } else {
      const s = item.sidecarSubs[idx];
      if (!s) return sendError(res, 404, 'Not found');
      child = media.spawnSubtitles(s.path, { start });
    }
    res.on('close', () => { if (child.exitCode === null) child.kill('SIGKILL'); });
    child.on('error', () => sendError(res, 500, 'Subtitle extraction failed'));
    res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store' });
    child.stdout.pipe(res);
  }

  async function thumb(req, res, item) {
    let file = item.poster;
    if (!file) {
      const info = catalog.cachedProbe(item) || await catalog.probe(item);
      file = await media.thumbnail(item, info.duration, thumbsDir);
    }
    const st = fs.statSync(file);
    res.writeHead(200, {
      'Content-Type': file.endsWith('.png') ? 'image/png' : 'image/jpeg',
      'Content-Length': st.size, 'Cache-Control': 'private, max-age=86400',
    });
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }

  // ---------- router ----------

  async function route(req, res, url, session) {
    const p = url.pathname;
    const m = req.method;

    if (m === 'POST' && p === '/api/login') return login(req, res);
    if (m === 'POST' && p === '/login') return formLogin(req, res);
    if (m === 'POST' && p === '/api/diag') {
      // Browser-side startup errors, so problems on TVs can be diagnosed without dev tools.
      // Logged only while request logging is on; rate limited, size capped, control chars stripped.
      const body = await readJson(req, 2048);
      const now = Date.now();
      diagTimes = diagTimes.filter((t) => now - t < 60_000);
      if (cfg.logRequests && diagTimes.length < 30) {
        diagTimes.push(now);
        const clean = (v, n) => String(v || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n);
        log.warn?.(`[client] ${req.socket.remoteAddress} ${clean(body.page, 40)}: ${clean(body.msg, 800)}`);
      }
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (m === 'POST' && p === '/api/host-report' && helper) {
      // Windows helper callback: authorised by its single-use token, not a cookie.
      const body = await readJson(req, 1024);
      return sendJson(res, 200, helper.report(body.token, String(body.hostIp || '')));
    }
    if (m === 'GET' && p === '/lumio.crt' && cfg.https) {
      // The home CA certificate (public, not secret). Installing it once on a
      // device makes the browser verify Lumio properly, with no warning.
      const pem = fs.readFileSync(caPaths(cfg.tlsCert).cert);
      res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="Lumio-home-CA.crt"', 'Content-Length': pem.length, 'Cache-Control': 'no-store' });
      return res.end(pem);
    }
    // Credentials never belong in a URL. If a browser ever sends the sign-in form
    // as a GET (old cached page, broken script), refuse to render it with the
    // query and bounce to a clean address; nothing in the query is ever read.
    if ((m === 'GET' || m === 'HEAD') && p === '/login' && url.search && !/^\?e=(wrong|locked)$/.test(url.search)) {
      res.writeHead(303, { Location: '/login', 'Cache-Control': 'no-store' });
      return res.end();
    }
    if ((m === 'GET' || m === 'HEAD') && statics.has(p === '/' ? '/index.html' : p === '/login' ? '/login.html' : p)) {
      const f = statics.get(p === '/' ? '/index.html' : p === '/login' ? '/login.html' : p);
      // Pages are never stored (a TV must not keep showing an outdated sign-in form).
      const cache = f.type.startsWith('text/html') ? 'no-store' : 'no-cache';
      res.writeHead(200, { 'Content-Type': f.type, 'Content-Length': f.body.length, 'Cache-Control': cache });
      return res.end(m === 'HEAD' ? undefined : f.body);
    }

    if (!session) return sendError(res, 401, 'Sign in required');

    if (m === 'POST') {
      const csrf = req.headers['x-lumio-csrf'];
      if (typeof csrf !== 'string' || !safeEqual(csrf, session.csrf)) return sendError(res, 403, 'Invalid CSRF token');
    }

    if (m === 'GET' && p === '/api/me') {
      return sendJson(res, 200, { deviceId: session.deviceId, deviceName: session.deviceName, csrf: session.csrf, isAdmin: session.isAdmin });
    }
    // Settings (device management, rescans, the Windows helper) are for admin
    // devices only. Adminship is granted in the admin console on the Lumio computer.
    if (ADMIN_ONLY.has(p) && !session.isAdmin) {
      return sendError(res, 403, 'Only admin devices can change settings. Ask the owner to make this device an admin in the Lumio admin console.');
    }
    if (m === 'POST' && p === '/api/logout') {
      sessions.destroy(session.tokenHash);
      setSessionCookie(res, '', 0);
      return sendJson(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/api/library') return sendJson(res, 200, libraryView());
    if (m === 'GET' && p === '/api/progress') {
      return sendJson(res, 200, {
        items: progress.rows(session.deviceId).filter((r) => catalog.get(r.id)),
        continue: progress.continueWatching(session.deviceId, catalog).map((c) => ({ ...c, item: catalog.summary(catalog.get(c.id)) })),
      });
    }
    if (m === 'POST' && p === '/api/progress') {
      const body = await readJson(req);
      const item = catalog.get(body.id);
      const position = num(body.position);
      const duration = num(body.duration);
      if (!item || position === null || duration === null) return sendError(res, 400, 'Invalid progress');
      return sendJson(res, 200, progress.save(session.deviceId, item.id, Math.min(position, duration || position), duration));
    }
    if (m === 'POST' && (p === '/api/progress/watched' || p === '/api/progress/clear')) {
      const body = await readJson(req);
      const item = catalog.get(body.id);
      if (!item) return sendError(res, 404, 'Not found');
      if (p.endsWith('watched')) progress.markWatched(session.deviceId, item.id, catalog.cachedProbe(item)?.duration);
      else progress.clear(session.deviceId, item.id);
      return sendJson(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/api/devices') {
      return sendJson(res, 200, {
        current: session.deviceId,
        devices: sessions.listDevices().map((d) => ({ id: d.id, name: d.name, createdAt: d.created_at, lastSeen: d.last_seen, isAdmin: d.is_admin === 1 })),
      });
    }
    if (m === 'POST' && p === '/api/devices/rename') {
      const body = await readJson(req);
      const id = body.id === undefined ? session.deviceId : body.id;
      const name = cleanName(body.name);
      if (!DEVICE_RE.test(String(id)) || !name) return sendError(res, 400, 'Invalid name');
      return sendJson(res, sessions.renameDevice(id, name) ? 200 : 404, { ok: true });
    }
    if (m === 'POST' && p === '/api/devices/revoke') {
      const body = await readJson(req);
      if (!DEVICE_RE.test(String(body.id))) return sendError(res, 400, 'Invalid device');
      const target = sessions.listDevices().find((d) => d.id === body.id);
      if (target && target.is_admin === 1 && body.id !== session.deviceId) {
        return sendError(res, 403, 'Admin devices can only be removed in the Lumio admin console.');
      }
      const ok = sessions.revokeDevice(body.id);
      if (body.id === session.deviceId) setSessionCookie(res, '', 0);
      return sendJson(res, ok ? 200 : 404, { ok });
    }
    if (m === 'GET' && p === '/api/windows-helper' && helper) {
      const body = Buffer.from(helper.download());
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="Lumio-Windows-Setup.cmd"',
        'Content-Length': body.length, 'Cache-Control': 'no-store',
      });
      return res.end(body);
    }
    if (m === 'POST' && p === '/api/rescan') {
      catalog.rescan();
      return sendJson(res, 200, { ok: true, count: catalog.items.size });
    }

    let r;
    if (m === 'GET' && (r = /^\/api\/shows\/([0-9a-f]+)$/.exec(p)) && SHOW_RE.test(r[1])) {
      const show = catalog.shows.get(r[1]);
      if (!show) return sendError(res, 404, 'Not found');
      return sendJson(res, 200, { ...catalog.showSummary(show), episodes: show.episodes.map((e) => catalog.summary(e)) });
    }
    if ((r = /^\/(api\/)?media\/([0-9a-f]+)\/?(.*)$/.exec(p)) && ID_RE.test(r[2])) {
      const item = catalog.get(r[2]);
      if (!item) return sendError(res, 404, 'Not found');
      const sub = r[3];
      if (r[1]) {
        if (m === 'GET' && sub === '') return sendJson(res, 200, await mediaDetails(item, media.parseCaps(url.searchParams.get('caps'))));
        if (m === 'GET' && sub === 'seek') {
          const info = await catalog.probe(item);
          const t = num(url.searchParams.get('t'), { max: info.duration + 1 }) ?? 0;
          const audio = num(url.searchParams.get('audio'), { max: 64 }) ?? 0;
          const plan = media.playbackPlan(item, info, audio, media.parseCaps(url.searchParams.get('caps')));
          const start = plan.mode === 'remux' ? await media.keyframeBefore(item.path, t) : t;
          return sendJson(res, 200, { start, mode: plan.mode });
        }
      } else if (m === 'GET' || m === 'HEAD') {
        if (sub === 'play') return play(req, res, item, url);
        if (sub === 'thumb') return thumb(req, res, item);
        const s = /^subs\/([ex]\d{1,3})\.vtt$/.exec(sub);
        if (s) return subtitles(req, res, item, s[1], url);
      }
    }
    return sendError(res, 404, 'Not found');
  }

  handler.active = active;
  return handler;

  async function handler(req, res) {
    // HTTP/2 carries the host as ":authority"; the rest of Lumio reads req.headers.host.
    if (req.headers.host === undefined && typeof req.headers[':authority'] === 'string') req.headers.host = req.headers[':authority'];
    securityHeaders(res, cfg);
    if (cfg.logRequests) {
      // Diagnostics (off by default): path only, never the query string or body.
      const remote = req.socket && req.socket.remoteAddress;
      res.on('finish', () => {
        const path = String(req.url || '').split('?')[0].slice(0, 120);
        log.info?.(`[req] ${req.method} ${path} ${res.statusCode} ${remote} h${req.httpVersion} origin=${req.headers.origin || '-'} ua=${String(req.headers['user-agent'] || '').slice(0, 140)}`);
      });
    }
    try {
      if (!isAllowedIp(req.socket.remoteAddress)) {
        log.warn?.(`[lumio] blocked request from ${req.socket.remoteAddress}`);
        res.writeHead(403); return res.end();
      }
      if (!isAllowedHost(req.headers.host)) return sendError(res, 421, 'Unknown host');
      if (!['GET', 'HEAD', 'POST'].includes(req.method)) {
        res.setHeader('Allow', 'GET, HEAD, POST');
        return sendError(res, 405, 'Method not allowed');
      }
      if (req.method === 'POST' && !originOk(req)) return sendError(res, 403, 'Cross-origin request refused');
      if (req.url.length > 2048) return sendError(res, 414, 'URI too long');
      const url = new URL(req.url, 'http://lumio.invalid');
      await route(req, res, url, auth(req));
    } catch (e) {
      if (e && e.status) return sendError(res, e.status, e.message);
      log.error?.('[lumio] request error:', e && e.message);
      return sendError(res, 500, 'Internal error');
    }
  }
}

module.exports = { createApp };
