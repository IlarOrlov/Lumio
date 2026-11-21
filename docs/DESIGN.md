# Lumio — Design

Lumio is a self-hosted streaming server for a household. It plays your own
movie and series files (MKV, MP4, WebM, MOV) in the browser of any device on
your home network, and every device keeps its own watch history with
one-tap resume.

This document records the concepts and decisions behind it.

---

## 1. Goals, non-goals, anti-goals

**Goals**

- Watch your own files on any device on your LAN: phone, tablet, laptop, smart TV browser.
- **Instant resume per device.** Every device has its own history. The home screen opens with
  "Continue watching on *this device*". There's no searching to find where you left off.
- **Series-aware.** After an episode ends, the next one is offered and auto-starts, and it
  appears in Continue watching as "Up next".
- **Security first.** It's safe to run on a network you don't fully control (guests, IoT devices).
- **Storage-efficient.** No duplicate copies, a tiny metadata footprint, and an optional tool that
  shrinks the library by roughly half.
- **Zero third-party runtime dependencies.** Only Node.js built-ins and ffmpeg.

**Non-goals**

- Internet or remote access (deliberately out of scope; see §6).
- Downloading or acquiring content. Lumio only plays files you already have.
- Multi-user accounts with separate permissions. There's one household password, and
  separation happens per device.
- Online metadata scraping (posters and plots from TMDB etc.). That needs an API key and outbound
  calls, so local files and folder posters are used instead.

**Anti-goals (would count as failure even if it "works")**

- Any path from user input to the filesystem (path traversal).
- Any way for a web page you visit elsewhere to act on Lumio (CSRF, DNS rebinding).
- Transcoding everything by default and pinning the CPU.
- A pile of npm packages that each become an update and supply-chain liability.

---

## 2. Architecture

```
 Phone / TV / Laptop (browser)
        │  HTTPS (Lumio home CA, TLS 1.3 / 1.2 AEAD), https://lumio.local:8443
        ▼
 Windows host :8443 ── VMware NAT port forward ──▶ Ubuntu VM 192.168.204.128:8443
                                                       │
                                     ┌─────────────────┴─────────────────┐
                                     │ Lumio (Node.js, unprivileged user)│
                                     │  netguard → host guard → auth →    │
                                     │  CSRF → router                     │
                                     ├───────────┬───────────┬────────────┤
                                     │ Catalog   │ Progress  │ Sessions   │
                                     │ (scan +   │ (per      │ (devices,  │
                                     │  ffprobe) │  device)  │  tokens)   │
                                     └─────┬─────┴─────┬─────┴─────┬──────┘
                                           │     SQLite (data/lumio.db)
                                           ▼
                                  ffmpeg / ffprobe (spawned, no shell)
                                           │
                                  Media folders (read-only)
```

| Module | Responsibility |
|---|---|
| `src/server.js` | Boot: refuse root, load config, open DB, scan, start HTTP(S) with timeouts |
| `src/app.js` | Request pipeline and all routes |
| `src/auth.js` | scrypt password hashing, global login limiter, device sessions |
| `src/netguard.js` | Source-IP allowlist (CIDR) and Host-header allowlist |
| `src/library.js` | Filesystem scan, filename parsing, series grouping, next episode |
| `src/catalog.js` | In-memory library + persisted ffprobe cache, background probing |
| `src/progress.js` | Per-device positions, completion rule, Continue watching |
| `src/media.js` | ffprobe/ffmpeg wrappers, playback planning, thumbnails, subtitles |
| `src/http-util.js` | Security headers, cookies, bounded JSON bodies, static whitelist, range serving |
| `public/` | Framework-free web client (CSP-compatible, no inline script) |
| `src/runtime.js` | Owns DB + streaming listener; start/stop/reconfigure without a process restart |
| `src/admin.js` | Admin console API (loopback only): wizard, config, devices, cert, autostart, compaction, logs |
| `src/service.js` | `systemd --user` autostart / linger / quit |
| `src/tls.js` | Name-constrained home CA + server certificate issuance/renewal (openssl), inspection (`X509Certificate`) |
| `src/mdns.js` | Minimal mDNS responder: answers `lumio.local` with the current IPv4 address |
| `src/netinfo.js` | Detects VMware/VirtualBox NAT from the default gateway's MAC, so the console can recommend Bridged |
| `src/compact.js` | AV1 compaction job with progress and verification |
| `src/log.js` | Logger + in-memory ring buffer for the console's Logs page |
| `admin/` | Admin console UI (CSP-compatible, no inline script) |
| `launcher/` | `install.sh` (desktop icon + menu entry), `lumio.sh` (start service, open console) |

