use talos_core::meter::{measure, Diagnostic, Severity};

fn main() {
    let cases: Vec<(&str, Vec<Severity>)> = vec![
        ("no problems", vec![]),
        ("one warning", vec![Severity::Warning]),
        ("one error", vec![Severity::Error]),
        ("two errors, two warnings", vec![Severity::Error, Severity::Error, Severity::Warning, Severity::Warning]),
        ("five errors", vec![Severity::Error; 5]),
    ];

    for (name, sevs) in cases {
        let diags: Vec<Diagnostic> = sevs
            .into_iter()
            .enumerate()
            .map(|(i, severity)| Diagnostic { severity, line: i as u32 + 1, message: String::new() })
            .collect();
        let r = measure(&diags, 20);
        println!(
            "{:<26} score {:>3}  {:<16} | fun: {}",
            name, r.score, r.level.label(), r.level.fun_caption()
        );
    }
}
