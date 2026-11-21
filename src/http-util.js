'use strict';
const fs = require('node:fs');
const path = require('node:path');

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "media-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "worker-src 'none'",
  // Script injection sinks (innerHTML, eval, ...) are disabled outright: the
  // UI only ever uses textContent/createElement, so nothing legitimate breaks.
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join('; ');

function securityHeaders(res, { https }) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  // same-origin: nothing ever leaks to other sites, but Lumio's own form posts carry a
  // real Origin (with no-referrer, browsers send "Origin: null" on form navigations).
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Origin-Agent-Cluster', '?1');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Permissions-Policy', [
    'camera=()', 'microphone=()', 'geolocation=()', 'payment=()', 'usb=()', 'serial=()', 'hid=()',
    'midi=()', 'display-capture=()', 'clipboard-read=()', 'accelerometer=()', 'gyroscope=()', 'magnetometer=()',
    'fullscreen=(self)', 'picture-in-picture=(self)', 'autoplay=(self)',
  ].join(', '));
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (https) res.setHeader('Strict-Transport-Security', 'max-age=63072000');
}

function parseCookies(header) {
  const out = Object.create(null);
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function sendError(res, status, message) {
  if (res.headersSent) { res.destroy(); return; }
  sendJson(res, status, { error: message });
}

/** Reads a small JSON body; rejects anything not application/json or too large. */
function readJson(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') { reject(Object.assign(new Error('JSON required'), { status: 415 })); return; }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('object expected');
        resolve(v);
      } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

/** Reads an application/x-www-form-urlencoded body (plain HTML form posts). */
function readForm(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/x-www-form-urlencoded') { reject(Object.assign(new Error('Form required'), { status: 415 })); return; }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4',
  '.webm': 'video/webm', '.woff2': 'font/woff2',
};

/**
 * Loads the public/ directory into an in-memory whitelist at startup.
 * Requests are matched against this map only, so no path traversal is possible.
 */
function loadStatic(dir) {
  const files = new Map();
  const walk = (d, prefix) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, `${prefix}${e.name}/`);
      else if (MIME[path.extname(e.name)]) {
        files.set(`/${prefix}${e.name}`, { body: fs.readFileSync(full), type: MIME[path.extname(e.name)] });
      }
    }
  };
  walk(dir, '');
  return files;
}

/** Serves a local file with HTTP Range support (for direct play and seeking). */
function sendFileRange(req, res, filePath, size, type) {
  const range = req.headers.range;
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store' };
  if (!range) {
    res.writeHead(200, { ...headers, 'Content-Length': size });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
    return;
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  let start; let end;
  if (m && m[1] !== '') {
    start = Number(m[1]);
    end = m[2] !== '' ? Math.min(Number(m[2]), size - 1) : size - 1;
  } else if (m && m[2] !== '') {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  }
  if (!m || start === undefined || start > end || start >= size) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    res.end();
    return;
  }
  res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(filePath, { start, end }).on('error', () => res.destroy()).pipe(res);
}

module.exports = { securityHeaders, parseCookies, sendJson, sendError, readJson, readForm, loadStatic, sendFileRange, MIME };