---

## 2a. Admin console & launcher (no terminal)

Everything is configured from a browser UI. Nothing needs the command line.

```
Desktop icon "Lumio" ─▶ launcher/lumio.sh
                          ├─ writes ~/.config/systemd/user/lumio.service (absolute node path, sandbox options)
                          ├─ systemctl --user start lumio        (no root, runs in background)
                          ├─ asks data/admin.sock (unix socket, 0600 in a 0700 dir) for a key:
                          │     256-bit, single-use, expires in 60 s
                          └─ xdg-open http://127.0.0.1:8442/#key=<token>
Browser ─▶ admin console (loopback only) ─ exchanges key for a session cookie ─ strips key from URL
```

| Page | What it does |
|---|---|
| **Setup wizard** (first run) | Password → media folders (folder browser) → port (Windows host IP only for VMware NAT), then generates the certificate and starts streaming |
| **Overview** | Address to open on devices, streaming status, start/stop/restart, library stats, live conversions, *start automatically* toggle (systemd user unit + linger), quit |
| **Library** | Add/remove media folders via folder picker, rescan, list of series and movies, naming guide |
| **Devices** | Every signed-in device with last activity and watch history; rename / remove |
| **Network & Security** | Local name (`lumio.local`), port, HTTPS, Windows host IP (NAT only), home CA download + fingerprint + per-platform install steps, server certificate (SANs, expiry, fingerprint, renew, download), household password (+ sign out everywhere), allowed networks / hostnames, session length, transcode limit, rescan interval; Bridged guide when NAT is detected, Windows helper as fallback |
| **Storage** | Analyze → choose files → AV1 compaction with live progress, speed, cancel and per-file results |
| **Logs** | Live tail of the server log |

**Windows setup helper (VMware NAT).** Phones can only reach a NAT'd VM through a port forward on
the Windows host, which the VM can't configure itself. Lumio therefore generates
`Lumio-Windows-Setup.cmd` (viewer *Settings*, or the admin console): a self-elevating batch file with
embedded PowerShell. It edits `%ProgramData%\VMware\vmnetnat.conf` (`[incomingtcp]`, with a one-time
backup), restarts the VMware NAT service, and adds a firewall rule limited to the Private profile and
LocalSubnet. It offers to remove inbound *block* rules for `vmnat.exe` (they override allow rules) and
to switch a Public home network to Private. Finally it POSTs the PC's LAN IP to `/api/host-report`
with a **single-use, 2-hour token** baked into that download, over TLS **pinned to Lumio's
certificate SHA-256**. If the helper came from the admin console, Lumio stores the address, renews
its certificate (adding the address to the existing names) and restarts streaming. If it was
downloaded by a signed-in viewer device, the address is only **proposed**, and the owner applies it
with one click on the admin Overview. Household devices can run the Windows-side setup but can't
change server settings. Every value in the script is generated from validated data (IPv4 literal, integer port,
hex fingerprint, base64url token); nothing user-supplied is interpolated.

Settings apply immediately: `Runtime` restarts the streaming listener in-process. Device sessions
and the database are untouched, so phones stay signed in.

## 3. Per-device watch tracking

- **Device = session.** Signing in registers a *device* with a name ("Living room TV").
  Its session cookie lasts 180 days (configurable), so TVs stay signed in.
