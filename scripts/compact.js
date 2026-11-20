#!/usr/bin/env node
'use strict';
/*
 * lumio compact: shrink your library by re-encoding to AV1 video + Opus audio
 * in an MP4 container (direct-playable on modern browsers, no server CPU at
 * playback). Typical savings vs H.264: 40-60% at visually similar quality.
 *
 *   npm run compact                      # dry run: report candidates and estimate
 *   npm run compact -- --apply --replace # encode, verify, then replace originals
 *   npm run compact -- --apply --out /mnt/new-library
 *
 * Safety: output is written to a hidden temp file first, verified (duration
 * matches within 2 s, file is smaller), and only then moved into place.
 * Originals are never touched without --replace.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadConfig } = require('../src/config');
const { scanLibrary, mediaId } = require('../src/library');
const { openDb } = require('../src/db');
const media = require('../src/media');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const APPLY = flag('--apply');
const REPLACE = flag('--replace');
const OUT = opt('--out', null);
const CRF = Number(opt('--crf', '30'));      // SVT-AV1: 24 = near-transparent, 30 = great, 35 = small
const PRESET = Number(opt('--preset', '6')); // 4 = slow/best, 6 = balanced, 8 = fast
const MIN_MB = Number(opt('--min-mb', '200'));
const KEEP_LANGS = opt('--audio-langs', '')  // e.g. "eng,heb" keeps only these audio languages
  .split(',').map((s) => s.trim()).filter(Boolean);

const gb = (b) => `${(b / 1024 ** 3).toFixed(2)} GB`;

function encode(src, dst, info) {
  const audio = info.audio
    .filter((a) => !KEEP_LANGS.length || !a.language || KEEP_LANGS.includes(a.language))
    .map((a) => a.index);
  if (!audio.length && info.audio.length) audio.push(0);
  const textSubs = info.subtitles.filter((s) => s.text).map((s) => s.index);

  const a = ['-hide_banner', '-loglevel', 'error', '-stats', '-nostdin', ...media.SAFE_INPUT,
    '-i', media.asInput(src), '-map', '0:v:0'];
  for (const i of audio) a.push('-map', `0:a:${i}`);
  for (const i of textSubs) a.push('-map', `0:s:${i}`);
  a.push('-c:v', 'libsvtav1', '-crf', String(CRF), '-preset', String(PRESET),
    '-pix_fmt', 'yuv420p10le', '-svtav1-params', 'tune=0:film-grain=8',
    '-g', '240');
  if (audio.length) {
    a.push('-c:a', 'libopus', '-b:a', '128k', '-vbr', 'on',
      '-af', 'aformat=channel_layouts=7.1|5.1|stereo|mono');
    audio.forEach((idx, n) => {
      const ch = info.audio[idx].channels || 2;
      a.push(`-b:a:${n}`, ch > 2 ? `${Math.min(ch, 8) * 48}k` : '128k');
    });
  }
  if (textSubs.length) a.push('-c:s', 'mov_text');
  a.push('-map_metadata', '0', '-movflags', '+faststart', '-y', `file:${dst}`);

  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', a, { stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
}

async function main() {
  const cfg = loadConfig();
  media.checkFfmpeg();
  const items = [...scanLibrary(cfg.mediaDirs).values()];
  const candidates = [];
  for (const it of items) {
    if (it.size < MIN_MB * 1024 * 1024) continue;
    let info;
    try { info = await media.probe(it.path); } catch { continue; }
    if (!info.video || info.video.codec === 'av1') continue;
    candidates.push({ it, info });
  }
  const total = candidates.reduce((s, c) => s + c.it.size, 0);
  console.log(`\n${candidates.length} file(s) could be compacted, ${gb(total)} total.`);
  console.log(`Estimated size after AV1 (crf ${CRF}): ~${gb(total * 0.45)} - ${gb(total * 0.6)}\n`);
  for (const { it, info } of candidates) {
    const imageSubs = info.subtitles.filter((s) => !s.text).length;
    console.log(`  ${gb(it.size).padStart(9)}  ${info.video.codec.padEnd(5)} ${path.basename(it.path)}${imageSubs ? `  (drops ${imageSubs} image subtitle track(s))` : ''}`);
  }
  if (!APPLY) { console.log('\nDry run. Add --apply with --replace or --out <dir> to encode.\n'); return; }
  if (!REPLACE && !OUT) { console.error('\n--apply needs --replace or --out <dir>.'); process.exit(1); }

  const db = openDb(cfg.dataDir);
  let saved = 0;
  for (const { it, info } of candidates) {
    const dir = path.dirname(it.path);
    const stem = path.basename(it.path, it.ext);
    const tmp = path.join(dir, `.${stem}.lumio-tmp.mp4`);
    console.log(`\n→ ${path.basename(it.path)}`);
    try {
      await encode(it.path, tmp, info);
      const out = await media.probe(tmp);
      const size = fs.statSync(tmp).size;
      if (Math.abs(out.duration - info.duration) > 2) throw new Error('duration mismatch, keeping original');
      if (size >= it.size) throw new Error('result not smaller, keeping original');
      let finalPath;
      if (REPLACE) {
        finalPath = path.join(dir, `${stem}.mp4`);
        fs.renameSync(tmp, finalPath);
        if (finalPath !== it.path) {
          fs.unlinkSync(it.path);
          // Keep every device's watch progress when the extension changes (.mkv -> .mp4)
          db.prepare('UPDATE OR IGNORE progress SET media_id = ? WHERE media_id = ?').run(mediaId(finalPath), it.id);
        }
      } else {
        const rel = path.relative(cfg.mediaDirs.find((d) => it.path.startsWith(d)) || dir, dir);
        const target = path.join(OUT, rel);
        fs.mkdirSync(target, { recursive: true });
        finalPath = path.join(target, `${stem}.mp4`);
        fs.copyFileSync(tmp, finalPath);
        fs.unlinkSync(tmp);
      }
      saved += it.size - size;
      console.log(`  ✓ ${gb(it.size)} → ${gb(size)}  (${Math.round((1 - size / it.size) * 100)}% smaller)`);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* none */ }
      console.log(`  ✗ ${e.message}`);
    }
  }
  console.log(`\nDone. Saved ${gb(saved)}.\n`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
