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
  dataDir: path.join(TMP, 'data'), mdns: false, tlsCert: path.join(TMP, 'tls', 'cert.pem'), tlsKey: path.join(TMP, 'tls', 'key.pem'),
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
  assert.equal(after.json.config.url, 'https://lumio.local:18555', 'devices use the local name');
  assert.equal(after.json.config.ipUrl, 'https://192.168.1.77:18555');
  assert.ok(after.json.config.cert.sans.includes('lumio.local'));
  assert.equal(after.json.config.cert.signedByCa, true, 'server certificate is signed by the home CA');
  assert.ok(after.json.config.ca.names.includes('lumio.local'), 'CA is name-constrained to Lumio');
  assert.equal(fs.statSync(path.join(TMP, 'tls', 'ca-key.pem')).mode & 0o777, 0o600);
  assert.equal(after.json.config.passwordHash, undefined, 'hash never sent to the browser');
  const raw = JSON.parse(fs.readFileSync(process.env.LUMIO_CONFIG, 'utf8'));
  assert.equal(fs.statSync(process.env.LUMIO_CONFIG).mode & 0o777, 0o600);
  assert.equal(raw.dataDir, path.join(TMP, 'data'), 'custom data dir preserved');

  // Windows helper. Viewer download: the report is only a proposal the owner confirms.
  const tokOf = (txt) => /\$Token = '([A-Za-z0-9_-]+)'/.exec(txt)[1];
  const viewerTok = tokOf(a.runtime.windowsHelper());
  assert.throws(() => a.runtime.hostReport(viewerTok, '8.8.8.8'), /private/);
  assert.throws(() => a.runtime.hostReport('nope'.repeat(10), '192.168.1.50'), /token/);
  assert.deepEqual(a.runtime.hostReport(viewerTok, '192.168.1.60'), { ok: true, pending: true });
  assert.throws(() => a.runtime.hostReport(viewerTok, '192.168.1.60'), /token/, 'single use');
  let st2 = await a.call('/api/status');
  assert.equal(st2.json.config.publicHost, '192.168.1.77', 'viewer helper cannot change settings by itself');
  assert.equal(st2.json.pendingHost.ip, '192.168.1.60');
  assert.equal((await a.call('/api/host/apply', {})).status, 200);
  await new Promise((r) => setTimeout(r, 900));
  st2 = await a.call('/api/status');
  assert.equal(st2.json.config.publicHost, '192.168.1.60');
  assert.equal(st2.json.pendingHost, null);
  // Admin download: applies directly; certificate follows the new address
  const adminTok = tokOf(a.runtime.windowsHelper({ autoApply: true }));
  assert.deepEqual(a.runtime.hostReport(adminTok, '192.168.1.50'), { ok: true, pending: false });
  st2 = await a.call('/api/status');
  assert.equal(st2.json.config.publicHost, '192.168.1.50');
  assert.ok(st2.json.config.cert.sans.includes('192.168.1.50'));
  assert.ok(st2.json.config.cert.sans.includes('lumio.local'), 'local name kept');
  const caBefore = st2.json.config.ca.fingerprint;
  await new Promise((r) => setTimeout(r, 900)); // let the deferred restart finish

  // a new local name re-issues the certificate (and the name-constrained CA)
  assert.equal((await a.call('/api/config', { localName: 'Bad Name!' })).status, 400);
  assert.equal((await a.call('/api/config', { localName: 'cinema' })).status, 200);
  st2 = await a.call('/api/status');
  assert.equal(st2.json.config.url, 'https://cinema.local:18555');
  assert.ok(st2.json.config.cert.sans.includes('cinema.local'));
  assert.notEqual(st2.json.config.ca.fingerprint, caBefore);
  // renewing keeps the CA (devices don't need to re-install it)
  const caNow = st2.json.config.ca.fingerprint;
  assert.equal((await a.call('/api/cert', {})).status, 200);
  assert.equal((await a.call('/api/status')).json.config.ca.fingerprint, caNow);

  // grant / remove admin rights from the console
  const dev = a.runtime.sessions.createDeviceSession('Owner laptop', 'ua');
  assert.equal((await a.call('/api/devices/admin', { id: dev.deviceId, admin: true })).status, 200);
  assert.equal((await a.call('/api/devices')).json.find((d) => d.id === dev.deviceId).isAdmin, true);
  assert.equal((await a.call('/api/devices/admin', { id: dev.deviceId, admin: false })).status, 200);
  assert.equal((await a.call('/api/devices')).json.find((d) => d.id === dev.deviceId).isAdmin, false);
  assert.equal((await a.call('/api/devices/admin', { id: 'nope', admin: true })).status, 400);
  a.runtime.sessions.revokeDevice(dev.deviceId);

  // remove all devices
  a.runtime.sessions.createDeviceSession('Phone', 'ua');
  a.runtime.sessions.createDeviceSession('TV', 'ua');
  const ra = await a.call('/api/devices/revoke-all', {});
  assert.equal(ra.json.removed, 2);
  assert.equal((await a.call('/api/devices')).json.length, 0);

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
