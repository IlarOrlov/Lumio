'use strict';
/*
 * HTTPS certificates. Lumio runs its own tiny certificate authority ("Lumio
 * home CA") and signs a short-lived server certificate with it:
 *
 *  - Install the CA once on a device and the browser verifies Lumio properly
 *    (no warning, and a man-in-the-middle can't silently substitute its own
 *    certificate, which clicking through a self-signed warning allows).
 *  - The CA is name-constrained: it can only vouch for Lumio's own names and
 *    for private/loopback IP addresses, never for real websites, so trusting
 *    it on a phone can't be abused to intercept banking or email traffic.
 *  - The server certificate is re-issued automatically when this machine's IP
 *    address changes or it nears expiry; the CA stays the same, so devices
 *    don't have to re-install anything.
 */
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const LEAF_DAYS = 397;
const CA_DAYS = 3650;
const RENEW_BEFORE_DAYS = 30;
const PRIVATE_IP_CONSTRAINTS = [
  '127.0.0.0/255.0.0.0', '10.0.0.0/255.0.0.0', '172.16.0.0/255.240.0.0',
  '192.168.0.0/255.255.0.0', '169.254.0.0/255.255.0.0',
];
const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Non-internal IPv4 addresses of this machine (Docker bridges excluded). */
function localIps() {
  return Object.entries(os.networkInterfaces())
    .filter(([name]) => !/^(docker|br-|veth|virbr)/.test(name))
    .flatMap(([, list]) => list || [])
    .filter((i) => i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

const caPaths = (certPath) => {
  const dir = path.dirname(certPath);
  return { cert: path.join(dir, 'ca.pem'), key: path.join(dir, 'ca-key.pem') };
};

function readX509(file) {
  try { return new crypto.X509Certificate(fs.readFileSync(file)); } catch { return null; }
}

const daysLeft = (x) => (new Date(x.validTo).getTime() - Date.now()) / 86_400_000;

function openssl(args) {
  execFileSync('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The DNS names a CA (or certificate) must cover: always localhost + Lumio's own names. */
function dnsNames(names) {
  return [...new Set(['localhost', ...names.map((n) => String(n || '').toLowerCase())])]
    .filter((n) => n && net.isIP(n) === 0 && HOST_RE.test(n));
}

/** DNS names the CA is permitted to sign for (read back from its nameConstraints). */
function caPermittedNames(caCertPath) {
  try {
    const out = execFileSync('openssl', ['x509', '-noout', '-ext', 'nameConstraints', '-in', caCertPath], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return [...out.matchAll(/DNS:([^\s,]+)/g)].map((m) => m[1].toLowerCase());
  } catch { return []; }
}

/**
 * Makes sure a CA exists that may sign for all `names`. A new CA is created
 * only when there is none, it expires within a year, or a new name was added
 * (devices then need to install the new CA once).
 */
function ensureCa(certPath, names) {
  const ca = caPaths(certPath);
  const want = dnsNames(names);
  const x = readX509(ca.cert);
  if (x && fs.existsSync(ca.key) && daysLeft(x) > 365) {
    const permitted = caPermittedNames(ca.cert);
    if (want.every((n) => permitted.includes(n))) return { created: false, replaced: false, ...ca };
  }
  fs.mkdirSync(path.dirname(certPath), { recursive: true, mode: 0o700 });
  const tag = crypto.randomBytes(3).toString('hex');
  const constraints = [...want.map((n) => `permitted;DNS:${n}`), ...PRIVATE_IP_CONSTRAINTS.map((r) => `permitted;IP:${r}`)].join(',');
  const tmpKey = `${ca.key}.tmp`;
  const tmpCert = `${ca.cert}.tmp`;
  openssl([
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-sha256',
    '-keyout', tmpKey, '-out', tmpCert, '-days', String(CA_DAYS), '-subj', `/O=Lumio/CN=Lumio home CA ${tag}`,
    '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    '-addext', `nameConstraints=critical,${constraints}`,
  ]);
  fs.chmodSync(tmpKey, 0o600);
  fs.renameSync(tmpKey, ca.key);
  fs.renameSync(tmpCert, ca.cert);
  return { created: true, replaced: !!x, ...ca };
}

/**
 * Issues a server certificate for `hosts` (IPs and names), signed by the CA.
 * The certificate file holds the full chain (server certificate, then CA).
 */
function generateCert(certPath, keyPath, hosts, { caNames = [] } = {}) {
  const ips = new Set(['127.0.0.1', ...localIps()]);
  const names = new Set(['localhost']);
  for (const h of hosts.filter(Boolean).map((s) => String(s).toLowerCase())) {
    if (net.isIPv4(h)) ips.add(h);
    else if (net.isIP(h) === 0 && HOST_RE.test(h)) names.add(h);
  }
  const ca = ensureCa(certPath, [...names, ...caNames]);
  const san = [...[...names].map((n) => `DNS:${n}`), ...[...ips].map((i) => `IP:${i}`)].join(',');
  const dir = path.dirname(certPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = (s) => path.join(dir, `.issue-${process.pid}.${s}`);
  const [k, csr, crt, ext] = ['key', 'csr', 'crt', 'ext'].map(tmp);
  const primary = [...names].find((n) => n !== 'localhost') || 'Lumio';
  try {
    fs.writeFileSync(ext, [
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature',
      'extendedKeyUsage=serverAuth',
      `subjectAltName=${san}`,
      'subjectKeyIdentifier=hash',
      'authorityKeyIdentifier=keyid',
      '',
    ].join('\n'), { mode: 0o600 });
    openssl(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', k, '-out', csr, '-subj', `/O=Lumio/CN=${primary}`]);
    openssl(['x509', '-req', '-in', csr, '-CA', ca.cert, '-CAkey', ca.key, '-set_serial', `0x${crypto.randomBytes(16).toString('hex')}`,
      '-days', String(LEAF_DAYS), '-sha256', '-extfile', ext, '-out', crt]);
    fs.chmodSync(k, 0o600);
    fs.writeFileSync(crt, Buffer.concat([fs.readFileSync(crt), fs.readFileSync(ca.cert)]));
    fs.renameSync(k, keyPath);
    fs.renameSync(crt, certPath);
  } finally {
    for (const f of [k, csr, crt, ext]) fs.rmSync(f, { force: true });
  }
  return { caCreated: ca.created, caReplaced: ca.replaced };
}

/** Reads SANs, expiry, fingerprint and issuer of the server certificate (null if missing). */
function certInfo(certPath) {
  const x = readX509(certPath);
  if (!x) return null;
  const sans = (x.subjectAltName || '').split(',').map((s) => s.trim().replace(/^(DNS|IP Address):/, '')).filter(Boolean);
  const caX = readX509(caPaths(certPath).cert);
  const signedByCa = !!(caX && x.checkIssued(caX) && x.verify(caX.publicKey));
  return { sans, validTo: x.validTo, fingerprint: x.fingerprint256, signedByCa, daysLeft: Math.floor(daysLeft(x)) };
}

/** Public details of the home CA, for the admin console and device setup. */
function caInfo(certPath) {
  const x = readX509(caPaths(certPath).cert);
  if (!x) return null;
  return { subject: x.subject.replace(/\n/g, ', '), validTo: x.validTo, fingerprint: x.fingerprint256, names: caPermittedNames(caPaths(certPath).cert) };
}

/**
 * Re-issues the server certificate when needed: no certificate yet, not signed
 * by the current CA, missing one of `hosts` or this machine's current IPs, or
 * expiring soon. Returns { renewed, caCreated }.
 */
function ensureCert(certPath, keyPath, hosts, { force = false, caNames = [] } = {}) {
  const info = certInfo(certPath);
  const want = ['127.0.0.1', ...localIps(), ...hosts.filter(Boolean).map((h) => String(h).toLowerCase())];
  const caOk = (() => {
    const x = readX509(caPaths(certPath).cert);
    if (!x || daysLeft(x) <= 365) return false;
    const permitted = caPermittedNames(caPaths(certPath).cert);
    return dnsNames([...hosts, ...caNames]).every((n) => permitted.includes(n));
  })();
  const ok = !force && info && fs.existsSync(keyPath) && info.signedByCa && caOk
    && info.daysLeft > RENEW_BEFORE_DAYS && want.every((h) => info.sans.includes(h));
  if (ok) return { renewed: false, caCreated: false };
  const r = generateCert(certPath, keyPath, hosts, { caNames });
  return { renewed: true, caCreated: r.caCreated, caReplaced: r.caReplaced };
}

module.exports = { generateCert, ensureCert, certInfo, caInfo, caPaths, localIps };
