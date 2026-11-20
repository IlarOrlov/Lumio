<p align="center"><img src="public/icon.svg" width="96" alt="Lumio"></p>

<h1 align="center">Lumio</h1>
<p align="center"><b>Your home cinema, on every screen in the house.</b><br>
A tiny, security-first streaming server for your own movies and series, with per-device resume.</p>

---

- **Plays MKV & MP4 anywhere.** Phones, tablets, laptops and smart-TV browsers. Compatible files are
  served directly, MKVs are remuxed on the fly, and only unplayable codecs get transcoded.
- **Every device remembers.** Open Lumio and "Continue watching on *Living room TV*" is the first
  thing you see. Finished an episode? The next one is waiting as *Up next*, with auto-play.
- **Series-aware.** Seasons, episode lists, watched ticks, sidecar and embedded subtitles,
  multiple audio tracks.
- **Locked down.** HTTPS, scrypt, hashed session tokens, CSRF + Origin checks, strict CSP, LAN-only
  allowlist, DNS-rebinding guard, sandboxed ffmpeg, systemd hardening.
  [Details →](docs/DESIGN.md#6-security-model)
- **Storage-efficient.** Plays files in place with no copies or disk cache. `npm run compact`
  can shrink your library by ~50 % with AV1 + Opus. [Details →](docs/DESIGN.md#5-storage-efficiency)
- **Zero npm dependencies.** Just Node.js ≥ 22.13 and ffmpeg.

## Quick start (Ubuntu)

```bash
sudo apt install -y ffmpeg           # Node.js >= 22.13 is also required
git clone https://github.com/IlarOrlov/Lumio.git && cd Lumio
npm run setup                        # password, media folders, port, HTTPS certificate
npm start
```

Open `https://<server-ip>:8443` and accept the self-signed certificate once per device. Sign in
and give the device a name.

```bash
npm test                             # run the test suite
npm run compact                      # dry run: how much space AV1 would save
```

## Running inside a VMware VM (NAT)

With the VM on **NAT**, other devices can't reach the VM's address (e.g. `192.168.204.128`) directly.
Forward a port on the host instead:

1. **VMware Workstation → Edit → Virtual Network Editor** → *Change Settings* (admin) → select
   **VMnet8 (NAT)** → **NAT Settings… → Add**:
   - Host port: `8443`
   - Type: `TCP`
   - Virtual machine IP address: your VM's IP (`ip -4 addr show ens33`)
   - Virtual machine port: `8443`

   Click OK and Apply.
2. **Windows firewall on the host:** allow inbound TCP 8443 for the **Private** profile only
   (PowerShell as admin):
   ```powershell
   New-NetFirewallRule -DisplayName "Lumio (LAN)" -Direction Inbound -Protocol TCP -LocalPort 8443 -Profile Private -RemoteAddress LocalSubnet -Action Allow
   ```
   Make sure your home Wi-Fi is set as a *Private* network in Windows.
3. **Keep the VM's IP stable:** VMware's DHCP can change it. Either reserve it in
   `C:\ProgramData\VMware\vmnetdhcp.conf` or set a static IP in the VM.
4. **Firewall inside the VM** (forwarded traffic arrives from the VMware NAT gateway):
   ```bash
   sudo ufw allow from 192.168.204.0/24 to any port 8443 proto tcp
   sudo ufw enable
   ```
5. On your phone or TV open **`https://<Windows-host-LAN-IP>:8443`** (find it with `ipconfig` on Windows).
   When `npm run setup` asks for the host IP, give this address so the certificate matches.

> Never forward this port on your internet router. Lumio is built for your home network only.

## Run as a service

```bash
sudo cp deploy/lumio.service /etc/systemd/system/
sudo systemctl edit --full lumio     # replace CHANGE_ME with your user and paths
sudo systemctl daemon-reload && sudo systemctl enable --now lumio
journalctl -u lumio -f
```

## Library layout

```
Movies/Inception (2010).mkv
Movies/The Matrix (1999)/The.Matrix.1999.1080p.mkv     (+ poster.jpg)
Series/Dark/Season 1/Dark S01E01.mkv                    (+ Dark S01E01.en.srt)
```

Episodes are recognised by `S01E02` or `1x02`. New files show up within 15 minutes, or straight away
with Settings → Rescan.

## Keyboard / remote

`Space`/`Enter` play/pause · `←` back 10 s · `→` forward 30 s · `F` fullscreen · `Esc` back

## Docs

- [Design & architecture](docs/DESIGN.md): per-device tracking, playback pipeline, storage efficiency, security model
- [Security policy](SECURITY.md)

## License

MIT
