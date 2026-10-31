# Talos

Talos is an open-source code editor with diagnostics, a PDF viewer, extensions,
templates, and local code execution.

The Linux desktop edition is **Talos Crest**. The Android edition is **Talos
Pocket**. The Tauri platform configuration selects the appropriate product name
when building each edition.

Created by Arman Babu Nadaf at Shriptrao Kadam Mahavidyalay, with gratitude to
mentor Sagar Morde. This project is dedicated in their honor.

## Build

### Linux desktop (Debian package)

Install Node.js, Rust, and the Tauri Linux prerequisites, then run:

```sh
cd app
npm install
npm run tauri build -- --bundles deb
```

### Android

Install Android Studio and the Android SDK/NDK, JDK 17, and the Rust Android
target. From `app/`, initialize and build:

```sh
npm install
npm run tauri android init
npm run tauri android build -- --apk --target aarch64
```

See [app/README.md](app/README.md) for Android setup and local Termux execution
requirements.

## License

Distributed under the [MIT License](LICENSE).