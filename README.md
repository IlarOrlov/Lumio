<p align="center"><img src="public/icon.svg" width="96" alt="Lumio"></p>

<h1 align="center">Lumio</h1>
<p align="center"><b>Your home cinema, on every screen in the house.</b><br>
A tiny, security-first streaming server for your own movies and series, with per-device resume.<br>
Set up and run entirely from a desktop icon and a web admin console, with no terminal needed.</p>

---

- **Plays MKV & MP4 anywhere.** Phones, tablets, laptops and smart-TV browsers. Compatible files are
  served directly, MKVs are remuxed on the fly, and only unplayable codecs get transcoded.
- **Every device remembers.** Open Lumio and "Continue watching on *Living room TV*" is the first
  thing you see. Finished an episode? The next one is waiting as *Up next*, with auto-play.
- **Point-and-click admin console.** Setup wizard, folder picker, devices and their history,
  network and certificate settings, autostart, storage compaction and logs.
- **Locked down.** HTTPS, scrypt, hashed session tokens, CSRF + Origin checks, strict CSP, LAN-only
  allowlist, DNS-rebinding guard, loopback-only admin console, sandboxed ffmpeg.
  [Details →](docs/DESIGN.md#6-security-model)
- **Storage-efficient.** Plays files in place with no copies or disk cache. *Slim audio* shrinks
  files ~15 % with the video stream kept bit-exact; AV1 re-encode for high-bitrate files. [Details →](docs/DESIGN.md#5-storage-efficiency)
- **Zero npm dependencies.** Just Node.js ≥ 22.13 and ffmpeg.

## Install (Ubuntu desktop, one time)

1. Install **ffmpeg** (Ubuntu Software, or `sudo apt install ffmpeg`) and **Node.js 22+**.
2. Download this repository (green **Code** button → *Download ZIP*, then extract it, or `git clone`).
3. In the Files app, open the `launcher` folder, right-click **`install.sh`** → **Run as a Program**.
   A **Lumio** icon appears on your desktop and in the app menu.

## Use

Double-click **Lumio**. It starts in the background and opens the **admin console** in your browser:

- **First time:** a 3-step wizard asks for a household password, your video folders (click to browse)
  and your PC's address. That's all.
- **Overview** shows the address to open on your phone/TV (e.g. `https://192.168.1.20:8443`),
  start/stop, and a switch to *start automatically with the computer*.
- **Library**: add/remove folders, rescan. **Devices**: rename, remove, view watch history.
  **Network & Security**: address, port, HTTPS certificate, password. **Storage**: shrink files.
  **Logs**: what's happening.
- **Quit Lumio** is at the bottom of the sidebar.

On each phone/TV: open the address, accept the one-time certificate warning, enter the password and
give the device a name. Each device keeps its own history.

### Library layout

```
Videos/Movies/Inception (2010).mkv
Videos/Series/The Mentalist/Season 1/The Mentalist S01E01.mp4    (+ ...S01E01.ru.srt)
```

Episodes are recognised by `S01E02` (or `1x02`). Release tags (`1080p`, `x264`, …) are ignored.
Optional `poster.jpg` in a folder is used as its cover.

## Running inside a VMware VM (NAT)

With the VM on **NAT**, other devices can't reach the VM directly, so the Windows PC has to forward
a port. **Automatic (recommended):** on the Windows PC open `https://<VM-IP>:8443` (the VM's
address is shown in the admin console), sign in, go to **Settings → Download Windows setup helper**
and double-click `Lumio-Windows-Setup.cmd`. After asking for admin rights it:

- adds the VMware NAT port forward and restarts the VMware NAT service
- adds a firewall rule for **Private networks and your local subnet only**
- offers to remove old "block" rules for VMware NAT and to switch your Wi-Fi to *Private*
- detects the PC's home-network IP and reports it to Lumio (single-use token, TLS pinned to Lumio's
  certificate), so Lumio's address and certificate update automatically
- prints the address to open on your phone

**Manual alternative** (also shown in the admin console with your addresses filled in):

1. **VMware Workstation → Edit → Virtual Network Editor → Change Settings → VMnet8 (NAT) →
   NAT Settings… → Add**: host port `8443`, TCP, VM IP (shown in the console), VM port `8443`.
2. Allow the Windows firewall prompt for **Private networks only**, and make sure your home Wi-Fi is
   a *Private* network in Windows.
3. Enter your Windows PC's IP (`ipconfig`) in *Network & Security*. Lumio renews its certificate
   to match.
4. On a phone open `https://<Windows-PC-IP>:8443`.

> Never forward this port on your internet router. Lumio is built for your home network only.

## For developers

```bash
npm test     # 23 tests: security pipeline, per-device progress, admin console, parsing
npm start    # run in the foreground instead of via the launcher
```

The launcher runs Lumio as a `systemd --user` service (`journalctl --user -u lumio` for logs).
`deploy/lumio.service` is a hardened system-wide unit for headless servers.

## Docs

- [Design & architecture](docs/DESIGN.md): per-device tracking, playback pipeline, storage efficiency, security model
- [Security policy](SECURITY.md)

## License

MIT
