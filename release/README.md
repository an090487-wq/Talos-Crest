# Talos Crest release files

These builds are offline after download. The extension catalogue, snippets,
themes, and language grammars are bundled in the artifact. No account,
telemetry, cloud service, or internet connection is required to use Talos.

## Linux

File: `appimage/TalosCrest-Linux-x86_64.AppImage`

- For 64-bit x86 desktop Linux only.
- GTK and WebKitGTK are bundled in the AppImage, but it uses the system C
  library. The current build needs **glibc 2.38 or newer**.
- Needs either FUSE or `--appimage-extract-and-run`.
- Not an ARM/Raspberry Pi or Alpine/musl build.

SHA-256:
`28670eb186846a18524245084f72d7777a9a4693609019c106d27f62b45a8066`

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
`9cc903cd65ca8e3fc128ff4c5c07f0cef78d6f154fbc14a5bca1769a43256f9d`

## GitHub publishing

Both builds are committed as separate files in this repository:

1. `appimage/TalosCrest-Linux-x86_64.AppImage`
2. `windows/TalosCrest-Windows-x64-portable.zip`

Download them with “Download raw file”, or clone the repository. The
timestamped copies in the same folders are the immutable build snapshots.
