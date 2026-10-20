#!/usr/bin/env bash
# Removes the applet and collectors. Usage records in ~/.local/state/omarchy are left in place.
set -euo pipefail

UUID="ai-usage-meter@hshant966"
rm -rf "$HOME/.local/share/cinnamon/applets/$UUID"
rm -f "$HOME"/.local/share/ai-usage/bin/ai-usage-{update,claude,codex,hermes,antigravity}
rm -f "$HOME/.local/share/ai-usage/LICENSE-omarchy"
rmdir "$HOME/.local/share/ai-usage/bin" "$HOME/.local/share/ai-usage" 2>/dev/null || true
echo "Removed. Remove the applet from your panel if it is still listed."
echo "Settings remain in ~/.config/cinnamon/spices/$UUID (delete that folder to reset them)."
