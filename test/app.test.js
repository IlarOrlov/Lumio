'use strict';
// End-to-end HTTP tests of the request pipeline (auth, CSRF, guards, routing).
// ffprobe is replaced with a stub so these run without ffmpeg installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { openDb } = require('../src/db');
const { Sessions, LoginLimiter, hashPassword } = require('../src/auth');
const { Catalog } = require('../src/catalog');
const { Progress } = require('../src/progress');
const { createApp } = require('../src/app');

const PASSWORD = 'a very long household password';

async function setup({ allowedNetworks = ['127.0.0.0/8', '::1/128'] } = {}) {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-app-'));
  fs.writeFileSync(path.join(lib, 'Movie (2001).mp4'), Buffer.alloc(1000, 7));
  fs.writeFileSync(path.join(lib, 'Show S01E01.mkv'), 'x');
  const db = openDb(':memory:');
  const catalog = new Catalog(db, [lib], {
    probe: async () => ({ v: 2, duration: 100, container: 'mp4', video: { codec: 'h264', profile: 'High', pixFmt: 'yuv420p', width: 1920, height: 1080 }, audio: [{ index: 0, codec: 'aac', channels: 2, bitRate: 128000 }], subtitles: [] }),
    log: {},
  });
  catalog.rescan();
  await catalog.probeAllInBackground();
  const cfg = {
    https: false, allowedNetworks, allowedHosts: [], sessionDays: 30, maxTranscodes: 1,
    passwordHash: await hashPassword(PASSWORD), dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-data-')),
  };
  const handler = createApp({
    cfg, catalog, sessions: new Sessions(db), progress: new Progress(db),
    limiter: new LoginLimiter({ maxPerWindow: 3 }), log: {},
  });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, catalog };
}

async function req(base, p, { method = 'GET', body, cookie, csrf, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.Cookie = cookie;
  if (csrf) h['X-Lumio-CSRF'] = csrf;
  if (body !== undefined) { h['Content-Type'] = h['Content-Type'] || 'application/json'; h.Origin = h.Origin || base; }
  const r = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, headers: r.headers, json, text };
}

async function login(base, deviceName = 'Test <TV>') {
  const r = await req(base, '/api/login', { method: 'POST', body: { password: PASSWORD, deviceName } });
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const me = await req(base, '/api/me', { cookie });
  return { cookie, csrf: me.json.csrf, me: me.json };
}

test('security headers are present on every response', async (t) => {
  const { server, base } = await setup();
  t.after(() => server.close());
  const r = await req(base, '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'.*script-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
});

test('API requires a session', async (t) => {
  const { server, base } = await setup();
  t.after(() => server.close());
  for (const p of ['/api/library', '/api/progress', '/api/devices']) {
    assert.equal((await req(base, p)).status, 401, p);
  }
});

test('login: wrong password fails, lockout kicks in, cookie is hardened', async (t) => {
  const { server, base } = await setup();
  t.after(() => server.close());
  const ok = await req(base, '/api/login', { method: 'POST', body: { password: PASSWORD, deviceName: 'X' } });
  const sc = ok.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/);
  for (let i = 0; i < 3; i++) {
    assert.equal((await req(base, '/api/login', { method: 'POST', body: { password: 'nope', deviceName: 'X' } })).status, 401);
  }
  const locked = await req(base, '/api/login', { method: 'POST', body: { password: PASSWORD, deviceName: 'X' } });
  assert.equal(locked.status, 429, 'even the right password is refused while locked');
});

test('login requires JSON and same origin', async (t) => {
  const { server, base } = await setup();
  t.after(() => server.close());
  const form = await req(base, '/api/login', { method: 'POST', body: { password: PASSWORD }, headers: { 'Content-Type': 'text/plain' } });
  assert.equal(form.status, 415);
  const cross = await req(base, '/api/login', { method: 'POST', body: { password: PASSWORD }, headers: { Origin: 'http://evil.example' } });
  assert.equal(cross.status, 403);
});

