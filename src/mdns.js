'use strict';
/*
 * Minimal multicast-DNS responder (RFC 6762) that answers "lumio.local" with
 * this machine's current IPv4 address. Phones, tablets, laptops and many TVs
 * resolve *.local names with mDNS, so devices keep finding Lumio by name even
 * when its IP address changes (DHCP renewal, new router, VM network change).
 *
 * Deliberately tiny and strict: it only answers A/ANY questions for exactly
 * one name, only to senders on a private/link-local network, parses packets
 * with bounds checks (no compression loops), and never echoes untrusted data
 * except the question it was asked in legacy unicast replies.
 */
const dgram = require('node:dgram');
const os = require('node:os');
const net = require('node:net');

const GROUP = '224.0.0.251';
const PORT = 5353;
const TYPE_A = 1;
const TYPE_ANY = 255;
const CLASS_IN = 1;
const TTL = 120;
const MAX_PACKET = 4096;

const PRIVATE = new net.BlockList();
for (const [a, b] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['169.254.0.0', 16], ['127.0.0.0', 8]]) PRIVATE.addSubnet(a, b, 'ipv4');

/** IPv4 interfaces (address + netmask), Docker/libvirt bridges excluded. */
function interfaces() {
  return Object.entries(os.networkInterfaces())
    .filter(([name]) => !/^(docker|br-|veth|virbr)/.test(name))
    .flatMap(([, list]) => list || [])
    .filter((i) => i.family === 'IPv4' && !i.internal)
    .map((i) => ({ address: i.address, netmask: i.netmask }));
}

const ipToInt = (ip) => ip.split('.').reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0);
const sameSubnet = (a, b, mask) => ((ipToInt(a) & ipToInt(mask)) >>> 0) === ((ipToInt(b) & ipToInt(mask)) >>> 0);

/** Reads a (possibly compressed) DNS name. Returns { name, end } or null when malformed. */
function readName(buf, off) {
  const labels = [];
  let end = -1;
  let jumps = 0;
  let total = 0;
  while (true) {
    if (off >= buf.length) return null;
    const len = buf[off];
    if (len === 0) { if (end < 0) end = off + 1; break; }
    if ((len & 0xc0) === 0xc0) {
      if (off + 1 >= buf.length || ++jumps > 16) return null;
      const ptr = ((len & 0x3f) << 8) | buf[off + 1];
      if (ptr >= off) return null; // pointers must go backwards: no loops
      if (end < 0) end = off + 2;
      off = ptr;
      continue;
    }
    if (len > 63 || off + 1 + len > buf.length) return null;
    total += len + 1;
    if (total > 255) return null;
    labels.push(buf.toString('latin1', off + 1, off + 1 + len));
    off += 1 + len;
  }
  return { name: labels.join('.').toLowerCase(), end };
}

/** Parses header + questions (+ answer names/IPs, for conflict detection). */
function parsePacket(buf) {
  if (buf.length < 12 || buf.length > MAX_PACKET) return null;
  const id = buf.readUInt16BE(0);
  const flags = buf.readUInt16BE(2);
  const qd = buf.readUInt16BE(4);
  const an = buf.readUInt16BE(6);
  if (qd > 32 || an > 64) return null;
  let off = 12;
  const questions = [];
  for (let i = 0; i < qd; i++) {
    const n = readName(buf, off);
    if (!n || n.end + 4 > buf.length) return null;
    questions.push({ name: n.name, type: buf.readUInt16BE(n.end), qclass: buf.readUInt16BE(n.end + 2), raw: buf.subarray(off, n.end + 4) });
    off = n.end + 4;
  }
  const answers = [];
  for (let i = 0; i < an; i++) {
    const n = readName(buf, off);
    if (!n || n.end + 10 > buf.length) break;
    const type = buf.readUInt16BE(n.end);
    const rdlen = buf.readUInt16BE(n.end + 8);
    const rd = n.end + 10;
    if (rd + rdlen > buf.length) break;
    if (type === TYPE_A && rdlen === 4) answers.push({ name: n.name, ip: [...buf.subarray(rd, rd + 4)].join('.') });
    off = rd + rdlen;
  }
  return { id, isResponse: (flags & 0x8000) !== 0, opcode: (flags >> 11) & 0xf, questions, answers };
}

function encodeName(name) {
  const parts = name.split('.').filter(Boolean);
  const out = [];
  for (const p of parts) { const b = Buffer.from(p, 'latin1'); out.push(Buffer.from([b.length]), b); }
  out.push(Buffer.from([0]));
  return Buffer.concat(out);
}

/** Builds a response: A records for `ips`. legacy = unicast reply to a non-5353 port. */
function buildResponse(name, ips, { id = 0, question = null, ttl = TTL, legacy = false } = {}) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(legacy ? id : 0, 0);
  header.writeUInt16BE(0x8400, 2); // QR + AA
  header.writeUInt16BE(question ? 1 : 0, 4);
  header.writeUInt16BE(ips.length, 6);
  const enc = encodeName(name);
  const records = ips.map((ip) => {
    const rr = Buffer.alloc(10);
    rr.writeUInt16BE(TYPE_A, 0);
    rr.writeUInt16BE(legacy ? CLASS_IN : CLASS_IN | 0x8000, 2); // cache-flush on multicast
    rr.writeUInt32BE(legacy ? Math.min(ttl, 10) : ttl, 4);
    rr.writeUInt16BE(4, 8);
    return Buffer.concat([enc, rr, Buffer.from(ip.split('.').map(Number))]);
  });
  return Buffer.concat([header, ...(question ? [question] : []), ...records]);
}

