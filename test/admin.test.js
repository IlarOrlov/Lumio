'use strict';
// Admin console: access control and the first-run setup flow, against a
// throw-away config/data directory (needs ffmpeg + openssl installed).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-admin-'));
const MEDIA = path.join(TMP, 'media');
fs.mkdirSync(MEDIA);
process.env.LUMIO_CONFIG = path.join(TMP, 'lumio.json');
fs.writeFileSync(process.env.LUMIO_CONFIG, JSON.stringify({
  dataDir: path.join(TMP, 'data'), tlsCert: path.join(TMP, 'tls', 'cert.pem'), tlsKey: path.join(TMP, 'tls', 'key.pem'),
}), { mode: 0o600 });

const test = require('node:test');
const assert = require('node:assert/strict');
const { Runtime } = require('../src/runtime');
const { createAdmin } = require('../src/admin');
const { AdminKeys } = require('../src/adminkeys');

async function start() {
  const runtime = new Runtime();
  const keys = new AdminKeys();
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  server.on('request', createAdmin(runtime, { keys, port }));
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  let csrf = '';
  const call = async (p, body, extra = {}) => {
    const headers = { Cookie: cookie, ...extra };
    if (body !== undefined) Object.assign(headers, { 'Content-Type': 'application/json', Origin: base, 'X-Lumio-CSRF': csrf }, extra);
    const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    let json = null;
    try { json = await r.json(); } catch { /* not json */ }
    if (json && json.csrf) csrf = json.csrf;
    return { status: r.status, json };
  };
  return { runtime, server, port, call, keys, close: async () => { await runtime.close(); server.close(); } };
}

test('admin console access control and first-run setup', async (t) => {
  const a = await start();
  t.after(a.close);

  // locked without the one-time key
  assert.equal((await a.call('/api/status')).status, 401);
  assert.equal((await a.call('/api/auth', { token: 'wrong'.repeat(9) })).status, 401);

  // wrong Host header (DNS rebinding) refused
  const hostStatus = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: a.port, path: '/', headers: { Host: 'evil.example' } }, (r) => { r.resume(); resolve(r.statusCode); });
  });
  assert.equal(hostStatus, 421);

  // unlock with a one-time key; the same key can't be used twice
  const key = a.keys.issue();
  assert.equal((await a.call('/api/auth', { token: key })).status, 200);
  assert.equal((await a.call('/api/auth', { token: key })).status, 401, 'keys are single-use');
  const st = await a.call('/api/status');
  assert.equal(st.status, 200);
  assert.equal(st.json.configured, false);

  // CSRF + Origin enforced
  assert.equal((await a.call('/api/password', { password: 'x'.repeat(20) }, { 'X-Lumio-CSRF': 'bad' })).status, 403);
  assert.equal((await a.call('/api/password', { password: 'x'.repeat(20) }, { Origin: 'http://evil.example' })).status, 403);

  // validation
  assert.equal((await a.call('/api/password', { password: 'short' })).status, 400);
  assert.match((await a.call('/api/config', { mediaDirs: ['/etc'] })).json.error, /System folders/);
  assert.match((await a.call('/api/config', { port: 80 })).json.error, /1024/);
  assert.match((await a.call('/api/config', { allowedNetworks: ['0.0.0.0/0'] })).json.error, /internet/);
  assert.match((await a.call('/api/config', { publicHost: 'bad host!' })).json.error, /IP address or hostname/);

  // folder picker
  const fsList = await a.call(`/api/fs?path=${encodeURIComponent(TMP)}`);
  assert.ok(fsList.json.dirs.includes('media'));

  // wizard: password + folders + network -> running with HTTPS
  assert.equal((await a.call('/api/password', { password: 'a long household password' })).status, 200);
  const cfg = await a.call('/api/config', { mediaDirs: [MEDIA], port: 18555, https: true, publicHost: '192.168.1.77' });
  assert.equal(cfg.status, 200, JSON.stringify(cfg.json));
  assert.equal(cfg.json.error, null);
  const after = await a.call('/api/status');
  assert.equal(after.json.configured, true);
  assert.equal(after.json.running, true);
  assert.ok(after.json.config.cert.sans.includes('192.168.1.77'), 'cert covers the host PC IP');
  assert.equal(after.json.config.url, 'https://192.168.1.77:18555');
  assert.equal(after.json.config.passwordHash, undefined, 'hash never sent to the browser');
  const raw = JSON.parse(fs.readFileSync(process.env.LUMIO_CONFIG, 'utf8'));
  assert.equal(fs.statSync(process.env.LUMIO_CONFIG).mode & 0o777, 0o600);
  assert.equal(raw.dataDir, path.join(TMP, 'data'), 'custom data dir preserved');

  // stop / start
  await a.call('/api/server', { action: 'stop' });
  assert.equal((await a.call('/api/status')).json.running, false);
  await a.call('/api/server', { action: 'start' });
  assert.equal((await a.call('/api/status')).json.running, true);
});

test('admin keys expire and are served on an owner-only socket', async () => {
  let t = 0;
  const keys = new AdminKeys({ ttlMs: 1000, now: () => t });
  const k = keys.issue();
  t = 1500;
  assert.equal(keys.consume(k), false, 'expired');
  const sock = path.join(TMP, 'k.sock');
  const live = new AdminKeys();
  const srv = await live.listen(sock);
  assert.equal(fs.statSync(sock).mode & 0o777, 0o600);
  const got = await new Promise((resolve) => {
    let d = '';
    require('node:net').connect(sock).on('data', (c) => { d += c; }).on('end', () => resolve(d));
  });
  srv.close();
  assert.equal(live.consume(got), true);
  assert.equal(live.consume(got), false);
});
