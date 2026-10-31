# Talos

The Linux desktop edition is **Talos Crest**; the Android edition is **Talos
Pocket**.

Created by Arman Babu Nadaf at Shriptrao Kadam Mahavidyalay, with gratitude to
mentor Sagar Morde. This project is dedicated in their honor. See the root
[MIT License](../LICENSE) for reuse terms.

Talos is a code editor with diagnostics, PDF viewing, extensions, templates, and
code execution. The Android app can run Python, C, C++, and Java programs locally
through Termux; code is sent to the installed Termux app on the same phone, not
uploaded to an online runner. Desktop builds continue to use Talos's configured
language commands.

## Set up Android code execution

Install Termux from F-Droid, open it once, then install the local runtimes:

```sh
pkg update
pkg install python clang openjdk-21
```

In Termux, enable commands from Talos by adding this setting to
`~/.termux/termux.properties`:

```text
allow-external-apps = true
```

Restart Termux after changing the setting. In Android Settings, grant Talos
permission to run commands in the Termux environment (App info > Permissions >
Additional permissions). Then open or save a `.py`, `.c`, `.cpp`, or `.java` file
in Talos and tap **Run**. Programs run on the phone; each run is limited to 30
seconds and source files are limited to 96 KB.

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
