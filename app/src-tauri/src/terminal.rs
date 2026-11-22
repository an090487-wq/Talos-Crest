//! Interactive terminal backend for desktop builds.
//!
//! The terminal is a real pseudo-terminal: Talos owns the master side and
//! spawns the user's default shell on the slave side. Output is streamed to the
//! webview that opened the session, and input/resize/close are forwarded back
//! to the PTY. Android builds get inert command stubs instead.

#[cfg(not(target_os = "android"))]
pub mod platform {
    use std::{
        collections::HashMap,
        env, fs,
        io::{ErrorKind, Read, Write},
        path::PathBuf,
        sync::{Mutex, OnceLock},
        thread,
    };

    use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
    use serde::Serialize;
    use tauri::{Emitter, WebviewWindow};

    const OUTPUT_EVENT: &str = "talos://terminal-output";
    const EXIT_EVENT: &str = "talos://terminal-exit";

    #[derive(Default)]
    struct Registry {
        next_id: u64,
        sessions: HashMap<u64, PtySession>,
    }

    struct PtySession {
        master: Box<dyn MasterPty + Send>,
        writer: Option<Box<dyn Write + Send>>,
        child: Option<Box<dyn Child + Send>>,
    }

    static TERMINALS: OnceLock<Mutex<Registry>> = OnceLock::new();

