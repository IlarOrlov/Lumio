'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashPassword, verifyPassword, LoginLimiter, Sessions } = require('../src/auth');
const { createNetworkGuard, createHostGuard } = require('../src/netguard');
const { parseName, scanLibrary, buildShows, nextEpisode } = require('../src/library');
const { Progress, isCompleted } = require('../src/progress');
const { playbackPlan, parseCaps } = require('../src/media');
const { openDb } = require('../src/db');

test('password hashing round-trips and rejects wrong passwords', async () => {
  const h = await hashPassword('correct horse battery');
  assert.match(h, /^scrypt\$32768\$8\$1\$/);
  assert.equal(await verifyPassword('correct horse battery', h), true);
  assert.equal(await verifyPassword('correct horse batterz', h), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
});

test('login limiter locks globally and escalates', () => {
  let t = 0;
  const l = new LoginLimiter({ maxPerWindow: 3, baseLockMs: 1000, now: () => t });
  l.recordFailure(); l.recordFailure();
  assert.equal(l.retryAfterMs(), 0);
  l.recordFailure();
  assert.equal(l.retryAfterMs(), 1000);
  t += 1000;
  l.recordFailure(); l.recordFailure(); l.recordFailure();
  assert.equal(l.retryAfterMs(), 2000, 'second lockout doubles');
  l.recordSuccess();
  assert.equal(l.retryAfterMs(), 0);
});

test('sessions: create, lookup, expire, revoke', () => {
  let t = 1_000_000;
  const db = openDb(':memory:');
  const s = new Sessions(db, { sessionDays: 1, now: () => t });
  const { token, deviceId } = s.createDeviceSession('TV', 'ua');
  const found = s.lookup(token);
  assert.equal(found.deviceId, deviceId);
  assert.equal(found.deviceName, 'TV');
  assert.equal(s.lookup(token + 'x'), null);
  assert.equal(s.lookup('short'), null);
  // token itself is never stored
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sessions WHERE token_hash = ?').get(token).c, 0);
  t += 2 * 86_400_000;
  assert.equal(s.lookup(token), null, 'expired');
  const b = s.createDeviceSession('Phone', '');
  assert.ok(s.revokeDevice(b.deviceId));
  assert.equal(s.lookup(b.token), null, 'revoked');
});

test('network guard allows only private ranges', () => {
  const ok = createNetworkGuard(['127.0.0.0/8', '192.168.0.0/16', '10.0.0.0/8', '::1/128', 'fc00::/7']);
  assert.ok(ok('192.168.204.2'));
  assert.ok(ok('::ffff:192.168.1.10'));
  assert.ok(ok('::1'));
  assert.ok(!ok('8.8.8.8'));
  assert.ok(!ok('::ffff:8.8.8.8'));
  assert.ok(!ok('2001:db8::1'));
  assert.ok(!ok(undefined));
});

test('host guard blocks DNS-rebinding hostnames', () => {
  const ok = createHostGuard(['lumio.home']);
  assert.ok(ok('192.168.1.20:8443'));
  assert.ok(ok('localhost:8443'));
  assert.ok(ok('[::1]:8443'));
  assert.ok(ok('lumio.home'));
  assert.ok(!ok('evil.example.com'));
  assert.ok(!ok(undefined));
});

test('filename parsing: movies and episodes', () => {
  assert.deepEqual(parseName('/m/Inception (2010) 1080p BluRay x264.mkv'), { kind: 'movie', title: 'Inception', year: 2010 });
  assert.deepEqual(parseName('/m/The.Matrix.1999.2160p.mkv'), { kind: 'movie', title: 'The Matrix', year: 1999 });
  assert.deepEqual(parseName('/m/Remux.Film.2019.1080p.BluRay.x264.mkv'), { kind: 'movie', title: 'Remux Film', year: 2019 });
  assert.equal(parseName('/m/Arrival.1080p.WEB-DL.mkv').title, 'Arrival');
  const e = parseName('/tv/Breaking.Bad.S02E05.Breakage.720p.mkv');
  assert.equal(e.kind, 'episode'); assert.equal(e.show, 'Breaking Bad');
  assert.equal(e.season, 2); assert.equal(e.episode, 5); assert.equal(e.title, 'Breakage');
  const f = parseName('/tv/Dark/Season 1/S01E03.mkv');
  assert.equal(f.show, 'Dark'); assert.equal(f.episode, 3);
  assert.equal(parseName('/tv/Show 3x07.mp4').season, 3);
});

function makeLibrary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-lib-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-out-'));
  fs.mkdirSync(path.join(dir, 'Show', 'Season 1'), { recursive: true });
  for (const f of ['Show/Season 1/Show S01E01.mkv', 'Show/Season 1/Show S01E02.mkv', 'Show/Season 1/Show S01E02.en.srt', 'Film (2020).mp4', 'notes.txt', '.hidden.mkv']) {
    fs.writeFileSync(path.join(dir, f), 'x');
  }
  fs.writeFileSync(path.join(outside, 'secret.mkv'), 'x');
  fs.symlinkSync(path.join(outside, 'secret.mkv'), path.join(dir, 'escape.mkv'));
  return { dir, outside };
}

