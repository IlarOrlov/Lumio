'use strict';
/*
 * Library compaction, driven from the admin console (Storage page).
 *
 * Each file gets the cheapest plan that actually saves space:
 *
 *  - "av1":   high-bitrate video (>= 0.06 bits/pixel/frame) -> AV1 + Opus.
 *             40-60% smaller on Blu-ray/web-dl sources.
 *  - "audio": video is already lean -> video stream copied BIT-EXACT,
 *             only audio re-encoded to Opus. Measured 12.8% (64k) / 15.2%
 *             (48k) on 140 MB SD episodes, ~25 s per episode.
 *  - none:    already compact (lean video, Opus/low-bitrate audio).
 *
 * Why not "store the bytes compressed and rebuild them"? Measured on a real
 * episode: zstd -19 --long saves 2.0%, xz -9e ~2-4%. Encoded video is close
 * to random; lossless byte-level packing can't beat a few percent, while
 * costing CPU on every play. Removing real redundancy (audio bitrate, unused
 * tracks) is where the space is.
 *
 * Every file is written to a hidden temp file, verified (length within 2 s,
 * smaller than the source, video untouched in "audio" mode), then moved into
 * place. Watch progress follows renamed files.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const media = require('./media');
const { mediaId } = require('./library');

const MIN_SIZE = 50 * 1024 * 1024;
const MIN_BPP = 0.06;
const AUDIO_PRESETS = { high: 64, compact: 48, smallest: 40 }; // kb/s per stereo pair

/** Opus bitrate for a track: preset per stereo pair, never above 75% of the source. */
function opusKbps(track, perStereo = AUDIO_PRESETS.compact) {
  const ch = Math.min((track && track.channels) || 2, 8);
  const target = ch > 2 ? Math.round((perStereo / 2) * ch * 1.25) : perStereo;
  const src = track && track.bitRate ? Math.round((track.bitRate / 1000) * 0.75) : target;
  return Math.max(ch > 2 ? 16 * ch : 32, Math.min(target, src));
}

function audioBitRate(a) { return a.bitRate || (a.channels > 2 ? 384000 : 128000); }

/** Decides the plan for one file. Exported for tests. */
function planFor(item, info, perStereo = AUDIO_PRESETS.compact) {
  if (!info.video) return null;
  const audioBps = info.audio.reduce((n, a) => n + audioBitRate(a), 0);
  const totalBps = (item.size * 8) / Math.max(1, info.duration);
  const videoBps = Math.max(0, totalBps - audioBps);
  const bpp = videoBps / Math.max(1, (info.video.width || 1) * (info.video.height || 1) * 24);

  if (info.video.codec !== 'av1' && bpp >= MIN_BPP) {
    return { plan: 'av1', estimate: 0.52 };
  }
  // Video is lean: only the audio can shrink. Worth it if we save >= 5%.
  const newAudioBps = info.audio.reduce((n, a) => n + (a.codec === 'opus' ? audioBitRate(a) : opusKbps(a, perStereo) * 1000), 0);
  const saved = (audioBps - newAudioBps) / totalBps;
  if (saved >= 0.05) return { plan: 'audio', estimate: 1 - saved };
  return null;
}

class Compactor {
  constructor({ db, catalog, log }) {
    this.db = db;
    this.catalog = catalog;
    this.log = log;
    this.reset();
  }

  reset() {
    this.state = {
      phase: 'idle', candidates: [], alreadyCompact: { count: 0, bytes: 0 },
      current: null, results: [], savedBytes: 0, error: null,
    };
    this.child = null;
    this.cancelled = false;
  }

  status() { return this.state; }

  async analyze(minSize = MIN_SIZE, perStereo = AUDIO_PRESETS.compact) {
    if (['analyzing', 'encoding'].includes(this.state.phase)) throw new Error('Already running');
    this.reset();
    this.state.phase = 'analyzing';
    const out = [];
    const skipped = this.state.alreadyCompact;
    for (const it of this.catalog().items.values()) {
      if (it.size < minSize) continue;
      let info;
      try { info = await this.catalog().probe(it); } catch { continue; }
      const p = planFor(it, info, perStereo);
      if (!p) { skipped.count += 1; skipped.bytes += it.size; continue; }
      out.push({
        id: it.id, name: path.basename(it.path), size: it.size, plan: p.plan,
        estimatedSize: Math.round(it.size * p.estimate),
        codec: info.video.codec, height: info.video.height, duration: info.duration,
        audio: info.audio.map((a) => `${a.codec} ${a.bitRate ? Math.round(a.bitRate / 1000) + 'k' : ''}`.trim()).join(', '),
        imageSubs: info.subtitles.filter((s) => !s.text).length,
      });
    }
    out.sort((a, b) => b.size - a.size);
    this.state.candidates = out;
    this.state.phase = 'ready';
    return out;
  }

  cancel() {
    this.cancelled = true;
    if (this.child) this.child.kill('SIGKILL');
  }

