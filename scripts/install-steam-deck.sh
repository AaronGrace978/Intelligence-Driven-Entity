#!/usr/bin/env bash
# Installs The Entity on a Steam Deck (or any x86_64 Linux desktop) for the current user:
# the AppImage, an application-menu entry, and a desktop icon. No root, no read-only-filesystem changes.
#
#   curl -fsSL https://github.com/AaronGrace978/Intelligence-Driven-Entity/releases/latest/download/install-steam-deck.sh | bash
#
# Options: --version X.Y.Z installs a specific release; --uninstall removes everything this script added.
set -euo pipefail

REPO="AaronGrace978/Intelligence-Driven-Entity"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/the-entity"
MENU_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
MENU_FILE="$MENU_DIR/the-entity.desktop"
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
DESKTOP_FILE="$DESKTOP_DIR/The Entity.desktop"

say() { printf '\033[1;32m::\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m!!\033[0m %s\n' "$*" >&2; exit 1; }

version=""
while [ $# -gt 0 ]; do
  case "$1" in
    --version) version="${2#v}"; shift 2 ;;
    --uninstall)
      rm -rf "$APP_DIR"
      rm -f "$MENU_FILE" "$DESKTOP_FILE"
      update-desktop-database "$MENU_DIR" >/dev/null 2>&1 || true
      say "The Entity removed. Settings and API keys are kept in ~/.config/dev.intelligencedrivenentity.app."
      exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[ "$(uname -m)" = "x86_64" ] || die "this installer is for x86_64; download the arm64 build from https://github.com/$REPO/releases"

if [ -n "$version" ]; then
  tag="v$version"
  url="https://github.com/$REPO/releases/download/$tag/The.Entity_${version}_amd64.AppImage"
else
  say "Finding the latest release…"
  release="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest")" || die "could not reach GitHub"
  url="$(printf '%s' "$release" | grep -o '"browser_download_url": *"[^"]*_amd64\.AppImage"' | head -n1 | sed 's/.*"\(https[^"]*\)"/\1/')"
  [ -n "$url" ] || die "the latest release has no amd64 AppImage"
  version="$(basename "$url" | sed 's/^The\.Entity_\(.*\)_amd64\.AppImage$/\1/')"
fi

app="$APP_DIR/The.Entity_${version}_amd64.AppImage"
mkdir -p "$APP_DIR" "$MENU_DIR" "$DESKTOP_DIR"

say "Downloading The Entity $version…"
curl -fL --retry 3 --progress-bar -o "$app.part" "$url" || die "download failed: $url"
mv "$app.part" "$app"
chmod +x "$app"
find "$APP_DIR" -maxdepth 1 -name 'The.Entity_*_amd64.AppImage' ! -name "$(basename "$app")" -delete

say "Installing the icon…"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
( cd "$tmp" && "$app" --appimage-extract 'usr/share/icons/*' >/dev/null 2>&1 ) || true
icon="$(find "$tmp/squashfs-root" -path '*/128x128/apps/*.png' 2>/dev/null | head -n1)"
[ -n "$icon" ] || icon="$(find "$tmp/squashfs-root" -name '*.png' 2>/dev/null | sort | tail -n1)"
if [ -n "$icon" ]; then
  cp "$icon" "$APP_DIR/the-entity.png"
fi

# AppImages mount themselves with FUSE 2. When libfuse2 is missing the runtime can unpack to /tmp instead.
launch="\"$app\""
if ! ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
  launch="env APPIMAGE_EXTRACT_AND_RUN=1 \"$app\""
fi

cat >"$MENU_FILE" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=The Entity
GenericName=AI Chat
Comment=Multi-model AI chat with a face that reacts to every token
Exec=$launch
Icon=$APP_DIR/the-entity.png
Terminal=false
Categories=Network;Chat;
Keywords=ai;chat;llm;ollama;
StartupWMClass=the-entity
EOF

cp "$MENU_FILE" "$DESKTOP_FILE"
chmod +x "$MENU_FILE" "$DESKTOP_FILE"
gio set "$DESKTOP_FILE" metadata::trusted true >/dev/null 2>&1 || true
update-desktop-database "$MENU_DIR" >/dev/null 2>&1 || true

say "Installed The Entity $version."
cat <<EOF

  Desktop Mode: double-click "The Entity" on the desktop, or find it in the application menu.
  Game Mode:    in Desktop Mode, right-click The Entity in the application menu and choose
                "Add to Steam". It then appears under Non-Steam in your library, opens full
                screen, and works with the controller (A select, B back, X type, Y renderer).

  Update: run this command again.   Remove: add --uninstall.
EOF
