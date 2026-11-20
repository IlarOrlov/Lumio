#!/usr/bin/env bash
# One-time: puts a "Lumio" icon on your desktop and in the app menu.
# In the Files app: right-click this file → "Run as a Program".
set -euo pipefail
LUMIO_DIR="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
chmod +x "$LUMIO_DIR/launcher/lumio.sh"

ENTRY="[Desktop Entry]
Type=Application
Name=Lumio
GenericName=Home streaming server
Comment=Start Lumio and open its admin console
Exec=\"$LUMIO_DIR/launcher/lumio.sh\"
Icon=$LUMIO_DIR/public/icon.svg
Terminal=false
Categories=AudioVideo;Video;
StartupNotify=false"

mkdir -p "$HOME/.local/share/applications"
printf '%s\n' "$ENTRY" > "$HOME/.local/share/applications/lumio.desktop"
chmod +x "$HOME/.local/share/applications/lumio.desktop"

DESKTOP="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
if [ -d "$DESKTOP" ]; then
  printf '%s\n' "$ENTRY" > "$DESKTOP/Lumio.desktop"
  chmod +x "$DESKTOP/Lumio.desktop"
  gio set "$DESKTOP/Lumio.desktop" metadata::trusted true 2>/dev/null || true
fi
command -v zenity >/dev/null && zenity --info --title=Lumio --text="Lumio icon added to your desktop and app menu.\nDouble-click it to open Lumio." 2>/dev/null || true
echo "Lumio launcher installed."
