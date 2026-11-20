'use strict';
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = process.env.LUMIO_CONFIG || path.join(ROOT, 'config', 'lumio.json');

const DEFAULTS = {
  host: '0.0.0.0',
  port: 8443,
  adminPort: 8442,
  https: true,
  publicHost: '',
  tlsCert: 'config/tls/cert.pem',
  tlsKey: 'config/tls/key.pem',
  mediaDirs: [],
  passwordHash: '',
  allowedNetworks: [
    '127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16',
    '::1/128', 'fc00::/7', 'fe80::/10',
  ],
  allowedHosts: [],
  sessionDays: 180,
  maxTranscodes: 3,
  rescanMinutes: 15,
  dataDir: 'data',
};

const FORBIDDEN_MEDIA = ['/', '/etc', '/proc', '/sys', '/dev', '/boot', '/root', '/bin', '/sbin', '/lib', '/usr', '/var', '/run'];

function resolveFromRoot(p) {
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

/** Raw config as stored on disk (relative paths kept), or null if not set up yet. */
function readRaw(file = CONFIG_PATH) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Atomic, owner-only write of the raw config. */
function writeRaw(obj, file = CONFIG_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function isValidHostName(h) {
  return net.isIP(h) !== 0 || /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(h);
}

function validateMediaDir(d) {
  if (typeof d !== 'string' || !d.trim()) throw new Error('Empty media folder');
  let real;
  try { real = fs.realpathSync(path.resolve(d)); } catch { throw new Error(`Folder not found: ${d}`); }
  if (!fs.statSync(real).isDirectory()) throw new Error(`Not a folder: ${d}`);
  if (FORBIDDEN_MEDIA.includes(real) || /^\/(proc|sys|dev|etc|boot)(\/|$)/.test(real)) {
    throw new Error(`System folders can't be used as media folders: ${real}`);
  }
  fs.accessSync(real, fs.constants.R_OK | fs.constants.X_OK);
  return real;
}

/** Full, validated runtime config. Throws a readable message when unusable. */
function loadConfig(file = CONFIG_PATH) {
  const raw = readRaw(file);
  if (!raw) throw new Error('Lumio is not set up yet. Open the admin console to finish setup.');
  const cfg = { ...DEFAULTS, ...raw };
  if (!/^scrypt\$/.test(cfg.passwordHash)) throw new Error('No household password set.');
  if (!Array.isArray(cfg.mediaDirs) || cfg.mediaDirs.length === 0) throw new Error('Add at least one media folder.');
  if (!Number.isInteger(cfg.port) || cfg.port < 1024 || cfg.port > 65535) throw new Error('Port must be between 1024 and 65535.');
  cfg.mediaDirs = cfg.mediaDirs.map(validateMediaDir);
  cfg.dataDir = resolveFromRoot(cfg.dataDir);
  cfg.tlsCert = resolveFromRoot(cfg.tlsCert);
  cfg.tlsKey = resolveFromRoot(cfg.tlsKey);
  cfg.allowedHosts = cfg.allowedHosts.map((h) => String(h).toLowerCase());
  if (cfg.publicHost && net.isIP(cfg.publicHost) === 0) cfg.allowedHosts.push(cfg.publicHost.toLowerCase());
  if (cfg.https && (!fs.existsSync(cfg.tlsCert) || !fs.existsSync(cfg.tlsKey))) {
    throw new Error('HTTPS is on but no certificate exists yet. Generate one in Network & Security.');
  }
  return cfg;
}

module.exports = {
  loadConfig, readRaw, writeRaw, validateMediaDir, isValidHostName, resolveFromRoot,
  CONFIG_PATH, ROOT, DEFAULTS,
};
