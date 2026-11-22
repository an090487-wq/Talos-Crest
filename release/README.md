# Talos Crest release files

These builds are offline after download. The extension catalogue, snippets,
themes, and language grammars are bundled in the artifact. No account,
telemetry, cloud service, or internet connection is required to use Talos.

## Linux

File: `appimage/TalosCrest-Linux-x86_64.AppImage`

- For 64-bit x86 desktop Linux only.
- Needs WebKitGTK/GTK runtime support and either FUSE or
  `--appimage-extract-and-run`.
- Not an ARM/Raspberry Pi build.

SHA-256:
`5323ec7a2a769a32c40604d7407e95dc6681286935092d8b1971c841622bbded`

## Windows

File: `windows/TalosCrest-Windows-x64-portable.zip`

- For 64-bit Windows 10 or 11.
- Extract the whole ZIP, then run `TalosCrest.exe`.
- Needs the Microsoft Edge WebView2 Runtime. Windows 11 usually has it.
- Not an ARM Windows build.

SHA-256:
`7c0190ad9a3cc502782f4f1d66abcc9d47ab9afa0b27caf2611b84bb92c13ada`

## GitHub publishing

Upload these as assets on a GitHub Release, not as ordinary repository files:

1. `appimage/TalosCrest-Linux-x86_64.AppImage`
2. `windows/TalosCrest-Windows-x64-portable.zip`

The timestamped copies in the same folders are the immutable build snapshots.
