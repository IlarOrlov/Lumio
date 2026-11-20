'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { readRaw, DEFAULTS } = require('./config');
const { AdminKeys } = require('./adminkeys');
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

  // Admin console: loopback only, unlocked by single-use 60 s keys that the
  // launcher fetches over an owner-only unix socket in the 0700 data dir.
  const adminPort = (readRaw() || {}).adminPort || DEFAULTS.adminPort;
  fs.chmodSync(runtime.dataDir, 0o700);
  try { fs.unlinkSync(path.join(runtime.dataDir, 'admin.token')); } catch { /* legacy file */ }
  const keys = new AdminKeys();
  const keySocketPath = path.join(runtime.dataDir, 'admin.sock');

  const admin = http.createServer(createAdmin(runtime, { keys, port: adminPort }));
  admin.headersTimeout = 15_000;
  admin.requestTimeout = 30_000;
  await new Promise((resolve, reject) => {
    admin.once('error', reject);
    admin.listen(adminPort, '127.0.0.1', resolve);
  });
  const keySocket = await keys.listen(keySocketPath);
  log.info(`admin console on http://127.0.0.1:${adminPort} (this machine only)`);

  if (runtime.isConfigured()) await runtime.start();
  else log.info('not set up yet: open the admin console to finish setup');

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    setTimeout(() => process.exit(0), 4000).unref();
    keySocket.close();
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
