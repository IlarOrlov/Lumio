'use strict';
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

/** Non-internal IPv4 addresses of this machine (Docker bridges excluded). */
function localIps() {
  return Object.entries(os.networkInterfaces())
    .filter(([name]) => !/^(docker|br-|veth|virbr)/.test(name))
    .flatMap(([, list]) => list || [])
    .filter((i) => i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

/** Creates a self-signed ECDSA P-256 certificate valid for the given IPs/hostnames. */
function generateCert(certPath, keyPath, hosts) {
  const ips = new Set(['127.0.0.1', ...localIps()]);
  const names = new Set(['localhost']);
  for (const h of hosts.filter(Boolean)) (net.isIP(h) ? ips : names).add(h);
  const san = [...[...names].map((n) => `DNS:${n}`), ...[...ips].map((i) => `IP:${i}`)].join(',');
  fs.mkdirSync(path.dirname(certPath), { recursive: true, mode: 0o700 });
  const tmpKey = `${keyPath}.tmp`;
  const tmpCert = `${certPath}.tmp`;
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', tmpKey, '-out', tmpCert, '-days', '825', '-subj', '/CN=Lumio',
    '-addext', `subjectAltName=${san}`, '-addext', 'extendedKeyUsage=serverAuth',
    '-addext', 'basicConstraints=critical,CA:FALSE',
  ], { stdio: 'ignore' });
  fs.chmodSync(tmpKey, 0o600);
  fs.renameSync(tmpKey, keyPath);
  fs.renameSync(tmpCert, certPath);
}

/** Reads SANs and expiry from a PEM certificate (null if missing/unreadable). */
function certInfo(certPath) {
  try {
    const x = new crypto.X509Certificate(fs.readFileSync(certPath));
    const sans = (x.subjectAltName || '').split(',').map((s) => s.trim().replace(/^(DNS|IP Address):/, ''));
    return { sans, validTo: x.validTo, fingerprint: x.fingerprint256 };
  } catch {
    return null;
  }
}

module.exports = { generateCert, certInfo, localIps };
