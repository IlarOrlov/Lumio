'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

// All ffmpeg/ffprobe calls use argument arrays (never a shell), the "file:"
// protocol prefix (so a filename can never be interpreted as a URL or as
// concat:/pipe: etc.), and a protocol whitelist restricted to local files.
const SAFE_INPUT = ['-protocol_whitelist', 'file'];
const asInput = (p) => 'file:' + p;

function checkFfmpeg() {
  for (const bin of ['ffmpeg', 'ffprobe']) {
    try { execFileSync(bin, ['-version'], { stdio: 'ignore' }); } catch {
      throw new Error(`${bin} not found. Install it with: sudo apt install ffmpeg`);
    }
  }
}

function run(bin, args, { timeoutMs = 60_000, maxBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let size = 0;
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) child.kill('SIGKILL'); else out.push(c);
    });
    child.stderr.on('data', (c) => { if (err.length < 4000) err += c; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${bin} exited with ${code}: ${err.trim().slice(0, 500)}`));
    });
  });
}

const TEXT_SUB_CODECS = new Set(['subrip', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);

/** Runs ffprobe and reduces the output to what the player needs. */
async function probe(filePath) {
  const buf = await run('ffprobe', [
    '-v', 'error', ...SAFE_INPUT, '-print_format', 'json',
    '-show_format', '-show_streams', asInput(filePath),
  ], { timeoutMs: 30_000 });
  const data = JSON.parse(buf.toString('utf8'));
  const streams = data.streams || [];
  const video = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const audio = streams.filter((s) => s.codec_type === 'audio');
  const subs = streams.filter((s) => s.codec_type === 'subtitle');
  const tag = (s, k) => (s.tags && (s.tags[k] || s.tags[k.toUpperCase()])) || '';
  return {
    duration: Number(data.format && data.format.duration) || 0,
    container: (data.format && data.format.format_name) || '',
    video: video ? {
      codec: video.codec_name, profile: video.profile || '', pixFmt: video.pix_fmt || '',
      width: video.width, height: video.height,
    } : null,
    audio: audio.map((s, i) => ({
      index: i, codec: s.codec_name, channels: s.channels || 2,
      language: tag(s, 'language'), title: tag(s, 'title'),
      default: !!(s.disposition && s.disposition.default),
    })),
    subtitles: subs.map((s, i) => ({
      index: i, codec: s.codec_name, language: tag(s, 'language'), title: tag(s, 'title'),
      text: TEXT_SUB_CODECS.has(s.codec_name),
    })),
  };
}

const BROWSER_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

/**
 * Decides how a file reaches the browser:
 *  - direct:    served byte-for-byte with HTTP range support
 *  - remux:     video copied, audio converted to AAC, wrapped in fragmented MP4
 *  - transcode: video re-encoded to H.264 (HEVC, 10-bit, etc.)
 */
// Codecs a client may report it can decode (via MediaSource/canPlayType).
// H.264 8-bit is assumed universal; the rest are passed through untouched only
// when the requesting device says it supports them.
const OPTIONAL_CODECS = new Set(['av1', 'hevc', 'vp9']);

function parseCaps(str) {
  return new Set(String(str || '').split(',').map((s) => s.trim()).filter((s) => OPTIONAL_CODECS.has(s)));
}

function playbackPlan(item, info, audioIndex = 0, caps = new Set()) {
  const v = info.video;
  const a = info.audio[audioIndex] || info.audio[0];
  const h264ok = v && v.codec === 'h264' && !/10|4:2:2|4:4:4/.test(v.profile) && !/10le|12le|422|444/.test(v.pixFmt);
  const videoOk = h264ok || (v && caps.has(v.codec) && !/422|444|12le/.test(v.pixFmt));
  const audioOk = !a || BROWSER_AUDIO.has(a.codec);
  const mp4ish = ['.mp4', '.m4v', '.mov'].includes(item.ext);
  const webmOk = item.ext === '.webm' && v && ['vp8', 'vp9', 'av1'].includes(v.codec) && (!a || ['opus', 'vorbis'].includes(a.codec));

  const videoMode = videoOk ? 'copy' : 'transcode';
  const firstAudio = audioIndex === 0 || info.audio.length <= 1;
  if (((mp4ish && videoOk && audioOk) || webmOk) && firstAudio) return { mode: 'direct' };
  return { mode: videoMode === 'copy' ? 'remux' : 'transcode', videoMode, codec: v ? v.codec : null };
}

/** Finds the keyframe at or before t so copied streams start exactly where we report. */
async function keyframeBefore(filePath, t) {
  if (t <= 0) return 0;
  const start = Math.max(0, t - 15);
  try {
    const buf = await run('ffprobe', [
      '-v', 'error', ...SAFE_INPUT, '-select_streams', 'v:0', '-skip_frame', 'nokey',
      '-read_intervals', `${start}%${t + 0.01}`, '-show_entries', 'frame=pts_time,best_effort_timestamp_time',
      '-of', 'csv=p=0', asInput(filePath),
    ], { timeoutMs: 15_000 });
    const times = buf.toString().split('\n')
      .map((l) => Number(l.split(',').find((x) => x && x !== 'N/A')))
      .filter((n) => Number.isFinite(n) && n <= t + 0.01);
    return times.length ? Math.max(...times) : t;
  } catch {
    return t;
  }
}

/** Spawns ffmpeg producing a fragmented MP4 stream starting at `start` seconds. */
function spawnStream(filePath, { start = 0, videoMode = 'copy', codec = null, audioIndex = 0, hasAudio = true }) {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', ...SAFE_INPUT,
    '-ss', String(start), '-i', asInput(filePath),
    '-map', '0:v:0',
  ];
  if (hasAudio) args.push('-map', `0:a:${audioIndex}?`);
  if (videoMode === 'copy') {
    args.push('-c:v', 'copy');
    if (codec === 'hevc') args.push('-tag:v', 'hvc1'); // required by Safari/Apple TV
  } else {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
      '-vf', "scale='min(1920,iw)':-2", '-g', '96');
  }
  if (hasAudio) args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k');
  args.push('-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
  return spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
}

/** Extracts a subtitle track (embedded index or sidecar file) as WebVTT, shifted to start. */
function spawnSubtitles(source, { start = 0, embeddedIndex = null }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...SAFE_INPUT,
    '-ss', String(start), '-i', asInput(source)];
  args.push('-map', embeddedIndex === null ? '0:s:0' : `0:s:${embeddedIndex}`, '-f', 'webvtt', 'pipe:1');
  return spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
}

/** Generates (once) a cached JPEG thumbnail for an item. */
async function thumbnail(item, durationSec, cacheDir) {
  const out = path.join(cacheDir, `${item.id}.jpg`);
  try {
    const st = fs.statSync(out);
    if (st.mtimeMs >= item.mtime) return out;
  } catch { /* not cached yet */ }
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const at = durationSec > 0 ? Math.min(durationSec * 0.15, 600) : 30;
  const tmp = `${out}.${process.pid}.tmp.jpg`;
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', ...SAFE_INPUT,
    '-ss', String(at), '-i', asInput(item.path), '-frames:v', '1',
    '-vf', 'scale=480:-2', '-q:v', '4', '-y', tmp,
  ], { timeoutMs: 30_000 });
  fs.renameSync(tmp, out);
  return out;
}

module.exports = { checkFfmpeg, probe, playbackPlan, parseCaps, SAFE_INPUT, asInput, run, keyframeBefore, spawnStream, spawnSubtitles, thumbnail };