test('library scan: groups shows, finds sidecar subs, refuses escaping symlinks', () => {
  const { dir } = makeLibrary();
  const items = scanLibrary([dir]);
  const names = [...items.values()].map((i) => path.basename(i.path)).sort();
  assert.deepEqual(names, ['Film (2020).mp4', 'Show S01E01.mkv', 'Show S01E02.mkv']);
  const shows = buildShows(items);
  assert.equal(shows.size, 1);
  const [show] = shows.values();
  assert.equal(show.episodes.length, 2);
  assert.equal(show.episodes[1].sidecarSubs[0].label, 'en');
  assert.equal(nextEpisode(shows, show.episodes[0]).id, show.episodes[1].id);
  assert.equal(nextEpisode(shows, show.episodes[1]), null);
});

test('completion threshold', () => {
  assert.ok(isCompleted(93, 100));
  assert.ok(isCompleted(2700 - 80, 2700));
  assert.ok(!isCompleted(50, 100));
  assert.ok(!isCompleted(10, 0));
});

test('progress: continue watching is per device, and offers the next episode', () => {
  const { dir } = makeLibrary();
  let t = 1000;
  const db = openDb(':memory:');
  const s = new Sessions(db);
  const a = s.createDeviceSession('A', '').deviceId;
  const b = s.createDeviceSession('B', '').deviceId;
  const items = scanLibrary([dir]);
  const shows = buildShows(items);
  const catalog = { get: (id) => items.get(id), next: (it) => nextEpisode(shows, it) };
  const [show] = shows.values();
  const [e1, e2] = show.episodes;
  const film = [...items.values()].find((i) => i.kind === 'movie');
  const p = new Progress(db, { now: () => t++ });

  p.save(a, film.id, 600, 6000);
  p.save(a, e1.id, 300, 1500);
  let cw = p.continueWatching(a, catalog);
  assert.deepEqual(cw.map((c) => c.id), [e1.id, film.id]);
  assert.equal(p.continueWatching(b, catalog).length, 0, 'device B sees nothing');

  p.save(a, e1.id, 1490, 1500); // finished episode 1
  cw = p.continueWatching(a, catalog);
  assert.equal(cw[0].id, e2.id);
  assert.equal(cw[0].upNext, true);
  assert.equal(cw.filter((c) => c.id === e1.id).length, 0);

  p.save(a, film.id, 5900, 6000);
  assert.equal(p.continueWatching(a, catalog).some((c) => c.id === film.id), false, 'finished film leaves the row');
});

