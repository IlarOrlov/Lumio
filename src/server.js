'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { readRaw, DEFAULTS } = require('./config');
const { randomToken } = require('./auth');
const { Runtime } = require('./runtime');
const { createAdmin } = require('./admin');
const log = require('./log');

async function main() {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    console.error('[lumio] refusing to run as root. Run as a normal user.');
    process.exit(1);
  }
  process.umask(0o077);

  const runtime = new Runtime();

  // Admin console: loopback only, unlocked by a fresh one-time key per start.
  const adminPort = (readRaw() || {}).adminPort || DEFAULTS.adminPort;
  const token = randomToken(32);
  const tokenFile = path.join(runtime.dataDir, 'admin.token');
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  fs.chmodSync(tokenFile, 0o600);

  const admin = http.createServer(createAdmin(runtime, { token, port: adminPort }));
  admin.headersTimeout = 15_000;
  admin.requestTimeout = 30_000;
  await new Promise((resolve, reject) => {
    admin.once('error', reject);
    admin.listen(adminPort, '127.0.0.1', resolve);
  });
  log.info(`admin console on http://127.0.0.1:${adminPort} (this machine only)`);

  if (runtime.isConfigured()) await runtime.start();
  else log.info('not set up yet: open the admin console to finish setup');

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    setTimeout(() => process.exit(0), 4000).unref();
    try { fs.unlinkSync(tokenFile); } catch { /* already gone */ }
    admin.close();
    admin.closeAllConnections();
    await runtime.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(`[lumio] ${e.code === 'EADDRINUSE' ? 'Lumio already appears to be running (admin port in use).' : e.message}`);
  process.exit(1);
});
