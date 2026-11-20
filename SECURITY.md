# Security Policy

Lumio is designed to run on a private home network. The full threat model and
the list of controls are in [docs/DESIGN.md §6](docs/DESIGN.md#6-security-model).

## Deployment checklist

- [ ] Use a household password of at least 12 characters (set in the admin console).
- [ ] Keep `https: true` (the default).
- [ ] **Never** forward Lumio's port on your internet router.
- [ ] Scope the Windows firewall rule for the VMware port forward to the *Private* profile / local subnet.
- [ ] In the VM: `sudo ufw allow from 192.168.204.0/24 to any port 8443 proto tcp` and `sudo ufw enable`.
- [ ] Run as a normal user via the desktop launcher (sandboxed `systemd --user` service), or `deploy/lumio.service` on a headless server.
- [ ] The admin console only listens on `127.0.0.1`; open it only through the Lumio icon.
- [ ] Keep Node.js and ffmpeg updated (`sudo apt upgrade`).
- [ ] `config/lumio.json` is mode 600 and never committed.
- [ ] Revoke lost or old devices in Settings → Signed-in devices.

## Reporting a vulnerability

Please open a private security advisory on GitHub
(Security → Report a vulnerability) rather than a public issue.
