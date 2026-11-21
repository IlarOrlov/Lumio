'use strict';
const fs = require('node:fs');

/**
 * Works out how this machine is connected, so the admin console can explain
 * what other devices need. Inside a VMware/VirtualBox NAT network other
 * devices can't reach the VM (or see its lumio.local name); in "Bridged" mode
 * the VM sits directly on the home network and nothing has to change on the
 * host PC. Detected from the default gateway's hardware address: VMware's NAT
 * gateway uses the 00:50:56 prefix, VirtualBox NAT uses 10.0.2.2.
 */
function gatewayInfo(read = (f) => fs.readFileSync(f, 'utf8')) {
  let gateway = null;
  let iface = null;
  try {
    for (const line of read('/proc/net/route').split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length > 2 && f[1] === '00000000' && f[2] !== '00000000') {
        const n = parseInt(f[2], 16);
        gateway = [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255].join('.');
        iface = f[0];
        break;
      }
    }
  } catch { /* not Linux */ }
  if (!gateway) return { mode: 'unknown', gateway: null };
  let mac = null;
  try {
    for (const line of read('/proc/net/arp').split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f[0] === gateway && f[3] && f[3] !== '00:00:00:00:00:00') { mac = f[3].toLowerCase(); break; }
    }
  } catch { /* no arp table */ }
  let mode = 'lan';
  if (mac && mac.startsWith('00:50:56')) mode = 'vmware-nat';
  else if (gateway === '10.0.2.2') mode = 'virtualbox-nat';
  return { mode, gateway, iface };
}

module.exports = { gatewayInfo };
