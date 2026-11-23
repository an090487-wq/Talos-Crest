# Talos

The Linux desktop edition is **Talos Crest**; the Android edition is **Talos
Pocket**.

Created by Arman Babu Nadaf at Shriptrao Kadam Mahavidyalay, with gratitude to
mentor **Sagar Morde**. This project is dedicated in their honor. See the root
[MIT License](../LICENSE) for reuse terms.

Talos is a code editor with diagnostics, PDF viewing, extensions, templates, and
code execution. The Android app can run Python, JavaScript, C, C++, and Java
programs locally through Termux, and preview HTML with inline CSS and JavaScript
in the app. Code is sent to the installed Termux app on the same phone, not
uploaded to an online runner. Desktop builds continue to use Talos's configured
language commands.

## Workspace appearance

Talos Crest uses a compact engineering-workstation shell: a branded top bar with
workspace selector, command palette, file/run controls, and window management;
a collapsible activity rail; breadcrumbs above the document tabs; and a
resizable bottom workspace. Choose Talos Industrial (the default), Talos Dark,
Talos Midnight, Talos Light, or Talos Contrast from the workspace toolbar. Theme
and editor-font choices are remembered on the device; an earlier build's one-time
migration of the old default theme has been corrected. Additional themes remain
available through Extensions, and their legacy accent tokens now map to the new
design tokens so extension palettes stay coherent.

The activity rail opens Explorer, Search, Run and Debug, Extensions, Talos
Chronicle, Talos Observatory, Talos Canvas, and Talos Calc. Source Control is
shown as unavailable because this build has no Source Control provider. The
rail can collapse to icons only, and that preference is window-scoped. Drag the
divider beside the PDF/HTML pane or above the bottom panel to resize it, or
focus a divider and use the arrow keys (Shift+arrow for larger steps).

Press **Ctrl+K** or choose the search field in the top bar to open the command
palette. It searches the existing action registry, groups results by category,
remembers recent commands for the window, and supports arrow keys, Enter, and
Escape. Ctrl+P remains the dedicated project file search.

The bottom workspace has Problems, Output, Terminal, Build, and Debug Console
channels. Problems and Output are live. Build and Debug Console remain explicit
empty states because this build has no build provider or debug adapter. The
panel can be hidden and reopened from the status bar, and its active channel is
remembered per window. The panel height, its maximized state, and the divider
positions are stored per window, so the editor, PDF, and terminal arrangement is
restored on the next launch. The bottom-panel **Max** button temporarily gives
the panel the whole workspace; **Restore** returns to the saved height.

PDFs open beside the editor so code, the terminal/Ollama, and the document are
usable at the same time. The PDF's width, page, zoom, dark mode, and the choice
between side-by-side and full-area **Focus** view are remembered per window.
Opening a code file while the PDF is focused steps back to the shared layout
instead of closing the document.

### Integrated terminal and Ollama

On desktop, the Terminal channel opens a real pseudo-terminal running the
machine's default shell. It is created lazily, starts in the chosen workspace,
tracks panel resizes, and is disposed when the window closes. Android builds
receive inert terminal commands and do not expose this UI.

Type shell commands directly in the terminal, or enter an Ollama model name in
the toolbar and choose **Run in Ollama**. Talos validates the model name and
types `ollama run <model>` into the PTY; it never passes toolbar text through a
shell string. The chosen model name is remembered per window. Ollama itself must
already be installed on the device.

## Editor document behavior

The editor uses CodeMirror 6's document model and viewport rendering rather than
mirroring the source in a second application-level string. Positions and
selections are maintained by editor transactions, including multiple
selections. Undo and redo are available from the toolbar and the standard
keyboard shortcuts. Opening a file or template creates a fresh editor state so
undo history cannot leak across documents. Dirty state is compared with the
last successfully loaded or saved document, so undoing back to that snapshot
clears the unsaved indicator; the comparison short-circuits on length changes so
typing does not scan the whole document. Diagnostics, outline parsing, and
session persistence are debounced and deferred to idle time, and
language-provided completion is requested on demand with Ctrl+Space so large
files stay responsive while typing.

The extension market includes free, MIT-licensed snippet packs for C, Python,
Java, HTML, Rust, R, Ruby, and Swift. Install and enable a pack, then press
Ctrl+Space in the editor to insert one of its snippets. Snippet fields use
CodeMirror placeholders, so Tab moves between them.

Files containing invalid UTF-8 or NUL bytes are identified as binary and are
not loaded into the text editor, preventing bytecode or other binary data from
being corrupted by a text save.

