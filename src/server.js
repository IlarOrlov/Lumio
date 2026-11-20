'use strict';
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { Sessions, LoginLimiter } = require('./auth');
const { Catalog } = require('./catalog');
const { Progress } = require('./progress');
const { createApp } = require('./app');
const media = require('./media');

function main() {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    console.error('[lumio] refusing to run as root. Run as a normal user.');
    process.exit(1);
  }
  process.umask(0o077);

  const cfg = loadConfig();
  media.checkFfmpeg();

  const db = openDb(cfg.dataDir);
  const sessions = new Sessions(db, { sessionDays: cfg.sessionDays });
  const progress = new Progress(db);
  const catalog = new Catalog(db, cfg.mediaDirs, { probe: media.probe });
  catalog.rescan();

  const handler = createApp({ cfg, catalog, sessions, progress, limiter: new LoginLimiter() });

  const server = cfg.https
    ? https.createServer({
      cert: fs.readFileSync(cfg.tlsCert),
      key: fs.readFileSync(cfg.tlsKey),
      minVersion: 'TLSv1.2',
    }, handler)
    : http.createServer(handler);

  // Slowloris / resource-exhaustion limits
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 10_000;
  server.maxHeadersCount = 50;
  server.maxConnections = 200;

  server.listen(cfg.port, cfg.host, () => {
    const scheme = cfg.https ? 'https' : 'http';
    console.log(`[lumio] listening on ${scheme}://${cfg.host}:${cfg.port}`);
    if (!cfg.https) console.warn('[lumio] HTTPS is disabled: passwords and cookies travel in clear text on your LAN.');
  });

  const rescan = setInterval(() => catalog.rescan(), cfg.rescanMinutes * 60_000);
  const purge = setInterval(() => sessions.purgeExpired(), 3_600_000);
  const shutdown = () => {
    clearInterval(rescan); clearInterval(purge);
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

try {
  main();
} catch (e) {
  console.error(`[lumio] ${e.message}`);
  process.exit(1);
}
