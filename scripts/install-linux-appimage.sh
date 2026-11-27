#!/usr/bin/env bash
# Install the current Talos Crest AppImage and keep every Linux launcher
# permanently pointed at the same canonical location.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artifact="${1:-$repo/release/appimage/TalosCrest-Linux-x86_64.AppImage}"

if [[ ! -f "$artifact" ]]; then
  echo "AppImage not found: $artifact" >&2
  exit 1
fi

artifact_abs="$(cd "$(dirname "$artifact")" && pwd)/$(basename "$artifact")"
install_dir="$HOME/Applications"
target="$install_dir/TalosCrest.AppImage"
mkdir -p "$install_dir" "$HOME/.local/bin" "$HOME/.local/share/applications"

if [[ "$artifact_abs" != "$target" ]]; then
  install -m 755 "$artifact_abs" "$target"
fi
chmod 755 "$target"
ln -sfn "$target" "$HOME/.local/bin/talos-crest"

icon_src="$repo/app/src-tauri/icons"
icon_dest="$HOME/.local/share/icons/hicolor"
for size in 512x512:icon.png 128x128:128x128.png 64x64:64x64.png 32x32:32x32.png; do
  dir="${size%%:*}"
  source="${size##*:}"
  install -Dm644 "$icon_src/$source" "$icon_dest/$dir/apps/talos-crest.png"
  # The AppImage's own desktop entry uses Icon=talos-gui, so install the same
  # crest under that name as well. This prevents a generic gear icon when the
  # window manager matches the running app to the bundled launcher.
  install -Dm644 "$icon_src/$source" "$icon_dest/$dir/apps/talos-gui.png"
done

cat > "$HOME/.local/share/applications/talos-crest.desktop" <<EOF
[Desktop Entry]
Name=Talos Crest
Comment=Professional offline-first code editor
Exec="$HOME/.local/bin/talos-crest" %f
Icon=$icon_dest/512x512/apps/talos-crest.png
Type=Application
Categories=Development;IDE;
Terminal=false
StartupWMClass=talos-gui
EOF

# Override the older system-wide launcher so the app menu never starts
# target/release/talos-gui instead of the installed AppImage.
cat > "$HOME/.local/share/applications/Talos Crest.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Talos Crest
Hidden=true
NoDisplay=true
EOF

desktop_dir="$(xdg-user-dir DESKTOP 2>/dev/null || printf '%s/Desktop' "$HOME")"
if [[ -d "$desktop_dir" && -f "$desktop_dir/talos.desktop" ]]; then
  cat > "$desktop_dir/talos.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Talos Crest
Comment=Professional code editor
Exec="$HOME/.local/bin/talos-crest" %f
Icon=$icon_dest/512x512/apps/talos-crest.png
Terminal=false
Categories=Development;TextEditor;
StartupWMClass=talos-gui
EOF
  chmod +x "$desktop_dir/talos.desktop"
fi

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q -f -t "$icon_dest" 2>/dev/null || true
fi
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 || true
fi

echo "Talos Crest installed at: $target"
sha256sum "$target"
