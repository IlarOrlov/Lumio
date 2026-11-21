#!/usr/bin/env bash
# Lumio VM hardening (Ubuntu). Run as root:  sudo bash deploy/harden-vm.sh   (undo: --undo)
#
# Goal: devices in your home can reach Lumio, but if this VM were ever compromised
# it could not start connections to anything else on your home network (no port
# scans, no attacks on the router, NAS, phones or the Windows host), and it no
# longer advertises itself or browses the network.
#
#   Inbound : only Lumio (TCP <port>) and lumio.local name queries (UDP 5353),
#             only from private (home) addresses. Everything else is dropped.
#   Outbound: internet allowed (updates). Into the home network ONLY: DNS to the
#             router, DHCP, and mDNS answers. Replies to devices that connected
#             to Lumio are allowed automatically (connection tracking).
#   Services: avahi-daemon (announces + scans) and cups-browsed (printer
#             discovery) are stopped and disabled. Lumio answers lumio.local itself.
#   Kernel  : ignore ICMP redirects / source routing, reverse-path filtering,
#             SYN cookies, hide kernel pointers and dmesg from normal users.
#
# Limits: ARP (layer 2) can't be filtered without breaking replies, so a
# compromised VM could still learn which IP addresses are in use, but it
# could not connect to any of them.
set -euo pipefail

CONF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/config"
SYSCTL=/etc/sysctl.d/60-lumio-hardening.conf
PORT="${LUMIO_PORT:-}"
if [ -z "$PORT" ] && [ -r "$CONF_DIR/lumio.json" ]; then
  PORT="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9]\{2,5\}\).*/\1/p' "$CONF_DIR/lumio.json" | head -n1)"
fi
PORT="${PORT:-8443}"
case "$PORT" in ''|*[!0-9]*) echo "Invalid port: $PORT" >&2; exit 1;; esac

if [ "$(id -u)" -ne 0 ]; then echo "Run as root: sudo bash $0" >&2; exit 1; fi
command -v ufw >/dev/null || { echo "ufw is not installed (sudo apt install ufw)" >&2; exit 1; }

if [ "${1:-}" = "--undo" ]; then
  ufw --force reset >/dev/null
  ufw disable >/dev/null || true
  rm -f "$SYSCTL"; sysctl --system >/dev/null || true
  systemctl enable --now avahi-daemon.service avahi-daemon.socket cups-browsed.service 2>/dev/null || true
  echo "Lumio hardening removed (firewall off, services and kernel settings back to defaults)."
  exit 0
fi

LAN4=(10.0.0.0/8 172.16.0.0/12 192.168.0.0/16)

echo "==> Firewall (Lumio port $PORT)"
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw default deny routed >/dev/null
ufw logging low >/dev/null

for n in "${LAN4[@]}"; do
  ufw allow in proto tcp from "$n" to any port "$PORT" comment 'Lumio streaming' >/dev/null
  ufw allow in proto udp from "$n" to any port 5353 comment 'lumio.local (mDNS)' >/dev/null
  ufw allow in proto igmp from "$n" to 224.0.0.0/4 comment 'router multicast queries (keeps mDNS flowing)' >/dev/null
done

# The only things this VM may start towards the home network:
ufw allow out proto udp to 224.0.0.251 port 5353 comment 'mDNS answers (lumio.local)' >/dev/null
ufw allow out proto udp to ff02::fb port 5353 comment 'mDNS answers (lumio.local)' >/dev/null
for n in "${LAN4[@]}"; do
  ufw allow out proto udp to "$n" port 53 comment 'DNS via router' >/dev/null
  ufw allow out proto tcp to "$n" port 53 comment 'DNS via router' >/dev/null
done
ufw allow out proto udp from any port 68 to any port 67 comment 'DHCP' >/dev/null
# multicast group membership reports, so network switches keep delivering mDNS queries
ufw allow out proto igmp to 224.0.0.22 comment 'IGMP (mDNS group membership)' >/dev/null
ufw allow out proto igmp to 224.0.0.251 comment 'IGMP (mDNS group membership)' >/dev/null
# ...everything else on the home network, link-local, multicast and broadcast is refused:
for n in "${LAN4[@]}" 169.254.0.0/16 100.64.0.0/10 224.0.0.0/4 255.255.255.255; do
  ufw deny out to "$n" comment 'no connections into the home network' >/dev/null
done
for n in fc00::/7 fe80::/10 ff00::/8; do
  ufw deny out to "$n" comment 'no connections into the home network' >/dev/null
done
ufw --force enable >/dev/null
systemctl enable ufw >/dev/null 2>&1 || true

echo "==> Stopping network discovery services"
for s in avahi-daemon.socket avahi-daemon.service cups-browsed.service; do
  if systemctl list-unit-files "$s" >/dev/null 2>&1; then
    systemctl disable --now "$s" >/dev/null 2>&1 || true
    echo "    disabled $s"
  fi
done

echo "==> Kernel network hardening ($SYSCTL)"
cat > "$SYSCTL" <<'EOF'
# Lumio VM hardening (remove this file and run "sysctl --system" to undo)
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.secure_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.all.log_martians = 1
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.icmp_ignore_bogus_error_responses = 1
net.ipv4.tcp_syncookies = 1
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0
net.ipv6.conf.all.accept_source_route = 0
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1
net.core.bpf_jit_harden = 2
EOF
sysctl -q --system >/dev/null

echo "==> Automatic security updates"
if systemctl list-unit-files unattended-upgrades.service >/dev/null 2>&1; then
  systemctl enable --now unattended-upgrades.service >/dev/null 2>&1 || true
  echo "    unattended-upgrades: $(systemctl is-active unattended-upgrades.service 2>/dev/null || echo unknown)"
else
  echo "    unattended-upgrades not installed (recommended: sudo apt install unattended-upgrades)"
fi

echo
ufw status verbose
echo
echo "Done. Undo everything with: sudo bash $0 --undo"
