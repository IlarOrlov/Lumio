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
- **Skip intro.** Lumio compares the audio of episodes in each season, finds the parts that repeat
  (title sequence, studio logo, opening theme) and shows a *Skip intro* button. Adjust any episode
  in the admin console (Library → Skip intro).
- **Point-and-click admin console.** Setup wizard, folder picker, devices and their history,
  network and certificate settings, autostart, storage compaction and logs.
- **Found by name.** Devices open `https://lumio.local:8443`, which keeps working when the IP
  address changes (built-in mDNS responder, home network only).
- **Locked down.** TLS 1.3 with its own name-constrained home certificate authority (no warnings
  once installed, can't vouch for real websites), scrypt, hashed session tokens, CSRF + Origin
  checks, strict CSP with Trusted Types, LAN-only allowlist, DNS-rebinding guard, loopback-only
  admin console, sandboxed ffmpeg.
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
- **Overview** shows the address to open on your phone/TV (`https://lumio.local:8443`, plus the IP
  address for devices that can't use `.local` names), start/stop, and a switch to *start
  automatically with the computer*.
- **Library**: add/remove folders, rescan. **Devices**: rename, remove, view watch history.
  **Network & Security**: address, port, HTTPS certificate, password. **Storage**: shrink files.
  **Logs**: what's happening.
- **Quit Lumio** is at the bottom of the sidebar.

### Signing a device in

1. Open `https://lumio.local:8443` in the device's browser (or the IP address shown on Overview).
2. Certificate warning? Either click *Advanced* → *Proceed*, or install Lumio's certificate once
   (link on the sign-in page; steps for each platform in *Network & Security*) and the warning is
   gone for good.
3. **Household password**: the password chosen in the setup wizard on the Lumio computer. It isn't
   a Windows, Wi-Fi or email password. Forgot it? Set a new one in *Network & Security*.
4. **Name for this device**: any label, e.g. `Living room TV` or `Phone`. It only keeps this
   device's watch history apart from the others. Signing in again with the same name reattaches
   that history.

*Devices* in the admin console lists every signed-in device; **Remove all devices** signs them all
out and deletes their history.

### Who can change settings

- The **admin console** opens only on the Lumio computer itself (loopback-only, unlocked by the
  desktop icon). No other device can reach it.
- In Lumio, **Settings** (device list, signing out other devices, rescans, the Windows helper) is
  available only on **admin devices**. Other devices can watch, and see just their own name and a
  sign-out button. The server enforces this, so hiding the menu isn't the only protection.
- Make a device an admin in the admin console → *Devices* → **Make admin**. Knowing the household
  password isn't enough: signing in with an admin device's name creates a separate, ordinary device
  (e.g. "Linux PC 2"). If an admin device signs out, make it admin again after it signs back in.

### Library layout

```
Videos/Movies/Inception (2010).mkv
Videos/Series/The Mentalist/Season 1/The Mentalist S01E01.mp4    (+ ...S01E01.ru.srt)
```

Episodes are recognised by `S01E02` (or `1x02`). Release tags (`1080p`, `x264`, …) are ignored.
Optional `poster.jpg` in a folder is used as its cover.

## Running inside a VMware VM

**Recommended: Bridged networking (nothing to install on Windows).** In VMware select the VM →
*VM → Settings → Network Adapter* → **Bridged: Connected directly to the physical network** → OK.
The VM then gets its own address on your home network, `lumio.local` works for every device, and
Lumio updates its certificate to the new address by itself. This changes only the VM's own settings
file; Windows itself is not modified. The admin console detects VMware NAT and shows these steps.

**Only if you must keep NAT:** the VM is hidden behind the Windows PC, which has to forward a
port. On the Windows PC open the Lumio address, sign in, go to **Settings → Download Windows
helper**, save it to a USB stick or non-system drive, and run it. After asking for admin rights it
offers *Set up* or *Undo*. Set up:

- adds one VMware NAT port forward line and restarts the VMware NAT service
- adds one firewall rule for **Private networks and your local subnet only**
- offers to remove old "block" rules for VMware NAT and to switch your Wi-Fi to *Private*
- reports the PC's home-network IP to Lumio (single-use token, TLS pinned to Lumio's certificate);
  confirm it with **Apply** on the admin console's Overview

It writes no backups, logs, temp files or PowerShell caches, and offers to delete itself when done.
*Undo* removes the forward and the firewall rule again. `lumio.local` doesn't work through NAT, so
devices use `https://<Windows-PC-IP>:8443` in this mode.

**Harden the VM (recommended with Bridged):** `sudo bash deploy/harden-vm.sh` turns on a firewall
that lets home devices reach only Lumio (TCP 8443 and `lumio.local` lookups) while the VM itself
can't start connections to anything else on your home network (router, NAS, phones, the Windows
PC). Internet stays available for updates. It also turns off network discovery (avahi,
cups-browsed) and tightens kernel network settings. Undo with `--undo`.

> Never forward this port on your internet router. Lumio is built for your home network only.

## For developers

```bash
npm test     # 29 tests: security pipeline, TLS/CA, mDNS, admin devices, intro detection, progress, admin console
npm start    # run in the foreground instead of via the launcher
```

The launcher runs Lumio as a `systemd --user` service (`journalctl --user -u lumio` for logs).
`deploy/lumio.service` is a hardened system-wide unit for headless servers.

## Docs

- [Design & architecture](docs/DESIGN.md): per-device tracking, playback pipeline, storage efficiency, security model
- [Security policy](SECURITY.md)

## License

MIT
