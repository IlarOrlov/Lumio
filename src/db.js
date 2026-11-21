'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS devices (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  user_agent  TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  device_id   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  csrf        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS progress (
  device_id   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  media_id    TEXT NOT NULL,
  position    REAL NOT NULL,
  duration    REAL NOT NULL,
  completed   INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (device_id, media_id)
);
CREATE INDEX IF NOT EXISTS progress_recent ON progress(device_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS probes (
  media_id    TEXT PRIMARY KEY,
  size        INTEGER NOT NULL,
  mtime       INTEGER NOT NULL,
  info        TEXT NOT NULL
);
`;

function openDb(dataDir) {
  let file = ':memory:';
  if (dataDir !== ':memory:') {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    file = path.join(dataDir, 'lumio.db');
  }
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  // v2: admin devices (granted only from the admin console on the Lumio computer)
  const cols = db.prepare('PRAGMA table_info(devices)').all().map((c) => c.name);
  if (!cols.includes('is_admin')) db.exec('ALTER TABLE devices ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
  return db;
}

module.exports = { openDb };