test('playback plan picks direct / remux / transcode, honouring device codecs', () => {
  const mp4 = { ext: '.mp4' };
  const mkv = { ext: '.mkv' };
  const info = (codec, audio = 'aac', pixFmt = 'yuv420p', profile = 'High') => ({
    video: { codec, pixFmt, profile }, audio: [{ codec: audio, channels: 2 }], subtitles: [],
  });
  assert.equal(playbackPlan(mp4, info('h264')).mode, 'direct');
  assert.equal(playbackPlan(mkv, info('h264')).mode, 'remux');
  assert.equal(playbackPlan(mp4, info('h264', 'ac3')).mode, 'remux');
  assert.equal(playbackPlan(mkv, info('hevc')).mode, 'transcode');
  assert.equal(playbackPlan(mkv, info('hevc'), 0, parseCaps('hevc')).mode, 'remux');
  assert.equal(playbackPlan(mp4, info('av1', 'opus', 'yuv420p10le'), 0, parseCaps('av1,opus')).mode, 'direct');
  assert.equal(playbackPlan(mp4, info('h264', 'opus')).mode, 'remux', 'Opus falls back to a cheap audio conversion');
  assert.equal(playbackPlan(mp4, info('h264', 'opus'), 0, parseCaps('opus')).mode, 'direct');
  assert.equal(playbackPlan(mp4, info('h264', 'aac', 'yuv420p10le', 'High 10')).mode, 'transcode');
  assert.deepEqual([...parseCaps('av1,evil,hevc')], ['av1', 'hevc']);
});

test('compaction plan: AV1 only where it pays, slim audio for lean video', () => {
  const { planFor, opusKbps } = require('../src/compact');
  const sd = { size: 144e6 };
  const sdInfo = { duration: 2634, video: { codec: 'h264', width: 704, height: 400 }, audio: [{ codec: 'aac', channels: 2, bitRate: 112000 }] };
  const p1 = planFor(sd, sdInfo);
  assert.equal(p1.plan, 'audio', 'lean SD video: keep picture, slim audio');
  assert.ok(p1.estimate > 0.8 && p1.estimate < 0.9, `estimate ${p1.estimate}`);

  const bluray = { size: 8e9 };
  const brInfo = { duration: 7200, video: { codec: 'h264', width: 1920, height: 1080 }, audio: [{ codec: 'dts', channels: 6, bitRate: 1509000 }] };
  assert.equal(planFor(bluray, brInfo).plan, 'av1');

  const done = { size: 125e6 };
  const doneInfo = { duration: 2634, video: { codec: 'h264', width: 704, height: 400 }, audio: [{ codec: 'opus', channels: 2, bitRate: 48000 }] };
  assert.equal(planFor(done, doneInfo), null, 'already slimmed: nothing to do');

  assert.equal(opusKbps({ channels: 2, bitRate: 112000 }, 48), 48);
  assert.equal(opusKbps({ channels: 2, bitRate: 56000 }, 48), 42, 'never above 75% of source');
  assert.equal(opusKbps({ channels: 6, bitRate: 640000 }, 64), 240);
});