- **Progress rows** are keyed `(device_id, media_id)` and hold position, duration, completed and
  updated_at. The player saves every 5 s of playback, on pause, when the tab is hidden, and on page
  unload (`fetch keepalive`).
- **Completion rule:** watched at ≥ 92 %, or at ≥ 85 % with ≤ 2 min left (credits).
  Restarting a finished title from the beginning puts it back in progress.
- **Continue watching** (newest first, one entry per series):
  - unfinished titles past 15 s;
  - for a series whose latest watched episode is finished, the **next episode** marked "Up next".
- **Resume** is automatic: opening a title continues from the saved position.
- **History** page: everything this device has watched, with mark watched/unwatched.
- Revoking a device in Settings signs it out everywhere and deletes its history.
- `media_id` is a hash of the file path. Storage compaction migrates progress when it
  renames `.mkv` → `.mp4`.

---

## 4. Playback pipeline

Every play request is planned per file **and per device**:

| Plan | When | Server cost |
|---|---|---|
| **direct** | MP4/MOV with H.264 8-bit (or AV1/HEVC/VP9 the device reports it can decode) and browser-safe audio; WebM VP9/AV1 + Opus | ~0 CPU: bytes served with HTTP Range |
| **remux** | Video codec playable but container/audio isn't (typical MKV H.264 + AC3/DTS) | Very low: video copied, audio → AAC, fragmented MP4 |
| **transcode** | Video not playable (HEVC on a device without HEVC, 10-bit H.264, MPEG-2…) | High: libx264 veryfast, capped at 1080p, limited by `maxTranscodes` |

- **Device capability detection:** the client probes `MediaSource.isTypeSupported` for AV1, HEVC and
  VP9 and sends `caps=` with each request. Modern devices then receive AV1/HEVC untouched
  instead of being transcoded.
- **Seeking streamed (remux/transcode) files:** the client asks `/api/media/:id/seek?t=` and the
  server returns the exact keyframe time at or before `t`. The stream restarts there, and the client
  keeps `offset + video.currentTime` as the real position, so the seek bar and saved progress are
  exact.
- **Subtitles:** embedded text tracks (SRT/ASS/mov_text) and sidecar `.srt`/`.vtt` files are
  converted to WebVTT on demand and shifted to match the stream offset. Image subtitles (PGS/VobSub)
  aren't supported in the browser.
- **Multiple audio tracks:** selectable in the player (switches to remux for the chosen track).
- **Thumbnails:** a `poster.jpg`/`folder.jpg`/`<name>.jpg` next to the file wins. Otherwise one frame
  is extracted once at 15 % (480 px JPEG, ~20–40 KB) and cached in `data/thumbs/`.

---

## 5. Storage efficiency

How compact the storage is splits into two parts: what Lumio itself stores, and how small the media
can be made.

### 5.1 Lumio's own footprint — near zero

- **Files are played in place.** No import, no copy, no library database of video data. Your
  folders stay the source of truth, so you can add, rename or delete files and the next scan (every
  15 min, or Settings → Rescan) picks it up.
- **No transcode cache on disk.** Remux and transcode stream straight from ffmpeg's stdout to the
  socket, so the disk cost is 0.
- **Metadata in one SQLite file** (WAL mode): devices, sessions, progress rows (~100 bytes each) and
  ffprobe results (~1 KB per file). A 2,000-file library comes to a few MB.
- **Probe cache** keyed by size and mtime, so files are probed once, not on every start.
- **Thumbnails** are ~30 KB each and generated lazily, only when a card is shown.

### 5.2 Making the library itself small — admin console → Storage

#### First question: can the bytes be packed and rebuilt losslessly?

Measured on a real 144 MB episode (H.264 + AAC in MP4):

| Lossless method | Saving |
|---|---|
| zstd -19 --long=27 (whole file) | **2.0 %** |
| xz -9e (first 40 MB, includes the MP4 index) | 4.2 % |

