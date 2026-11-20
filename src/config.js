'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = process.env.LUMIO_CONFIG || path.join(ROOT, 'config', 'lumio.json');

const DEFAULTS = {
  host: '0.0.0.0',
  port: 8443,
  https: true,
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

function resolveFromRoot(p) {
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

function loadConfig(file = CONFIG_PATH) {
  if (!fs.existsSync(file)) {
    throw new Error(`Config not found at ${file}. Run "npm run setup" first.`);
  }
  const st = fs.statSync(file);
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
    console.warn(`[lumio] warning: ${file} is readable by other users; run: chmod 600 ${file}`);
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cfg = { ...DEFAULTS, ...raw };

  if (!/^scrypt\$/.test(cfg.passwordHash)) {
    throw new Error('Config has no valid passwordHash. Run "npm run setup".');
  }
  if (!Array.isArray(cfg.mediaDirs) || cfg.mediaDirs.length === 0) {
    throw new Error('Config needs at least one entry in mediaDirs.');
  }
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    throw new Error('Config port must be an integer between 1 and 65535.');
  }
  cfg.mediaDirs = cfg.mediaDirs.map((d) => fs.realpathSync(path.resolve(d)));
  cfg.dataDir = resolveFromRoot(cfg.dataDir);
  cfg.tlsCert = resolveFromRoot(cfg.tlsCert);
  cfg.tlsKey = resolveFromRoot(cfg.tlsKey);
  cfg.allowedHosts = cfg.allowedHosts.map((h) => String(h).toLowerCase());
  return cfg;
}

module.exports = { loadConfig, CONFIG_PATH, ROOT, DEFAULTS };