test('CSRF token is required for state-changing requests', async (t) => {
  const { server, base, catalog } = await setup();
  t.after(() => server.close());
  const { cookie, csrf } = await login(base);
  const id = [...catalog.items.keys()][0];
  assert.equal((await req(base, '/api/progress', { method: 'POST', cookie, body: { id, position: 10, duration: 100 } })).status, 403);
  assert.equal((await req(base, '/api/progress', { method: 'POST', cookie, csrf: 'wrong', body: { id, position: 10, duration: 100 } })).status, 403);
  assert.equal((await req(base, '/api/progress', { method: 'POST', cookie, csrf, body: { id, position: 10, duration: 100 } })).status, 200);
});

test('progress is tracked per device and drives Continue watching', async (t) => {
  const { server, base, catalog } = await setup();
  t.after(() => server.close());
  const a = await login(base);
  const b = await login(base, 'Phone');
  assert.equal(a.me.deviceName, 'Test TV', 'device name is sanitised');
  const movie = [...catalog.items.values()].find((i) => i.kind === 'movie');
  await req(base, '/api/progress', { method: 'POST', cookie: a.cookie, csrf: a.csrf, body: { id: movie.id, position: 40, duration: 100 } });
  const pa = await req(base, '/api/progress', { cookie: a.cookie });
  const pb = await req(base, '/api/progress', { cookie: b.cookie });
  assert.equal(pa.json.continue[0].id, movie.id);
  assert.equal(pa.json.continue[0].position, 40);
  assert.equal(pa.json.continue[0].item.path, undefined, 'filesystem paths never leak');
  assert.equal(pb.json.continue.length, 0);
});

test('media ids are validated; no path traversal', async (t) => {
  const { server, base } = await setup();
  t.after(() => server.close());
  const { cookie } = await login(base);
  for (const p of ['/media/../../etc/passwd/play', '/media/%2e%2e%2fetc/play', '/media/0123456789abcdef0123/play', '/style.css/../../src/app.js', '/../config/lumio.json']) {
    const r = await req(base, p, { cookie });
    assert.ok([404].includes(r.status), `${p} -> ${r.status}`);
  }
});

test('direct play supports range requests', async (t) => {
  const { server, base, catalog } = await setup();
  t.after(() => server.close());
  const { cookie } = await login(base);
  const movie = [...catalog.items.values()].find((i) => i.kind === 'movie');
  const r = await fetch(`${base}/media/${movie.id}/play`, { headers: { Cookie: cookie, Range: 'bytes=10-19' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 10-19/1000');
  assert.equal((await r.arrayBuffer()).byteLength, 10);
  const bad = await fetch(`${base}/media/${movie.id}/play`, { headers: { Cookie: cookie, Range: 'bytes=5000-' } });
  assert.equal(bad.status, 416);
});

test('requests from outside allowed networks are refused', async (t) => {
  const { server, base } = await setup({ allowedNetworks: ['10.0.0.0/8'] });
  t.after(() => server.close());
  assert.equal((await req(base, '/')).status, 403);
});

test('unknown Host headers are refused (DNS rebinding)', async (t) => {
  const { server, base } = await setup();
  t.after(() => server.close());
  const port = new URL(base).port;
  const status = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/', headers: { Host: 'attacker.example' } }, (r) => { r.resume(); resolve(r.statusCode); });
  });
  assert.equal(status, 421);
});

test('revoking a device kills its session and history', async (t) => {
  const { server, base } = await setup();
  t.after(() => server.close());
  const a = await login(base);
  const b = await login(base, 'Phone');
  const r = await req(base, '/api/devices/revoke', { method: 'POST', cookie: a.cookie, csrf: a.csrf, body: { id: b.me.deviceId } });
  assert.equal(r.status, 200);
  assert.equal((await req(base, '/api/me', { cookie: b.cookie })).status, 401);
  assert.equal((await req(base, '/api/me', { cookie: a.cookie })).status, 200);
});

test('signing in again with the same device name keeps its history', async (t) => {
  const { server, base, catalog } = await setup();
  t.after(() => server.close());
  const a = await login(base, 'Kitchen');
  const movie = [...catalog.items.values()].find((i) => i.kind === 'movie');
  await req(base, '/api/progress', { method: 'POST', cookie: a.cookie, csrf: a.csrf, body: { id: movie.id, position: 50, duration: 100 } });
  const again = await login(base, 'kitchen');
  assert.equal(again.me.deviceId, a.me.deviceId);
  const p = await req(base, '/api/progress', { cookie: again.cookie });
  assert.equal(p.json.continue[0].position, 50);
});
