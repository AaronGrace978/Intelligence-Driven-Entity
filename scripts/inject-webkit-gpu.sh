#!/bin/bash
# linuxdeploy copies WebKitWebProcess and WebKitNetworkProcess into the AppImage and
# skips WebKitGPUProcess. WebKitGTK 2.46+ runs WebGL there. Without that binary the
# face falls back to a software path, which is the ~10 fps stutter on a Steam Deck OLED.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
appimage=$(find "$root/src-tauri/target/release/bundle/appimage" -name '*.AppImage' -print -quit || true)
if [ -z "${appimage}" ]; then
  echo "no AppImage to patch" >&2
  exit 0
fi

src=$(find /usr/lib -type f -name WebKitGPUProcess -path '*webkit2gtk-4.1*' | head -1)
if [ -z "${src}" ]; then
  echo "WebKitGPUProcess is not installed on this builder" >&2
  exit 1
fi

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT
chmod +x "$appimage"
(cd "$workdir" && "$appimage" --appimage-extract >/dev/null)

dest=$(find "$workdir/squashfs-root" -type f -name WebKitWebProcess -printf '%h\n' -quit)
if [ -z "${dest}" ]; then
  echo "bundled WebKitWebProcess was not found" >&2
  exit 1
fi
if [ -e "$dest/WebKitGPUProcess" ]; then
  echo "WebKitGPUProcess is already bundled"
  exit 0
fi

cp -a "$src" "$dest/WebKitGPUProcess"
chmod +x "$dest/WebKitGPUProcess"

libpath="$workdir/squashfs-root/usr/lib"
if [ -d "$workdir/squashfs-root/usr/lib/$(uname -m)-linux-gnu" ]; then
  libpath="$libpath:$workdir/squashfs-root/usr/lib/$(uname -m)-linux-gnu"
fi
missing=$(LD_LIBRARY_PATH="$libpath${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" ldd "$dest/WebKitGPUProcess" | grep "not found" || true)
if [ -n "$missing" ]; then
  echo "WebKitGPUProcess is missing libraries:" >&2
  echo "$missing" >&2
  exit 1
fi

arch=$(uname -m)
tool="$workdir/appimagetool"
curl -fsSL -o "$tool" "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-${arch}.AppImage"
chmod +x "$tool"
ARCH="$arch" APPIMAGE_EXTRACT_AND_RUN=1 "$tool" "$workdir/squashfs-root" "$appimage"
echo "injected WebKitGPUProcess into $appimage"
