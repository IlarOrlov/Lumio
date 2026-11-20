'use strict';
// systemd --user integration: run Lumio in the background and optionally at boot.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const UNIT = 'lumio.service';

function sh(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout).trim(), err: String(stderr).trim() });
    });
  });
}

const underSystemd = () => !!process.env.INVOCATION_ID;

async function autostartStatus() {
  const enabled = (await sh('systemctl', ['--user', 'is-enabled', UNIT])).out === 'enabled';
  const linger = (await sh('loginctl', ['show-user', os.userInfo().username, '--property=Linger'])).out === 'Linger=yes';
  return { enabled, linger, underSystemd: underSystemd() };
}

/** enabled=true: start at login; linger additionally starts it at boot without logging in. */
async function setAutostart(enabled) {
  if (enabled) {
    const r = await sh('systemctl', ['--user', 'enable', UNIT]);
    if (!r.ok) throw new Error(r.err || 'Could not enable autostart');
    await sh('loginctl', ['enable-linger', os.userInfo().username]);
  } else {
    await sh('systemctl', ['--user', 'disable', UNIT]);
    await sh('loginctl', ['disable-linger', os.userInfo().username]);
  }
  return autostartStatus();
}

/** Stops the whole Lumio process (via systemd when it manages us). */
function shutdown() {
  if (underSystemd()) {
    execFile('systemctl', ['--user', 'stop', UNIT], () => {});
  } else {
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 200);
  }
}

function unitPath() {
  return path.join(os.homedir(), '.config', 'systemd', 'user', UNIT);
}

module.exports = { autostartStatus, setAutostart, shutdown, unitPath, underSystemd, fsExists: fs.existsSync };
