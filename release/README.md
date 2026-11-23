# Talos Crest release files

These builds are offline after download. The extension catalogue, snippets,
themes, and language grammars are bundled in the artifact. No account,
telemetry, cloud service, or internet connection is required to use Talos. The
optional **Observatory → GitHub** tab is the only part that can use the
internet, and only after you supply a personal access token and ask it to load
data; everything else remains fully offline.

## Linux

File: `appimage/TalosCrest-Linux-x86_64.AppImage`

- For 64-bit x86 desktop Linux only.
- GTK and WebKitGTK are bundled in the AppImage, but it uses the system C
  library. The current build needs **glibc 2.38 or newer**.
- Needs either FUSE or `--appimage-extract-and-run`.
- Not an ARM/Raspberry Pi or Alpine/musl build.

SHA-256:
`a76b0b2224a91e6da54730693a47f5af3960dadfe86f195dfaf3e80926943a0f`

Examples of Linux releases that meet the current glibc floor: Ubuntu 24.04+,
Linux Mint 22+, Pop!_OS 24.04+, Debian 13+, Fedora 39+, Arch Linux, Manjaro,
EndeavourOS, Gentoo, and Void Linux. Ubuntu 22.04, Debian 12, Linux Mint 21,
RHEL/AlmaLinux 9, and Alpine are not supported by this particular build.

## Windows

File: `windows/TalosCrest-Windows-x64-portable.zip`

- For 64-bit Windows 10 or 11.
- Extract the whole ZIP, then run `TalosCrest.exe`.
- Needs the Microsoft Edge WebView2 Runtime. Windows 11 usually has it.
- Not an ARM Windows build.

SHA-256:
`0541e59d187b41359caa30078b323e31d3fd34d7d86ab76d9476172d8a8c2292`

## Optional GitHub access

Both builds include an opt-in GitHub tab under Observatory. It stores a
personal access token encrypted with a local key, talks directly to the GitHub
REST API when you use that tab, and does not create an account, send telemetry,
or contact a Talos service. You can clear the token locally at any time. The
rest of the editor needs no network connection.

Both builds also include the Universal Project Workspace: a bounded local
folder scanner with nested Explorer navigation, automatic restoration of the
last folder per window, recent-project fallback, a workspace/status indicator,
structured file-change updates with bounded queueing and watcher recovery, one
shared ignore/security policy for Explorer, watcher, and Chronicle, and bounded
Chronicle project memory. No workspace content is uploaded or analyzed remotely.

Canvas is also fully local. It includes screenshot annotation shapes and
callouts, pixel measurement, palette extraction and HEX/RGB/HSL inspection,
asset-size presets, grid snapping and guides, transparency preview, SVG source
editing for local raster previews, before/after comparison, and export presets.
Grading and filters run in an `OffscreenCanvas` worker where available, with an
identical main-thread fallback. Large images open at reduced resolution by
default and can be reopened at full size from disk; no image data is uploaded.

## GitHub publishing

Both builds are committed as separate files in this repository:

1. `appimage/TalosCrest-Linux-x86_64.AppImage`
2. `windows/TalosCrest-Windows-x64-portable.zip`

Download them with “Download raw file”, or clone the repository. The
timestamped copies in the same folders are the immutable build snapshots.