## Extension marketplace and catalogue

The bundled registry catalogue contains **135 extensions**. The Extensions view
provides category navigation (Programming Languages, Snippets, Themes, Web
Development, Security, Database and API, AI and ML, Linux Sysadmin,
Documentation, Design and Creative, Talos Exclusive, and more) plus search and
filters for installation status, compatibility, license, update date, external
dependency status, and highlight. Category counts reflect the catalogue, and a
category can be cleared with the **All extensions** button.

**Featured** and **Curated popular** are offline editorial labels stored in the
registry. They are chosen by the maintainers, not computed from telemetry:
Talos collects no usage data, and the catalogue has no ratings or reviews.
Featured entries sort first, followed by curated entries in editorial order;
older entries without those fields keep their previous updated-date ordering.

Some entries declare external requirements such as executables, system tools,
services, or Python modules. Talos detects these locally and shows each one as
Available, Missing, Checking, or Unknown with a short detail, along with a
compact warning on the card. Detection is read-only: Talos never installs or
executes an external tool, service, or module for you, and never runs extension
code just to check a requirement. Missing or unknown external requirements are
warnings only and do not block install, update, or rollback; a missing
dependency on another Talos extension remains a hard error. Install, update,
and rollback work offline with a local registry and verify the manifest
checksum. You must install any external tools or services the extension needs
before its optional behavior is available.

## Talos Calc and Talos Canvas

**Calc** (toolbar button, Ctrl+Shift+C, or Cmd+Shift+C on macOS) is a local
calculator with scientific and programmer modes, expression history, memory,
and unit conversion. It uses a small parser rather than JavaScript `eval`, and
its code is loaded only when the calculator opens. Adjacent values imply
multiplication (`(9)3`, `3(4)`, `2pi`). Results can be inserted into the active
editor.

**Canvas** (toolbar button, Ctrl+Shift+I, or opening a PNG/JPEG/WebP/SVG file)
is a local raster image and asset workspace. Nothing in Canvas contacts the
network.

- **Editing:** selection and crop with draggable handles (Enter or Apply crop
  commits), pan and zoom including Ctrl+wheel, brush/eraser with opacity,
  text, layers with visibility/order/opacity, undo/redo, rotation, flips,
  resize, and crop. Brush strokes use dirty-region compositing; large image
  work runs in an `OffscreenCanvas` worker with an identical local fallback.
  Very large images open at reduced resolution; **Full size** reopens the file
  from disk at full resolution when you need it.
- **Shapes and annotation:** line, rectangle, ellipse, arrow, triangle, star,
  regular polygon (3–24 sides), numbered callouts, translucent highlights,
  and a pixel ruler. Hold Shift for 45° lines, squares, and centered polygons.
  Filled shapes use the separate shape-fill color; callout numbering can be
  reset. These tools cover screenshot annotation without an external service.
- **Color grading:** exposure in photographic stops, brightness, contrast,
  saturation, temperature, tint, highlights, shadows, vibrance, hue, and gamma.
  Sliders produce a live low-resolution preview and are committed to the full
  image only when you choose Apply grading; Reset restores neutral values.
  Look presets (warm, cool, cinematic, vintage, noir) are editable starting
  points, not baked-in filters. Extra pixel filters include warm, cool, vintage,
  and noir; sharpen, grayscale, sepia, invert, and blur are also available.
- **Color inspection:** eyedropper sampling of any pixel, HEX input, live RGB
  and HSL readouts, and palette extraction from the current image. Clicking a
  palette swatch makes it the active drawing color.
- **Asset work:** asset size presets (favicon, app icons, PWA icon, avatar,
  social card), configurable grid with optional snapping, center guides, and a
  transparency preview background (checker, white, black, magenta). SVG files
  can be opened and their source text edited in the inspector; Apply preview
  rasterizes the edited source at a chosen size, and Save source to file
  explicitly writes the text back to the original path. Vector node editing,
  SVG export, and OCR are not implemented.
- **Comparison:** capture a screen-resolution baseline and drag the divider to
  compare it with the current image. The baseline is session-only and is not
  written to disk.
- **Export:** PNG, JPEG, or WebP with editable destination, export presets,
  aspect lock, quality, resize, and a matte color for opaque formats. The
  destination extension is corrected to match the encoded format before
  writing. Exports default to a new `-edited` file; the original is never
  replaced unless overwrite is explicitly confirmed.

