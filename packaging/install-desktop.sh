#!/usr/bin/env bash
# Install the `pgt` launcher and a desktop entry for the Pager Theme Builder.
# Usage: ./packaging/install-desktop.sh
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${PGT_APP_DIR:-$(cd "$PKG_DIR/.." && pwd)}"

BIN_DIR="${HOME}/.local/bin"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"
APPS_DIR="$DATA_DIR/applications"
ICON_DIR="$DATA_DIR/icons/hicolor/scalable/apps"
DESKTOP_FILE="$APPS_DIR/pgt-theme-builder.desktop"
ICON_FILE="$ICON_DIR/pgt-theme-builder.svg"

if [[ ! -d "$APP_DIR/node_modules/electron" ]]; then
  echo "warning: Electron is not installed in $APP_DIR (run: cd \"$APP_DIR\" && npm install)" >&2
fi

mkdir -p "$BIN_DIR" "$APPS_DIR" "$ICON_DIR"

# CLI launcher
sed "s|__APP_DIR__|$APP_DIR|g" "$PKG_DIR/pgt.in" > "$BIN_DIR/pgt"
chmod 755 "$BIN_DIR/pgt"

# Icon + desktop entry
install -m 644 "$PKG_DIR/icon.svg" "$ICON_FILE"
sed -e "s|__EXEC__|$BIN_DIR/pgt|g" \
    -e "s|__ICON__|$ICON_FILE|g" \
    "$PKG_DIR/pgt-theme-builder.desktop.in" > "$DESKTOP_FILE"
chmod 755 "$DESKTOP_FILE"

update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
gtk-update-icon-cache -f -t "$DATA_DIR/icons/hicolor" >/dev/null 2>&1 || true

echo "Installed launcher: $BIN_DIR/pgt"
echo "Installed desktop entry: $DESKTOP_FILE"
echo "Run 'pgt' or launch 'Pager Theme Builder' from your app menu."