Encoded video is entropy-coded: its bytes are already close to random, so general-purpose compressors
find almost nothing. A "pack the bytes and rebuild them on play" store would save about 2 %, cost CPU
on every play and make seeking harder. It isn't worth it. (Re-modelling the H.264 entropy coding
losslessly, the way Lepton does for JPEG, is research-grade and not available as a robust tool.)

The redundancy that *is* left in typical files is (a) audio coded at much higher bitrates than modern
codecs need, (b) unused dub tracks, and (c) on high-bitrate sources, the video codec itself. So the
Storage page picks a **plan per file**:

| Plan | When | What happens | Measured |
|---|---|---|---|
| **Slim audio** | Video is already lean (< 0.06 bits/pixel/frame) but audio isn't | Video stream copied **bit-exact** (verified: identical MD5 of the video stream before/after). Audio re-encoded to Opus at 64 / **48** / 40 kb/s per stereo pair (never above 75 % of the source) | 144 MB → 122 MB (**-15.2 %**) at 48k, 25 s per episode (≈ 90× real-time); 70 episodes: 9.21 GB → ≈ 7.85 GB |
| **AV1 re-encode** | Video ≥ 0.06 bits/pixel/frame (Blu-ray / web-dl / 1080p+ rips) | AV1 (SVT-AV1) + Opus, see below | 40–60 % smaller |
| none | Lean video and Opus/low-bitrate audio | Listed as "already compact" | — |

A plan is only offered if it saves at least 5 %.

**AV1 settings:**

| Choice | Why |
|---|---|
| **AV1 video (SVT-AV1)**, CRF 30, preset 6, 10-bit, film-grain synthesis | ~40–60 % smaller than H.264 and ~20–30 % smaller than HEVC at similar quality. Royalty-free and widely hardware-decoded since ~2020. 10-bit avoids banding at no cost. Grain synthesis stops film grain wasting bits. |
| **Opus audio** | Transparent at roughly half the bitrate of AAC/AC3. DTS/TrueHD tracks are often 1.5–4 GB alone. |
| **MP4 container with `+faststart`** | Direct-playable with HTTP Range: zero server work at playback. |
| **Text subtitles → mov_text** | Kept inside the file and served to the player as WebVTT. |
| **"Keep only these audio languages"** (e.g. `rus,eng`) | Drops dub tracks you never use, often 0.5–1 GB per film. Tracks tagged `und` are always kept. |

**When AV1 does *not* pay off (measured):** the same 704×400 / 320 kb/s episode (≈ 0.05 bits/pixel)
re-encoded to AV1 came out **8 % larger** at CRF 30 and only 11 % smaller at CRF 34, with visible
softening. That's why low-bpp files get *Slim audio* instead.

**Playback of Opus files:** each device reports whether it can play Opus-in-MP4 (`caps=opus`).
Devices that can get the file directly. Others get the video copied and the audio converted to AAC
on the fly, which costs almost no CPU. Nothing becomes unplayable.

**Safety:** analysis first (per-file plan, current codecs, estimated size), you pick the files. Each
file is encoded to a hidden temp file and verified: duration within 2 s, smaller than the source, and
for Slim audio the video codec and size unchanged. Only then is it moved into place, either
replacing the original or written to another folder. Watch progress follows renamed files. Live
progress, speed and cancel.

### 5.3 Further storage ideas (not implemented)

- **Deduplication:** detect identical files by size and partial hash across folders.
- **Btrfs/ZFS with zstd** gives no gain on video (already compressed). It only helps metadata.
- **Tiering:** keep in-progress series on SSD and archive finished seasons to HDD.

---

## 6. Security model

**Threats considered:** other devices on the LAN (guests, compromised IoT), malicious web pages
opened on a household device (CSRF, DNS rebinding), password guessing, crafted filenames, and
resource exhaustion.