    fn registry() -> &'static Mutex<Registry> {
        TERMINALS.get_or_init(|| Mutex::new(Registry::default()))
    }

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct TerminalSession {
        pub id: u64,
        pub nonce: String,
        pub cwd: String,
        pub shell: String,
        pub cols: u16,
        pub rows: u16,
    }

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct TerminalOutput {
        session_id: u64,
        nonce: String,
        data: String,
    }

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct TerminalExit {
        session_id: u64,
        nonce: String,
        code: Option<i32>,
        signal: Option<String>,
    }

    /// Accumulates PTY bytes so a multibyte UTF-8 sequence split across two
    /// reads is rendered as one character instead of replacement glyphs.
    #[derive(Default)]
    struct Utf8Accumulator {
        pending: Vec<u8>,
    }

    impl Utf8Accumulator {
        fn push(&mut self, bytes: &[u8]) -> String {
            self.pending.extend_from_slice(bytes);
            let mut output = String::new();

            loop {
                match std::str::from_utf8(&self.pending) {
                    Ok(_) => {
                        if !self.pending.is_empty() {
                            output.push_str(&String::from_utf8_lossy(&self.pending));
                            self.pending.clear();
                        }
                        break;
                    }
                    Err(error) => {
                        let valid = error.valid_up_to();
                        if valid > 0 {
                            output.push_str(&String::from_utf8_lossy(&self.pending[..valid]));
                            self.pending.drain(..valid);
                        }
                        match error.error_len() {
                            Some(invalid) => {
                                output.push('\u{FFFD}');
                                self.pending.drain(..invalid);
                            }
                            None => break,
                        }
                    }
                }
            }

            output
        }

        fn finish(self) -> Option<String> {
            if self.pending.is_empty() {
                None
            } else {
                Some(String::from_utf8_lossy(&self.pending).into_owned())
            }
        }
    }

    fn lock_error() -> String {
        "terminal session state is unavailable".to_string()
    }

    fn resolve_cwd(cwd: Option<String>) -> Result<PathBuf, String> {
        let candidate = cwd
            .map(PathBuf::from)
            .or_else(|| env::current_dir().ok())
            .or_else(|| env::var_os("HOME").map(PathBuf::from))
            .or_else(|| env::var_os("USERPROFILE").map(PathBuf::from))
            .ok_or_else(|| "could not determine a terminal working directory".to_string())?;

        let canonical = fs::canonicalize(&candidate)
            .map_err(|_| format!("workspace folder no longer exists: {}", candidate.display()))?;
        if !canonical.is_dir() {
            return Err(format!("terminal working directory is not a folder: {}", canonical.display()));
        }
        Ok(canonical)
    }

    fn close_and_remove(id: u64) -> Option<(Option<i32>, Option<String>)> {
        let mut registry = registry().lock().ok()?;
        let mut session = registry.sessions.remove(&id)?;
        session.writer.take();
        let status = session
            .child
            .as_mut()
            .and_then(|child| child.try_wait().ok().flatten());
        if status.is_none() {
            if let Some(child) = session.child.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
            return Some((None, None));
        }
        let status = status?;
        Some(match status.signal() {
            Some(signal) => (None, Some(signal.to_string())),
            None => (Some(status.exit_code() as i32), None),
        })
    }

    fn spawn_reader(
        id: u64,
        nonce: String,
        window: WebviewWindow,
        mut reader: Box<dyn Read + Send>,
    ) -> Result<(), String> {
        thread::Builder::new()
            .name(format!("talos-pty-{id}"))
            .spawn(move || {
                let mut buffer = [0u8; 8192];
                let mut pending = Utf8Accumulator::default();

                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(count) => {
                            let data = pending.push(&buffer[..count]);
                            if data.is_empty() {
                                continue;
                            }
                            let payload = TerminalOutput {
                                session_id: id,
                                nonce: nonce.clone(),
                                data,
                            };
                            if window.emit(OUTPUT_EVENT, payload).is_err() {
                                break;
                            }
                        }
                        Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }

                if let Some(data) = pending.finish() {
                    let _ = window.emit(
                        OUTPUT_EVENT,
                        TerminalOutput {
                            session_id: id,
                            nonce: nonce.clone(),
                            data,
                        },
                    );
                }

                let (code, signal) = close_and_remove(id).unwrap_or((None, None));
                let _ = window.emit(
                    EXIT_EVENT,
                    TerminalExit {
                        session_id: id,
                        nonce,
                        code,
                        signal,
                    },
                );
            })
            .map(|_| ())
            .map_err(|error| format!("could not start terminal output reader: {error}"))
    }

    #[tauri::command]
    pub fn terminal_open(
        window: WebviewWindow,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        nonce: String,
    ) -> Result<TerminalSession, String> {
        let cols = cols.clamp(20, 400);
        let rows = rows.clamp(4, 200);
        let cwd = resolve_cwd(cwd)?;

        let mut command = CommandBuilder::new_default_prog();
        let shell = env::var("SHELL")
            .ok()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| if cfg!(windows) { "cmd.exe" } else { "/bin/sh" }.to_string());
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("TALOS_TERMINAL", "1");
        command.cwd(&cwd);

        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("could not create terminal: {error}"))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("could not read terminal output: {error}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("could not open terminal input: {error}"))?;
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("could not start shell: {error}"))?;
        drop(pair.slave);

        let session = {
            let mut registry = registry().lock().map_err(|_| lock_error())?;
            registry.next_id = registry.next_id.wrapping_add(1);
            if registry.next_id == 0 {
                registry.next_id = 1;
            }
            let id = registry.next_id;
            registry.sessions.insert(
                id,
                PtySession {
                    master: pair.master,
                    writer: Some(writer),
                    child: Some(child),
                },
            );
            TerminalSession {
                id,
                nonce: nonce.clone(),
                cwd: cwd.to_string_lossy().into_owned(),
                shell,
                cols,
                rows,
            }
        };

        if let Err(error) = spawn_reader(session.id, nonce, window, reader) {
            let _ = terminal_close(session.id);
            return Err(error);
        }

        Ok(session)
    }

    #[tauri::command]
    pub fn terminal_write(id: u64, data: String) -> Result<(), String> {
        let mut registry = registry().lock().map_err(|_| lock_error())?;
        let session = registry
            .sessions
            .get_mut(&id)
            .ok_or_else(|| "terminal session is no longer running".to_string())?;
        let writer = session
            .writer
            .as_mut()
            .ok_or_else(|| "terminal input is closed".to_string())?;
        writer
            .write_all(data.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|error| format!("could not write to terminal: {error}"))
    }

    #[tauri::command]
    pub fn terminal_resize(id: u64, cols: u16, rows: u16) -> Result<(), String> {
        let cols = cols.clamp(20, 400);
        let rows = rows.clamp(4, 200);
        let mut registry = registry().lock().map_err(|_| lock_error())?;
        let session = registry
            .sessions
            .get_mut(&id)
            .ok_or_else(|| "terminal session is no longer running".to_string())?;
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("could not resize terminal: {error}"))
    }

    #[tauri::command]
    pub fn terminal_close(id: u64) -> Result<(), String> {
        let mut registry = registry().lock().map_err(|_| lock_error())?;
        if let Some(mut session) = registry.sessions.remove(&id) {
            session.writer.take();
            if let Some(child) = session.child.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::Utf8Accumulator;

        #[test]
        fn keeps_split_utf8_together() {
            let mut accumulator = Utf8Accumulator::default();
            assert_eq!(accumulator.push(&[0xF0, 0x9F]), "");
            assert_eq!(accumulator.push(&[0x9A, 0x80, b'!']), "🚀!");
        }

        #[test]
        fn replaces_invalid_utf8() {
            let mut accumulator = Utf8Accumulator::default();
            assert_eq!(accumulator.push(&[b'a', 0xFF, b'b']), "a\u{FFFD}b");
        }
    }
}

#[cfg(target_os = "android")]
pub mod platform {
    #[tauri::command]
    pub fn terminal_open(
        _window: tauri::WebviewWindow,
        _cwd: Option<String>,
        _cols: u16,
        _rows: u16,
        _nonce: String,
    ) -> Result<(), String> {
        Err("The integrated terminal is available on desktop builds only.".to_string())
    }

    #[tauri::command]
    pub fn terminal_write(_id: u64, _data: String) -> Result<(), String> {
        Err("The integrated terminal is available on desktop builds only.".to_string())
    }

    #[tauri::command]
    pub fn terminal_resize(_id: u64, _cols: u16, _rows: u16) -> Result<(), String> {
        Err("The integrated terminal is available on desktop builds only.".to_string())
    }

    #[tauri::command]
    pub fn terminal_close(_id: u64) -> Result<(), String> {
        Err("The integrated terminal is available on desktop builds only.".to_string())
    }
}