class MdnsResponder {
  /** @param {{ name: string, log?: object, getInterfaces?: () => {address,netmask}[] }} opts */
  constructor({ name, log = console, getInterfaces = interfaces, port = PORT }) {
    this.name = String(name).toLowerCase();
    this.log = log;
    this.getInterfaces = getInterfaces;
    this.port = port;
    this.sock = null;
    this.joined = new Set();
    this.timer = null;
    this.lastIps = '';
    this.conflict = null;
    this.error = null;
    this.answered = 0;
  }

  ips() { return this.getInterfaces().map((i) => i.address); }

  start() {
    if (this.sock) return Promise.resolve();
    return new Promise((resolve) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.on('error', (e) => {
        this.error = e.message;
        this.log.warn?.(`local name ${this.name} unavailable: ${e.message}`);
        try { sock.close(); } catch { /* already closed */ }
        if (this.sock === sock) this.sock = null;
        resolve();
      });
      sock.on('message', (msg, rinfo) => this.onMessage(msg, rinfo));
      sock.bind(this.port, () => {
        this.sock = sock;
        this.error = null;
        try { sock.setMulticastTTL(255); sock.setMulticastLoopback(true); } catch { /* best effort */ }
        this.refresh(true);
        this.timer = setInterval(() => this.refresh(false), 10_000);
        this.timer.unref?.();
        this.log.info?.(`devices on your network can open Lumio as ${this.name}`);
        resolve();
      });
    });
  }

  /** Joins the multicast group on new interfaces; re-announces when the IP set changes. */
  refresh(force) {
    if (!this.sock) return;
    const list = this.getInterfaces();
    for (const i of list) {
      if (this.joined.has(i.address)) continue;
      try { this.sock.addMembership(GROUP, i.address); this.joined.add(i.address); } catch { /* interface not ready */ }
    }
    const key = list.map((i) => i.address).sort().join(',');
    if (force || key !== this.lastIps) {
      if (!force && this.lastIps) this.log.info?.(`IP address changed to ${key || 'none'}; ${this.name} now points there`);
      this.lastIps = key;
      this.conflict = null;
      this.announce();
      setTimeout(() => this.announce(), 1000).unref?.();
    }
  }

  send(packet, address, port) {
    if (this.sock) this.sock.send(packet, port, address, () => {});
  }

  /** Unsolicited announcement on every interface, one at a time (the outgoing
      multicast interface is a socket option, so sends must not overlap). */
  announce(ttl = TTL) {
    const sock = this.sock;
    if (!sock) return;
    const list = this.getInterfaces();
    const next = (k) => {
      if (k >= list.length || this.sock !== sock) return;
      try { sock.setMulticastInterface(list[k].address); } catch { next(k + 1); return; }
      sock.send(buildResponse(this.name, [list[k].address], { ttl }), this.port, GROUP, () => next(k + 1));
    };
    next(0);
  }

  onMessage(msg, rinfo) {
    if (!net.isIPv4(rinfo.address) || !PRIVATE.check(rinfo.address, 'ipv4')) return;
    const pkt = parsePacket(msg);
    if (!pkt || pkt.opcode !== 0) return;
    const mine = this.ips();
    if (pkt.isResponse) {
      // Someone else claiming our name with an address that isn't ours?
      const other = pkt.answers.find((a) => a.name === this.name && !mine.includes(a.ip));
      if (other && !mine.includes(rinfo.address) && !this.conflict) {
        this.conflict = { ip: other.ip, from: rinfo.address, at: Date.now() };
        this.log.warn?.(`another device (${rinfo.address}) also uses the name ${this.name}. Pick a different local name in Network & Security.`);
      }
      return;
    }
    const q = pkt.questions.find((x) => x.name === this.name && (x.type === TYPE_A || x.type === TYPE_ANY) && (x.qclass & 0x7fff) === CLASS_IN);
    if (!q) return;
    const ifs = this.getInterfaces();
    const local = ifs.filter((i) => sameSubnet(i.address, rinfo.address, i.netmask)).map((i) => i.address);
    const ips = local.length ? local : ifs.map((i) => i.address);
    if (!ips.length) return;
    this.answered += 1;
    if (rinfo.port !== this.port) {
      // Legacy unicast resolver (e.g. some TVs): reply directly, echoing the question and ID.
      this.send(buildResponse(this.name, ips, { id: pkt.id, question: q.raw, legacy: true }), rinfo.address, rinfo.port);
    } else {
      this.send(buildResponse(this.name, ips), GROUP, this.port);
    }
  }

  status() {
    return { name: this.name, active: !!this.sock, error: this.error, conflict: this.conflict, ips: this.ips(), answered: this.answered };
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (!this.sock) return;
    try { this.announce(0); } catch { /* goodbye is best effort */ }
    const s = this.sock;
    this.sock = null;
    this.joined.clear();
    setTimeout(() => { try { s.close(); } catch { /* closed */ } }, 50).unref?.();
  }
}

module.exports = { MdnsResponder, parsePacket, buildResponse, readName, interfaces };
