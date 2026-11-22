use tauri::{
    Runtime,
    plugin::{Builder, TauriPlugin},
};

#[cfg(target_os = "android")]
use serde::{Deserialize, Serialize};
#[cfg(target_os = "android")]
use tauri::{Manager, plugin::PluginHandle};

#[cfg(target_os = "android")]
#[derive(Clone)]
struct Runner<R: Runtime>(PluginHandle<R>);

#[cfg(target_os = "android")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunRequest<'a> {
    language: &'a str,
    source: &'a str,
}

#[cfg(target_os = "android")]
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunResponse {
    stdout: String,
    stderr: String,
    code: i32,
    language: String,
}

#[cfg(target_os = "android")]
#[tauri::command]
fn run_android_code(
   runner: tauri::State<'_, Runner<tauri::Wry>>,
    language: String,
    source: String,
) -> Result<RunResponse, String> {
    runner
        .0
        .run_mobile_plugin(
            "runAndroidCode",
            RunRequest {
                language: &language,
                source: &source,
            },
        )
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "android")]
pub fn init() -> TauriPlugin<tauri::Wry> {
    Builder::new("runner")
        .invoke_handler(tauri::generate_handler![run_android_code])
        .setup(|app, api| {
            let runner = api.register_android_plugin("com.talos.runner", "RunnerPlugin")?;
            app.manage(Runner(runner));
            Ok(())
        })
        .build()
}

#[cfg(not(target_os = "android"))]
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("runner")
        .build()
}
