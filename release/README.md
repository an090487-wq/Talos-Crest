# Talos Crest release files

These builds are offline after download. The extension catalogue, snippets,
themes, and language grammars are bundled in the artifact. No account,
telemetry, cloud service, or internet connection is required to use Talos. The
optional **Observatory → GitHub** tab and Source Control's Fetch/Pull/Push
buttons use the internet only when you explicitly ask them to; everything else
remains fully offline.

From a repository checkout, run `./scripts/verify-release.sh` to check every
published hash below, including the newest timestamped copy of each artifact.
Desktop runs also accept typed input in the Output panel, so programs that call
`input()` work instead of failing with EOF. An interface-size selector keeps
shell text and controls readable without changing the editor's monospace font.
The Source Control button now opens an integrated Git pane with status, diffs,
staging, commits, branches, history, and explicit remote sync. Ctrl+Enter in its
message box commits without triggering the editor's Run command, a commit is
hard-blocked from opening the bottom Output panel, stale diffs close after a
commit, and the integrated terminal keeps its size and focus when panels change.
The pane replaces the Explorer file tree while it is open (like VS Code),
toggles shut when the rail button is pressed again, keeps branch and remote
choices across refreshes, and stays a sidebar instead of stacking into the
Terminal/Output area on narrow windows. Git refresh caches successful repository
roots and reads remotes in one pass, while the PDF viewer loads its parser only
when a PDF is opened. The toolbar hides buttons already present in the activity
bar, the top search field is centered in the header's top row, and the breadcrumb
follows the active document even for images, PDFs, and binary previews. The status
bar shows a language icon, the working file name, and the active language instead
of an Untitled placeholder. A three-dot More menu holds creation, interface size,
New Window, and Windows actions. New files and folders created from bundled
read-only samples are placed in a writable location chosen by the user. The
command palette opens directly under the header search field, and an Args field
passes quoted arguments to desktop programs (for example `build` for setup.py).

## Linux

File: `appimage/TalosCrest-Linux-x86_64.AppImage`

- For 64-bit x86 desktop Linux only.
- GTK and WebKitGTK are bundled in the AppImage, but it uses the system C
  library. The current build needs **glibc 2.38 or newer**.
- Needs either FUSE or `--appimage-extract-and-run`.
- Not an ARM/Raspberry Pi or Alpine/musl build.

SHA-256:
`7922e0f35b8760e4e66594399fb24c877c35d4eec216b1c98b89aa358cd4ebdf`

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
`ef9224a84c44ad34ec6a406628d67394cc43a368d73ec060062be3849bbf6fc7`

## Android

File: `android/TalosCrest-Android-universal.apk`

- Universal APK for 64-bit and 32-bit Android devices.
- Unsigned build: sign it with your own key before installing it on a device.
- The terminal is desktop-only; the editor, file browser, and binary preview are local.

SHA-256:
`6885cbba82448a4a19967ea2b72f4f61551d357beaf1b93d390052633209b544`

## Optional GitHub access

All builds include an opt-in GitHub tab under Observatory. It stores a
personal access token encrypted with a local key, talks directly to the GitHub
REST API when you use that tab, and does not create an account, send telemetry,
or contact a Talos service. You can clear the token locally at any time. The
rest of the editor needs no network connection.

All builds also include the Universal Project Workspace: a bounded local
folder scanner with nested Explorer navigation, automatic restoration of the
last folder per window, recent-project fallback, a workspace/status indicator,
structured file-change updates with bounded queueing and watcher recovery, one
shared ignore/security policy for Explorer, watcher, and Chronicle, and bounded
Chronicle project memory. Find in Files and watcher registration reuse the
current Explorer scan instead of walking the tree again, with backend
revalidation and a fallback for truncated scans. The Explorer can duplicate
files/folders with bounded, policy-aware copying and drag items onto folders to
move them through the same validated path checks. No workspace content is
uploaded or analyzed remotely.

The editor includes a local Custom Error Detection engine with built-in rules
for common Python, JavaScript/TypeScript, C/C++, Rust, and Java defects, plus
user-defined JSON regex rules stored only on this device. It is pattern-based
checking, not a compiler or language server. Binary files such as compiled
Python modules open in a read-only, paged hex and printable-strings preview
instead of being rejected.

Canvas is also fully local. It includes screenshot annotation shapes and
callouts, pixel measurement, palette extraction and HEX/RGB/HSL inspection,
asset-size presets, grid snapping and guides, transparency preview, SVG source
editing for local raster previews, before/after comparison, and export presets.
Grading and filters run in an `OffscreenCanvas` worker where available, with an
identical main-thread fallback. Large images open at reduced resolution by
default and can be reopened at full size from disk; no image data is uploaded.

## GitHub publishing

All builds are committed as separate files in this repository:

1. `appimage/TalosCrest-Linux-x86_64.AppImage`
2. `windows/TalosCrest-Windows-x64-portable.zip`
3. `android/TalosCrest-Android-universal.apk`

Download them with “Download raw file”, or clone the repository. The
timestamped copies in the same folders are the immutable build snapshots.
