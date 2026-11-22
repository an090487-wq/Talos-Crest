fn main() {
    tauri_plugin::Builder::new(&["run_android_code"])
        .android_path("android")
        .try_build()
        .expect("failed to build runner plugin");
}
