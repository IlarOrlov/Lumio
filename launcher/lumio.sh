#!/usr/bin/env bash
# Lumio launcher: starts Lumio in the background (systemd user service, no
# root needed) and opens the admin console in your browser. Bound to the
# desktop icon; you never need to run this by hand.
set -euo pipefail

LUMIO_DIR="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/lumio.service"
TOKEN_FILE="$LUMIO_DIR/data/admin.token"

notify() {
  if command -v zenity >/dev/null; then zenity --error --title="Lumio" --text="$1" 2>/dev/null || true
  elif command -v notify-send >/dev/null; then notify-send "Lumio" "$1" || true
  else echo "Lumio: $1" >&2; fi
}

NODE="$(command -v node || true)"
[ -z "$NODE" ] && [ -x "$HOME/.local/bin/node" ] && NODE="$HOME/.local/bin/node"
if [ -z "$NODE" ]; then notify "Node.js is not installed. Install Node.js 22 or newer."; exit 1; fi
if ! command -v ffmpeg >/dev/null; then notify "ffmpeg is not installed. Install it from Ubuntu Software or with: sudo apt install ffmpeg"; exit 1; fi

ADMIN_PORT="$("$NODE" -e "try{const c=require('$LUMIO_DIR/config/lumio.json');console.log(c.adminPort||8442)}catch{console.log(8442)}")"

# (Re)write the user service so it always points at this folder and this node.
mkdir -p "$UNIT_DIR" "$LUMIO_DIR/data"
chmod 700 "$LUMIO_DIR/data"
NEW_UNIT="$(cat <<EOF
[Unit]
Description=Lumio home streaming server
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$LUMIO_DIR
ExecStart=$NODE --disable-warning=ExperimentalWarning $LUMIO_DIR/src/server.js
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=yes
LockPersonality=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @mount @debug @reboot @swap @raw-io @module @obsolete @cpu-emulation

[Install]
WantedBy=default.target
EOF
)"
if [ ! -f "$UNIT" ] || [ "$(cat "$UNIT")" != "$NEW_UNIT" ]; then
  printf '%s\n' "$NEW_UNIT" > "$UNIT"
  systemctl --user daemon-reload
fi

if ! systemctl --user is-active --quiet lumio.service; then
  rm -f "$TOKEN_FILE"
  systemctl --user start lumio.service
fi

# Wait (up to 20 s) for the admin console and its one-time key.
for _ in $(seq 1 80); do
  if [ -s "$TOKEN_FILE" ] && (exec 3<>"/dev/tcp/127.0.0.1/$ADMIN_PORT") 2>/dev/null; then break; fi
  sleep 0.25
done
if [ ! -s "$TOKEN_FILE" ]; then
  notify "Lumio did not start. Details: journalctl --user -u lumio"
  exit 1
fi

xdg-open "http://127.0.0.1:$ADMIN_PORT/#key=$(cat "$TOKEN_FILE")" >/dev/null 2>&1 &