test('Windows helper: CRLF batch with embedded PowerShell, validated inputs only', () => {
  const { buildWindowsHelper } = require('../src/winhelper');
  const fp = Array.from({ length: 32 }, () => 'AB').join(':');
  const cmd = buildWindowsHelper({ vmIp: '192.168.204.128', port: 8443, https: true, fingerprint: fp, token: 'T'.repeat(43) });
  assert.ok(!/[^\r]\n/.test(cmd), 'CRLF line endings for cmd.exe');
  assert.match(cmd, /^@echo off\r\n/);
  // the self-extraction offset must land exactly after the marker line
  const i = cmd.lastIndexOf('#__LUMIO_PS__') + 13;
  assert.match(cmd.slice(i), /^\r\n\$ErrorActionPreference = 'Stop'/);
  assert.match(cmd, /"\$Port = \$\(\$VmIp\):\$Port"/);
  assert.match(cmd, /-Profile Private -RemoteAddress LocalSubnet/);
  assert.match(cmd, new RegExp(`LumioFp = '${fp}'`));
  // minimal footprint: no backup copies or PowerShell caches, undo + self-delete offered
  assert.ok(!/Copy-Item/.test(cmd), 'never writes backup copies');
  assert.match(cmd, /set "PSModuleAnalysisCachePath=NUL"\r\n/);
  assert.match(cmd, /\[2\] Undo/);
  assert.match(cmd, /Remove-NetFirewallRule/);
  assert.match(cmd, /\(goto\) 2>nul & del \/f \/q "%~f0"/);
  assert.ok(!/[^\x00-\x7f]/.test(cmd), 'ASCII only (cmd.exe / Windows PowerShell 5.1)');
  for (const bad of [
    { vmIp: "1.2.3.4'; calc #", port: 8443, https: false, token: 'T'.repeat(43) },
    { vmIp: '192.168.204.128', port: '8443; x', https: false, token: 'T'.repeat(43) },
    { vmIp: '192.168.204.128', port: 8443, https: true, fingerprint: "AB'", token: 'T'.repeat(43) },
    { vmIp: '192.168.204.128', port: 8443, https: false, token: "x'; y" },
  ]) assert.throws(() => buildWindowsHelper(bad));
});

test('mDNS: answers A queries for exactly our name, legacy unicast echoes the question, rejects malformed packets', () => {
  const { MdnsResponder, parsePacket, buildResponse } = require('../src/mdns');
  const sent = [];
  const r = new MdnsResponder({ name: 'lumio.local', log: {}, getInterfaces: () => [{ address: '192.168.1.20', netmask: '255.255.255.0' }, { address: '10.9.0.5', netmask: '255.255.0.0' }] });
  r.sock = { send: (buf, port, addr) => sent.push({ buf, port, addr }) };
  const query = (name, type = 1, id = 0x1234) => {
    const labels = name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]));
    const hdr = Buffer.alloc(12); hdr.writeUInt16BE(id, 0); hdr.writeUInt16BE(1, 4);
    const tail = Buffer.alloc(4); tail.writeUInt16BE(type, 0); tail.writeUInt16BE(1, 2);
    return Buffer.concat([hdr, ...labels, Buffer.from([0]), tail]);
  };
  r.onMessage(query('LUMIO.local'), { address: '192.168.1.50', port: 5353 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].addr, '224.0.0.251');
  const ans = parsePacket(sent[0].buf);
  assert.ok(ans.isResponse);
  assert.deepEqual(ans.answers, [{ name: 'lumio.local', ip: '192.168.1.20' }], 'answers with the address on the asker\'s subnet');

  r.onMessage(query('lumio.local', 1, 0xbeef), { address: '192.168.1.50', port: 40000 });
  const legacy = sent[1];
  assert.equal(legacy.addr, '192.168.1.50'); assert.equal(legacy.port, 40000);
  const lp = parsePacket(legacy.buf);
  assert.equal(lp.id, 0xbeef); assert.equal(lp.questions[0].name, 'lumio.local');

  r.onMessage(query('other.local'), { address: '192.168.1.50', port: 5353 });
  r.onMessage(query('lumio.local', 28), { address: '192.168.1.50', port: 5353 });
  r.onMessage(query('lumio.local'), { address: '8.8.8.8', port: 5353 });
  assert.equal(sent.length, 2, 'ignores other names, AAAA, and public senders');

  const loop = Buffer.concat([Buffer.alloc(12), Buffer.from([0xc0, 12, 0, 1, 0, 1])]);
  loop.writeUInt16BE(1, 4);
  assert.equal(parsePacket(loop), null, 'compression pointer loop rejected');
  assert.equal(parsePacket(Buffer.alloc(5)), null);

  // conflict: another host answering for our name with a foreign address
  r.onMessage(buildResponse('lumio.local', ['192.168.1.99']), { address: '192.168.1.99', port: 5353 });
  assert.equal(r.status().conflict.ip, '192.168.1.99');
});
