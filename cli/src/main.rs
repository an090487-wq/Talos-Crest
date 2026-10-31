use std::{
    env,
    path::{Path, PathBuf},
    process::{exit, Command},
};
use talos_core::language::Registry;

fn lang_dir() -> PathBuf {
    env::var("TALOS_LANG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("languages"))
}

fn usage() -> ! {
    eprintln!("tcode - Talos command line\n");
    eprintln!("  tcode langs           list supported languages");
    eprintln!("  tcode detect <file>   show which language a file is");
    eprintln!("  tcode run <file>      run a file with its language's runner");
    exit(2);
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let dir = lang_dir();
    let registry = match Registry::load_dir(&dir) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("tcode: cannot load languages from {}: {e}", dir.display());
            eprintln!("(run from the project root, or set TALOS_LANG_DIR)");
            exit(1);
        }
    };

    match args.first().map(String::as_str) {
        Some("langs") => {
            for l in registry.all() {
                println!("{:<12} {:<14} {}", l.id, l.name, l.extensions.join(" "));
            }
        }
        Some("detect") => {
            let Some(file) = args.get(1) else { usage() };
            match registry.detect(Path::new(file)) {
                Some(l) => println!("{} ({})", l.name, l.id),
                None => {
                    eprintln!("tcode: unknown language for {file}");
                    exit(1);
                }
            }
        }
        Some("run") => {
            let Some(file) = args.get(1) else { usage() };
            let path = Path::new(file);
            let Some(lang) = registry.detect(path) else {
                eprintln!("tcode: unknown language for {file}");
                exit(1);
            };
            let Some(cmd) = lang.run_command(path) else {
                eprintln!("tcode: {} has no run command configured", lang.name);
                exit(1);
            };
            let status = Command::new("sh").arg("-c").arg(&cmd).status();
            match status {
                Ok(s) => exit(s.code().unwrap_or(1)),
                Err(e) => {
                    eprintln!("tcode: failed to start '{cmd}': {e}");
                    exit(1);
                }
            }
        }
        _ => usage(),
    }
}