| Control | Implementation |
|---|---|
| **Network allowlist** | Only private ranges (RFC 1918, loopback, ULA, link-local) by default. Public IPs get 403 before any parsing. |
| **Not exposed to the internet** | No router port forward is needed or wanted. Recommended VM networking is *Bridged* (nothing changes on the Windows host). With NAT: one VMware forward + a Windows firewall rule scoped to the Private profile and local subnet. |
| **Local name** | `lumio.local` via a built-in mDNS responder (RFC 6762). Answers only A/ANY questions for exactly its name, only to private/link-local senders, with bounds-checked parsing (no compression loops, size cap). It answers with the address on the asker's subnet and re-announces when the IP changes, so devices keep finding Lumio after DHCP changes. Conflicts with another host using the name are detected and shown in the console. |
| **TLS** | HTTPS by default. TLS 1.3 preferred; TLS 1.2 only with ECDHE + AEAD suites (AES-GCM, ChaCha20-Poly1305); X25519/P-256 key exchange; HSTS 2 years. ECDSA P-256 keys, SHA-256 signatures. |
| **Certificates** | Lumio runs its own **home CA** (10 years, key mode 600) and issues a server certificate (397 days) for `lumio.local`, `localhost` and the machine's current IPs. The CA is **name-constrained** (critical `nameConstraints`): it may only sign for Lumio's own names and private/loopback IP ranges, so installing it on a phone can't be abused to intercept real websites (verified: a CA-signed `www.google.com` certificate fails with *permitted subtree violation*). The server certificate is re-issued automatically when the IP changes or 30 days before expiry and hot-swapped without a restart; the CA stays, so devices install it only once. `/lumio.crt` serves the CA's public certificate; its fingerprint is shown in the console for out-of-band checking. |
| **Password** | One household password, ≥ 12 chars, stored as **scrypt** (N=2¹⁵, r=8, p=1, 16-byte salt). Constant-time compare. Config file is mode 600. |
| **Brute-force** | Global limiter: 8 failures in 15 min locks login, 1 min doubling to 1 h. It's global because VMware NAT makes every client share one source IP. |
| **Sessions** | 256-bit random tokens. **Only SHA-256 hashes are stored**, so a DB leak doesn't yield live sessions. Cookie: `__Host-` prefix, `HttpOnly`, `Secure`, `SameSite=Strict`. Expiring, revocable per device. |
| **CSRF** | Every POST needs a per-session CSRF token header plus a matching `Origin`/`Sec-Fetch-Site`. Bodies must be `application/json` (forces a CORS preflight that's never granted). |
| **DNS rebinding** | Host header must be an IP literal, `localhost`, or listed in `allowedHosts`, otherwise 421. |
| **XSS** | Strict CSP: `default-src 'none'`, `script-src 'self'`, no inline script or style, `frame-ancestors 'none'`, `worker-src 'none'`, and **Trusted Types enforced with no policies** (`require-trusted-types-for 'script'; trusted-types 'none'`), so `innerHTML`/`eval`-style sinks are disabled outright. The client renders server data with `textContent` only. |
| **Path traversal** | Clients only ever send opaque IDs (20 hex chars). Files are looked up in the scanned map. Static assets are an in-memory whitelist loaded at boot. Symlinks pointing outside media folders are ignored. File paths are never sent to clients. |
| **ffmpeg hardening** | `spawn` with argument arrays (no shell), `file:` prefix on every input (a filename can't become `http:`, `concat:`, `pipe:`), `-protocol_whitelist file`, numeric params validated and clamped, processes killed when the client disconnects. |
| **Resource limits** | Concurrent transcodes capped (`maxTranscodes`). JSON bodies ≤ 16 KB. URL ≤ 2 KB. Header/request/keep-alive timeouts (slowloris). `maxConnections`. Only GET/HEAD/POST. |
| **Headers** | nosniff, `X-Frame-Options DENY`, `Referrer-Policy no-referrer`, COOP/CORP same-origin, `COEP require-corp`, `Origin-Agent-Cluster`, Permissions-Policy denying camera/mic/location/USB/serial/HID/MIDI/sensors/screen capture, `noindex`. |
| **Admin devices** | Viewer Settings endpoints (`/api/devices*`, `/api/rescan`, `/api/windows-helper`) return 403 unless the session's device has `is_admin`. Adminship is set only from the admin console. Name-based re-attachment (used to keep history after signing out) never applies to admin devices, and a new sign-in that uses an admin device's name gets a distinct name, so the household password alone can't inherit admin rights. Admin devices can be removed only from the console (or by themselves). |
| **Admin console isolation** | Separate listener bound to `127.0.0.1` only (never on the LAN); remote-address check as well. Unlocked by a 256-bit key that is **single-use and expires after 60 s**, issued only over an owner-only unix socket (so only the same OS user can get one). It briefly appears in the browser's command line, which other local users could read, but by then it's consumed or expired. It travels in the URL fragment (never sent in requests or logged) and is swapped for an `HttpOnly; SameSite=Strict` session cookie. POSTs need CSRF token + exact `Origin`; `Host` must be `127.0.0.1`/`localhost` (DNS rebinding). The password hash is never sent to the browser. Media folders can't be system directories; allowed networks can't be `0.0.0.0/0`. |
| **Windows helper** | Download requires a signed-in device (viewer) or the admin console. The host-report endpoint accepts only a single-use, 2 h token and a private IPv4 address; the IP is validated before the token is consumed. Viewer-issued tokens can only *propose* an address (owner confirms in the admin console); only admin-issued tokens apply directly. The helper pins Lumio's certificate fingerprint, so it can't be tricked into reporting to another server. Firewall rule: Private profile and LocalSubnet only. Minimal footprint on the Windows drive: no backup copies, logs or temp files, PowerShell module cache disabled (`PSModuleAnalysisCachePath=NUL`), an **Undo** mode that removes the NAT line and firewall rule, and an offer to delete itself at the end. |
| **Least privilege** | Refuses to run as root. umask 077. The systemd unit adds `NoNewPrivileges`, `ProtectSystem=strict`, read-only media, private /tmp, syscall filtering, capability drop and address-family restriction. |
| **Supply chain** | Zero npm runtime dependencies. Only Node built-ins (`node:sqlite`, `node:crypto`, …) and the distro's ffmpeg. |
| **Secrets in a public repo** | `config/lumio.json`, `config/tls/` and `data/` are git-ignored. Only `lumio.example.json` is committed. |

**Accepted risks**

- Devices that don't install the home CA see a certificate warning and must click through it,
  which can't distinguish Lumio from an impostor. Install the CA (Network & Security) on devices
  you use regularly.
- `.local` names need mDNS on the client. Most phones, tablets and computers have it; some older
  smart TVs don't and must use the IP address (a DHCP reservation on the router keeps it fixed).
- Data at rest (watch history, device names) isn't encrypted; it holds nothing secret, and the
  data directory is owner-only (700).
- Anyone with the household password can revoke other devices. That fits a household trust model.
- The global login lock can be triggered by a hostile LAN device (a lock-out, not a breach).
- ffmpeg parses untrusted media. Keep it updated (`sudo apt upgrade`). The systemd sandbox limits
  the blast radius.

---

## 7. Library conventions

```
Movies/
  Inception (2010).mkv
  The Matrix (1999)/The.Matrix.1999.1080p.mkv   + poster.jpg (optional)
Series/
  Dark/Season 1/Dark S01E01.mkv                  + Dark S01E01.en.srt (optional)
  Breaking.Bad.S02E05.Breakage.720p.mkv
```

Episodes are detected by `S01E02` or `1x02`. The show name comes from the filename, or from the
folder above `Season N`. Release junk (`1080p`, `x264`, `BluRay`, …) is stripped from titles.

---

## 8. Left to the builder / future work

- HLS output for smoother seeking on very slow devices.
- QR-code install flow for the home CA.
- Access from outside the home (a public domain, port 443, ACME certificate and a second factor) is deliberately not built in.
- Optional per-device PIN for kids' devices.
- Hardware transcoding (VAAPI/NVENC) when the VM has GPU passthrough.