Tool shortcuts: `V` select, `C` crop, `H` pan, `Z` zoom, `B` brush, `X` eraser,
`T` text, `L` line, `R` rectangle, `O` ellipse, `A` arrow, `N` triangle, `S`
star, `P` polygon, `K` callout, `Y` highlight, `M` measure, `I` eyedropper.
`[`/`]` change brush size, `0` fits the image, and Ctrl+Z/Ctrl+Shift+Z undo and
redo. Shortcuts use physical key positions so they also work on non-QWERTY
layouts.

Both tools are offline-first and keep their state on the device.

## Keyboard shortcuts

Press **F1** (or Ctrl+Shift+?) to open the searchable keyboard-shortcut dialog,
or use the **Shortcuts** button in the status bar. The dialog lists every
binding and can run an action when you click it. **Ctrl+K** opens the command
palette; Ctrl+P opens project file search. Ctrl+N creates a new file,
Ctrl+B toggles the outline, Ctrl+J toggles the bottom panel, Ctrl+` focuses the
integrated terminal, Alt+Z toggles word wrap, and Ctrl+= / Ctrl+- / Ctrl+0 adjust
the editor font size. File, tab,
navigation, and view shortcuts work from the outline, dialogs, and toolbars as
well as the editor. Shortcuts match the physical QWERTY key positions, so they
keep working when the operating-system keyboard layout is changed.

Run the focused document behavior tests with `npm test` from this directory;
`npm run build` type-checks and bundles the app.

## Desktop windows

On desktop, **New Window** (Ctrl+Shift+N), **Open Folder in New Window**, **Open
File in New Window**, and **Open This Project in New Window** create native
Tauri windows in the same application process. **Windows…** lists open Talos
windows and focuses the selected one. Each window has its own active document,
workspace, Problems/Outline state, Explorer history, PDF position, and panel
layout. Themes, editor fonts, extension installation state, and market
configuration remain application-wide.

Saving uses a content revision checked by Rust before writing. If the file
changed since it was loaded (including a save from another Talos window), Talos
offers reload, explicit overwrite, or cancel. Each window now has a tab per
open text document. Tabs retain their CodeMirror state, undo history, selection,
scroll position, and dirty status when switched or closed and reopened. Open
paths are deduplicated within the window; tabs can be closed from their close
button, middle-click, or Ctrl+W. Ctrl+Tab and Ctrl+Shift+Tab navigate tabs,
Ctrl+1 through Ctrl+9 select a tab, and Ctrl+Shift+T reopens a recently closed
tab. Closing a dirty tab or window prompts to save, discard, or cancel.

The optional **Restore this window's open tabs and editor positions on startup**
setting restores the main window's tabs and cursor/scroll positions. Dirty
buffers are stored in that window's local session storage for recovery. This
does not yet restore multiple windows, split editor groups, native window
geometry, or per-window panel dimensions.

## Diagnostics and code outline

The Problems panel reports JSON syntax errors using the active CodeMirror JSON
parser and marks TODO/FIXME/HACK/XXX comments as informational notes where a
supported parser exposes comment nodes. Text inside strings is not treated as a
TODO marker. Talos does not infer compiler errors from bracket-counting
heuristics. The panel includes severity filtering, source labels,
file/line/column locations, and selecting a row moves the editor selection to
its range. CodeMirror's linter supplies the inline underlines, gutter markers,
and hover messages.

The optional Code Outline reads the active CodeMirror syntax tree and currently
extracts class, function, method, interface, type, and top-level variable
symbols for Python, JavaScript, JSX, TypeScript, and TSX. Other languages show
an explicit no-parser message. Talos does not currently run a language server
or claim general compiler diagnostics, completion, or debugging support.

The Architecture Explorer is the Universal Project Workspace on desktop. It
opens any local folder: empty, manifest-free, mixed-language, deeply nested, or
part of a monorepo. A stable workspace identity and the most recently opened
roots are stored in the local configuration directory; the **Recent projects**
selector opens one again without a folder dialog. The scan records nested
files, folders, sizes, modification times, detected languages, file extensions,
counts, and a bounded set of warnings. Missing manifests are not errors, and
unknown languages remain browsable as text rather than being assigned invented
semantics.

Use the top-bar workspace button, **Open Folder** in the Explorer toolbar, or
the command palette's **Open Folder** command to choose a project once. Talos
remembers the canonical root per window and rescans it on startup; if that folder
was moved or removed, it falls back to the newest recent project. **Open Recent
Workspace** focuses the project selector, and the status bar shows the active
workspace, watcher state, and Chronicle indexing activity.

The tree supports expand/collapse, filename filtering, refresh, and contextual
**New file**, **New folder**, **Rename**, **Move…**, **Delete**, and **Copy
path** actions. Rust validates every workspace-relative path, refuses traversal
and moves into a directory's own subtree, rejects symlinked parents, and never
overwrites a file when creating one. Hidden files are off by default; ignore
rules come from the Explorer exclusions plus local `.gitignore`, `.ignore`, and
`.talosignore` files, and the same policy is used by the watcher and Chronicle.
Sensitive paths such as keys and credentials stay excluded. Large scans are
bounded and run off the UI thread; the view renders visible rows only.

To preview frontend changes in the desktop app, run `npm run tauri dev` from
this directory. An installed Linux app does not update when source files
change; rebuild and install its Debian package to update that copy.

## Talos Observatory

On desktop, choose **Observatory** in the activity rail (or the top-bar
**Explorer** button) and select a project folder to open the interactive project
graph, branded as Talos Observatory. File Structure shows folders and files, Dependencies
analyzes statically resolvable local Python and JavaScript/TypeScript imports,
and Architecture groups files using matching names and path segments. Select a
file to see its metadata and import counts; double-click it or use **Open in
editor** to open it in Talos.

Scanning runs off the UI thread, does not follow symbolic links, and excludes
`.git`, `node_modules`, `__pycache__`, `dist`, `build`, `.venv`, and `vendor` by
default. Edit the comma-separated exclusions in the Explorer toolbar. Scans are
capped at 50,000 entries. Dependency analysis reads supported source files
locally (up to 256 KiB per file, 8,000 files, and 16 MiB total); only relative
JavaScript/TypeScript imports and Python modules that resolve to project files
are graphed. Unresolved relative imports are reported rather than guessed.
Unreferenced files may be application entry points and are not labeled as
unused.

Three insight tabs share the same scanned project and local-only rules.
**Performance Budget** measures the real wall time and process CPU time Talos
spends reading and analysing each top-level component, plus peak process RAM
for the whole pass. Budgets are editable and remembered per window, and rows
are marked under, near, or over budget; these are analysis costs, not the
runtime cost of your program. **Dependency Sandbox** reads package manifests
and lockfiles (`package.json`, `package-lock.json`, `requirements.txt`,
`pyproject.toml`, `Cargo.toml`, `Cargo.lock`, `go.mod`, and `go.sum`) and reports
unpinned versions, conflicting constraints, and lockfile mismatches. It is a
read-only, offline check: nothing is installed, no project code runs, and no
network request is made. **Technical Debt** ranks files by a static score from
branch complexity, repeated normalized lines, TODO/FIXME markers, and very long
lines, highlighting hotspots for inspection without claiming to prove bugs.

The project watcher runs for the active workspace and emits debounced,
path-level change events, including while the Explorer is closed. File
create/modify/delete events update affected entries incrementally from metadata;
directory changes cause a rescan, and newly discovered directories are
registered for watching. Watching is capped at 2,000 directories; partial
registration failures emit a visible warning, and **Refresh** remains the
recovery path. Search inputs are debounced, superseded scans are discarded, and
indexing is never performed on a keystroke.

The tree shows unsaved and current-editor error or warning badges; Git,
newly-created/deleted, and background-file diagnostics are not yet integrated.
SVG exports support up to 10,000 visible nodes; PNG exports support up to
1,000. Dependency and architecture views use explicit language adapters:
local JavaScript/TypeScript imports and Python modules are resolved when they
point at workspace files, while other languages are shown as text with detected
language metadata. This is static evidence, not a language server, compiler, or
a claim that every language has semantic analysis. Analysis is local-only; the
Explorer does not send source code to AI or external services.

### Optional GitHub integration

The **GitHub** tab in Observatory is a separate, opt-in section; Source Control
remains unavailable because this build is not a Source Control provider. Add a
GitHub personal access token in that tab to browse repositories on the token,
list issues and pull requests (open, closed, or all), read a conversation and
its comments, create an issue, comment, close/reopen an item, and merge a pull
request. **Open on GitHub** launches the system browser. The token applies to
the whole device, while the chosen owner/repository, Issues/Pulls selection,
state filter, and active Observatory tab are remembered per window.

Talos stores the token encrypted in the local configuration directory with a
locally generated key; on Unix both files are written with owner-only
permissions, and clearing the token removes the encrypted token file. Talos
calls the GitHub REST API directly from this tab only when you ask it to, with
an allow-list of API paths, a request timeout, and no redirects. No account,
telemetry, cloud relay, or background synchronization is involved. If you are
offline, or never open this tab, the editor, marketplace, and the other
Observatory insight tabs work exactly as before. Token scopes are controlled in
GitHub: grant only the repository, issue, and pull-request permissions you want
Talos to use.

## Project and editor navigation

Open a project from the workspace selector or **Observatory** to use project file
search (Ctrl+P). It searches
the scanned workspace by filename/path with fuzzy ranking, shows recent files
when the query is empty, and runs its search in a Web Worker. Workspace roots
and recent files are stored locally. The explorer scan caps results at 50,000
entries and honors its configured directory exclusions.

Ctrl+G opens Go to Line; Ctrl+Shift+O filters symbols from the current file's
supported Code Outline. Ctrl+F opens CodeMirror's Find panel, and Ctrl+H opens
its replacement field. The panel supports case-sensitive and whole-word
matching, regular expressions, next/previous, replace, replace-all, and a
bounded match count. **Find in Files** in the Explorer searches text in scanned
workspace files in a background task; it is bounded by file size, file count,
total bytes, and result count, and respects the active ignore/hidden policy.
It opens matching files but does not perform cross-file replacement.

## Set up Android code execution

No Talos extension or Termux:API add-on is needed. Install the **Termux app**
from F-Droid, open it once, then install the local runtimes:

```sh
pkg update
pkg install python nodejs clang openjdk-21
```

In Termux, enable external app commands by adding this setting to
`~/.termux/termux.properties`:

```text
allow-external-apps = true
```

Restart Termux after changing the setting. In Android Settings, grant Talos
Pocket the **Run commands in Termux environment** permission (App info >
Permissions > Additional permissions). Then open or save a `.py`, `.js`, `.c`,
`.cpp`, or `.java` file in Talos and tap **Run**. For an `.html` file, tap
**Preview** or **Run** to render it inside Talos; inline CSS and JavaScript work
in the preview. Standalone CSS files cannot run by themselves. Programs run on
the phone; each run is limited to 30 seconds and source files are limited to
96 KB.

Termux and its packages must be installed before running. The first package
installation requires an internet connection; Talos does not upload source code
to a remote service when executing programs.

## Build and install on Android

Install Android Studio and its Android SDK, Android SDK Platform-Tools, Android
SDK Build-Tools, Android NDK (Side by side), and CMake. Install JDK 17 and the
Rust Android targets if they are not installed by Tauri. Set `ANDROID_HOME` to
your SDK directory and `NDK_HOME` to its installed NDK directory.

From this directory, initialize and build the Android project:

```sh
npm install
npm run tauri android init
npm run tauri android build -- --apk --target aarch64
```

Find the generated APK under
`src-tauri/gen/android/app/build/outputs/apk/` (the exact subdirectory depends
on the selected ABI). Copy that APK to your Android device and open it to
install, or install it over USB with:

```sh
adb install -r /path/to/the-generated.apk
```

If Android blocks the install, allow your file manager or browser to install
unknown apps, then open the APK again.

To run on a connected device during development:

```sh
npm run tauri android dev
```

## Talos Chronicle

Talos Chronicle stores local project memory in a per-project SQLite database
outside the workspace. Choose **Chronicle** in the activity rail to open its
panel for the current workspace. The panel loads lazily and uses the existing
backend commands to show status, enable or disable Chronicle, start or cancel
indexing, browse the event timeline and recorded decisions, and search indexed
evidence. Results with a source path open in the editor. The Tauri backend
implements bounded incremental indexing, evidence-backed search, timeline,
observations, and recorded decisions; see
[`../docs/chronicle.md`](../docs/chronicle.md) for the architecture, privacy
rules, and IPC surface. No Chronicle work runs on the editor UI thread.

## Offline use and portability

Talos Crest does not require an account, cloud service, or network connection.
The AppImage bundles the frontend, language configs, and WebKitGTK/GTK runtime;
it does not need Node.js or npm on the target machine. It still uses the host
C library, so the current x86_64 build requires glibc 2.38 or newer. Settings
and extension state use `XDG_CONFIG_HOME` when set (otherwise
`~/.config/talos`). Project operations are
validated against the chosen workspace root, and files in read-only directories
are not modified unless the operating system grants write access.

`TALOS_LANG_DIR` can point to an additional directory of run-language JSON
files; there is no hard-coded home-directory fallback. Release builds load the
bundled copies, so moving the AppImage between machines does not depend on the
build machine's paths.

Tails is not tested or officially supported yet. A Tails Persistent Storage
folder can be selected as a workspace like any other directory, but amnesia and
permission behavior vary between Tails versions. Treat Tails support as
experimental: verify that the chosen persistent path is writable and that any
desired files survive reboot before relying on Talos there.