  /** opts: { ids, crf, preset, audioKbps, audioLangs: [], mode: 'replace'|'copy', outDir } */
  async run(opts) {
    if (this.state.phase === 'encoding') throw new Error('Already running');
    const chosen = this.state.candidates.filter((c) => opts.ids.includes(c.id));
    if (!chosen.length) throw new Error('Nothing selected');
    if (opts.mode === 'copy' && (!opts.outDir || !fs.existsSync(opts.outDir))) throw new Error('Choose an existing output folder');
    this.state.phase = 'encoding';
    this.state.results = [];
    this.state.savedBytes = 0;
    this.cancelled = false;

    for (const [n, c] of chosen.entries()) {
      if (this.cancelled) break;
      const it = this.catalog().get(c.id);
      if (!it) continue;
      this.state.current = { name: c.name, plan: c.plan, index: n + 1, total: chosen.length, percent: 0, speed: '' };
      const dir = path.dirname(it.path);
      const stem = path.basename(it.path, it.ext);
      const tmp = path.join(dir, `.${stem}.lumio-tmp.mp4`);
      try {
        const info = await this.catalog().probe(it);
        await this.encode(it.path, tmp, info, { ...opts, plan: c.plan });
        const out = await media.probe(tmp);
        const size = fs.statSync(tmp).size;
        if (Math.abs(out.duration - info.duration) > 2) throw new Error('Length check failed; original kept');
        if (size >= it.size) throw new Error('Result was not smaller; original kept');
        if (c.plan === 'audio' && (!out.video || out.video.codec !== info.video.codec || out.video.width !== info.video.width)) {
          throw new Error('Video stream changed unexpectedly; original kept');
        }
        if (opts.mode === 'replace') {
          const finalPath = path.join(dir, `${stem}.mp4`);
          fs.renameSync(tmp, finalPath);
          if (finalPath !== it.path) {
            fs.unlinkSync(it.path);
            this.db.prepare('UPDATE OR IGNORE progress SET media_id = ? WHERE media_id = ?').run(mediaId(finalPath), it.id);
          }
        } else {
          const root = this.catalog().mediaDirs.find((d) => it.path.startsWith(d + path.sep)) || dir;
          const target = path.join(opts.outDir, path.relative(root, dir));
          fs.mkdirSync(target, { recursive: true });
          fs.copyFileSync(tmp, path.join(target, `${stem}.mp4`));
          fs.unlinkSync(tmp);
        }
        this.state.savedBytes += it.size - size;
        this.state.results.push({ name: c.name, ok: true, before: it.size, after: size });
        this.log.info(`compacted (${c.plan}) ${c.name}: ${(it.size / 1e6).toFixed(0)} MB -> ${(size / 1e6).toFixed(0)} MB`);
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
        const msg = this.cancelled ? 'Cancelled' : e.message;
        this.state.results.push({ name: c.name, ok: false, message: msg });
        if (!this.cancelled) this.log.warn(`compact failed for ${c.name}: ${msg}`);
      }
    }
    this.state.current = null;
    this.state.phase = 'done';
    this.catalog().rescan();
  }

  encode(src, dst, info, opts) {
    const langs = (opts.audioLangs || []).map((s) => String(s).toLowerCase());
    const audio = info.audio.filter((a) => !langs.length || !a.language || a.language === 'und' || langs.includes(a.language.toLowerCase())).map((a) => a.index);
    if (!audio.length && info.audio.length) audio.push(0);
    const textSubs = info.subtitles.filter((s) => s.text).map((s) => s.index);
    const perStereo = Object.values(AUDIO_PRESETS).includes(Number(opts.audioKbps)) ? Number(opts.audioKbps) : AUDIO_PRESETS.compact;

    const a = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-nostats', '-progress', 'pipe:1',
      ...media.SAFE_INPUT, '-i', media.asInput(src), '-map', '0:v:0'];
    for (const i of audio) a.push('-map', `0:a:${i}`);
    for (const i of textSubs) a.push('-map', `0:s:${i}`);
    if (opts.plan === 'audio') {
      a.push('-c:v', 'copy');
      if (info.video.codec === 'hevc') a.push('-tag:v', 'hvc1');
    } else {
      const crf = Math.min(45, Math.max(18, Math.round(Number(opts.crf) || 30)));
      const preset = Math.min(12, Math.max(2, Math.round(Number(opts.preset) || 6)));
      a.push('-c:v', 'libsvtav1', '-crf', String(crf), '-preset', String(preset),
        '-pix_fmt', 'yuv420p10le', '-svtav1-params', 'tune=0:film-grain=8', '-g', '240');
    }
    if (audio.length) {
      a.push('-c:a', 'libopus', '-vbr', 'on', '-application', 'audio', '-af', 'aformat=channel_layouts=7.1|5.1|stereo|mono');
      audio.forEach((idx, n) => {
        const tr = info.audio[idx];
        if (tr && tr.codec === 'opus') a.push(`-c:a:${n}`, 'copy');
        else a.push(`-b:a:${n}`, `${opusKbps(tr, perStereo)}k`);
      });
    }
    if (textSubs.length) a.push('-c:s', 'mov_text');
    a.push('-map_metadata', '0', '-movflags', '+faststart', '-y', `file:${dst}`);

    return new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', a, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      let err = '';
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const [k, v] = line.split('=');
          if (k === 'out_time_us' && info.duration > 0) {
            this.state.current.percent = Math.min(100, (Number(v) / 1e6 / info.duration) * 100);
          } else if (k === 'speed') {
            this.state.current.speed = v.trim();
          }
        }
      });
      child.stderr.on('data', (d) => { if (err.length < 2000) err += d; });
      child.on('error', reject);
      child.on('close', (code) => {
        this.child = null;
        if (code === 0) resolve();
        else reject(new Error(err.trim().split('\n').pop() || `ffmpeg exited ${code}`));
      });
    });
  }
}

module.exports = { Compactor, MIN_SIZE, MIN_BPP, AUDIO_PRESETS, opusKbps, planFor };
