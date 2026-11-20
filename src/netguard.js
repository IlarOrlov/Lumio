'use strict';
const net = require('node:net');

/**
 * Builds a predicate that returns true when a remote address is inside one of
 * the allowed CIDR ranges. Uses node's BlockList, so IPv4-mapped IPv6
 * addresses (::ffff:192.168.1.5) are normalised first.
 */
function createNetworkGuard(cidrs) {
  const list = new net.BlockList();
  for (const cidr of cidrs) {
    const [addr, bitsStr] = String(cidr).split('/');
    const type = net.isIPv6(addr) ? 'ipv6' : net.isIPv4(addr) ? 'ipv4' : null;
    if (!type) throw new Error(`Invalid network in allowedNetworks: ${cidr}`);
    const bits = bitsStr === undefined ? (type === 'ipv4' ? 32 : 128) : Number(bitsStr);
    list.addSubnet(addr, bits, type);
  }
  return function isAllowed(remote) {
    if (!remote) return false;
    let ip = remote;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped) ip = mapped[1];
    const type = net.isIPv4(ip) ? 'ipv4' : net.isIPv6(ip) ? 'ipv6' : null;
    if (!type) return false;
    return list.check(ip, type);
  };
}

/**
 * DNS-rebinding defence: only accept Host headers that are IP literals,
 * localhost, or names explicitly listed in config.allowedHosts.
 */
function createHostGuard(allowedHosts) {
  const allowed = new Set(allowedHosts.map((h) => h.toLowerCase()));
  return function isHostAllowed(hostHeader) {
    if (typeof hostHeader !== 'string' || hostHeader.length > 255) return false;
    let host = hostHeader.toLowerCase();
    if (host.startsWith('[')) {
      const end = host.indexOf(']');
      if (end === -1) return false;
      return net.isIPv6(host.slice(1, end));
    }
    host = host.replace(/:\d+$/, '');
    return net.isIPv4(host) || host === 'localhost' || allowed.has(host);
  };
}

module.exports = { createNetworkGuard, createHostGuard };
