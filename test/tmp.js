'use strict';
// Temporary folders for tests, removed when the test process exits.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dirs = [];
process.on('exit', () => {
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ } }
});

module.exports = function mkTmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
};
