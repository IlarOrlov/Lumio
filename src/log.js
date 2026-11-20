'use strict';
// Tiny logger that also keeps the last 500 lines for the admin console.
const lines = [];

function write(level, args) {
  const msg = args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ').replace(/^\[lumio\] /, '');
  lines.push({ t: Date.now(), level, msg });
  if (lines.length > 500) lines.shift();
  (level === 'error' ? console.error : console.log)(`[lumio] ${level === 'info' ? '' : level + ': '}${msg}`);
}

module.exports = {
  info: (...a) => write('info', a),
  warn: (...a) => write('warn', a),
  error: (...a) => write('error', a),
  recent: (since = 0) => lines.filter((l) => l.t > since),
};
