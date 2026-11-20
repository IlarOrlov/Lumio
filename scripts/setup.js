#!/usr/bin/env node
'use strict';
// Interactive first-run setup: password, media folders, port, TLS certificate.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { execFileSync } = require('node:child_process');
const { hashPassword } = require('../src/auth');
const { CONFIG_PATH, ROOT, DEFAULTS } = require('../src/config');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
const ask = (q, def = '') => new Promise((r) => rl.question(def ? `${q} [${def}]: ` : `${q}: `, (a) => r(a.trim() || def)));

function askHidden(q) {
  return new Promise((resolve) => {
    const orig = rl._writeToOutput;
    rl._writeToOutput = (s) => { if (s.includes(q)) orig.call(rl, s); };
    rl.question(q, (a) => { rl._writeToOutput = orig; process.stdout.write('\n'); resolve(a); });
  });
}

function lanIps() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('172.17.'))
    .map((i) => i.address);
}

async function main() {
  console.log('\n  Lumio setup\n  ───────────\n');
  let existing = {};
  if (fs.existsSync(CONFIG_PATH)) {
    existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    console.log(`Existing config found at ${CONFIG_PATH}; press Enter to keep current values.\n`);
  }

  let passwordHash = existing.passwordHash;
  const change = !passwordHash || (await ask('Change the password? (y/N)', 'n')).toLowerCase() === 'y';
  if (change) {
    for (;;) {
      const p1 = await askHidden('Household password (min 12 characters): ');
      if (p1.length < 12) { console.log('  Too short.'); continue; }
      const p2 = await askHidden('Repeat password: ');
      if (p1 !== p2) { console.log('  Passwords do not match.'); continue; }
      passwordHash = await hashPassword(p1);
      break;
    }
  }

  const defDirs = (existing.mediaDirs || [path.join(os.homedir(), 'Videos')]).join(', ');
  let mediaDirs;
  for (;;) {
    mediaDirs = (await ask('Media folders (comma separated)', defDirs)).split(',').map((s) => s.trim()).filter(Boolean);
    const missing = mediaDirs.filter((d) => !fs.existsSync(d) || !fs.statSync(d).isDirectory());
    if (!missing.length) break;
    console.log(`  Not found: ${missing.join(', ')}`);
  }

  const port = Number(await ask('Port', String(existing.port || DEFAULTS.port)));
  const useHttps = (await ask('Use HTTPS with a self-signed certificate? (Y/n)', 'y')).toLowerCase() !== 'n';

  const cfg = {
    ...DEFAULTS, ...existing, port, https: useHttps, mediaDirs, passwordHash,
  };
  delete cfg.dataDir;

  if (useHttps) {
    const cert = path.join(ROOT, cfg.tlsCert);
    const key = path.join(ROOT, cfg.tlsKey);
    const regen = !fs.existsSync(cert) || (await ask('Regenerate the TLS certificate? (y/N)', 'n')).toLowerCase() === 'y';
    if (regen) {
      const vmIps = lanIps();
      const hostIp = await ask('Your Windows/host PC LAN IP (what phones/TVs will type, e.g. 192.168.1.20)', '');
      const ips = [...new Set(['127.0.0.1', ...vmIps, hostIp].filter(Boolean))];
      const san = ['DNS:localhost', ...ips.map((i) => `IP:${i}`)].join(',');
      fs.mkdirSync(path.dirname(cert), { recursive: true, mode: 0o700 });
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
        '-keyout', key, '-out', cert, '-days', '825', '-subj', '/CN=Lumio',
        '-addext', `subjectAltName=${san}`,
        '-addext', 'extendedKeyUsage=serverAuth',
      ], { stdio: 'ignore' });
      fs.chmodSync(key, 0o600);
      console.log(`  Certificate created for: ${ips.join(', ')}`);
    }
  }

  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(CONFIG_PATH, 0o600);
  console.log(`\n  Saved ${CONFIG_PATH}\n  Start with: npm start\n`);
  rl.close();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
