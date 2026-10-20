#!/usr/bin/env bash
# Installs the AI Usage Meter applet and its data collectors for the current user.
set -euo pipefail

UUID="ai-usage-meter@hshant966"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$HOME/.local/share/ai-usage/bin"
APPLET_DIR="$HOME/.local/share/cinnamon/applets/$UUID"

command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
command -v cinnamon >/dev/null || echo "warning: Cinnamon not found; the collectors will still install" >&2

mkdir -p "$BIN_DIR"
# Replace the applet dir so files dropped in a newer version do not linger.
rm -rf "$APPLET_DIR"
mkdir -p "$APPLET_DIR"
install -m 755 "$SRC"/bin/ai-usage-* "$BIN_DIR"/
install -m 644 "$SRC"/LICENSE-omarchy "$HOME/.local/share/ai-usage/LICENSE-omarchy"
cp -r "$SRC/applet/$UUID/." "$APPLET_DIR/"

echo "Collecting usage once..."
"$BIN_DIR/ai-usage-update" || echo "warning: first collection failed; the applet retries on its timer" >&2

if command -v dbus-send >/dev/null && pgrep -x cinnamon >/dev/null; then
    dbus-send --session --dest=org.Cinnamon --type=method_call /org/Cinnamon \
        org.Cinnamon.ReloadXlet string:"$UUID" string:'APPLET' 2>/dev/null || true
fi

echo "Installed. Add 'AI Usage Meter' to your panel: right-click panel > Applets."
