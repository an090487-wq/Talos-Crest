//! Error Meter: turns a list of diagnostics into a 0-100 score and a level.
//!
//! Score = saturating curve over "pressure", where pressure is the weighted
//! diagnostic total scaled by file size (so the same errors weigh less in a
//! big file than in a tiny one).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
    Info,
    Hint,
}

impl Severity {
    fn weight(self) -> u32 {
        match self {
            Severity::Error => 10,
            Severity::Warning => 3,
            Severity::Info => 1,
            Severity::Hint => 0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Diagnostic {
    pub severity: Severity,
    pub line: u32,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Clean,
    Stable,
    Warning,
    Critical,
    Failing,
}

impl Level {
    fn from_score(score: u32) -> Level {
        match score {
            0 => Level::Clean,
            1..=15 => Level::Stable,
            16..=40 => Level::Warning,
            41..=70 => Level::Critical,
            _ => Level::Failing,
        }
    }

    /// Professional label (default mode).
    pub fn label(self) -> &'static str {
        match self {
            Level::Clean => "Clean",
            Level::Stable => "Stable",
            Level::Warning => "Needs attention",
            Level::Critical => "Critical",
            Level::Failing => "Failing",
        }
    }

    /// Text caption for Fun mode (images/sounds get attached later).
    pub fn fun_caption(self) -> &'static str {
        match self {
            Level::Clean => "Suspiciously perfect.",
            Level::Stable => "Tiny bumps. We move.",
            Level::Warning => "This is fine. (It is not fine.)",
            Level::Critical => "Send help and coffee.",
            Level::Failing => "Have you tried turning it off and on again?",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeterReading {
    pub score: u32, // 0..=100
    pub level: Level,
    pub errors: usize,
    pub warnings: usize,
}

/// Measures diagnostics for a file with `total_lines` lines.
pub fn measure(diags: &[Diagnostic], total_lines: usize) -> MeterReading {
    let raw: u32 = diags.iter().map(|d| d.severity.weight()).sum();
    let errors = diags.iter().filter(|d| d.severity == Severity::Error).count();
    let warnings = diags.iter().filter(|d| d.severity == Severity::Warning).count();

    let score = if raw == 0 {
        0
    } else {
        // Files under 20 lines count as 20, so tiny files aren't punished.
        let size_factor = total_lines.max(20) as f64 / 20.0;
        let pressure = raw as f64 / size_factor;
        (100.0 * pressure / (pressure + 20.0)).round() as u32
    };

    MeterReading {
        score,
        level: Level::from_score(score),
        errors,
        warnings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(sev: Severity) -> Diagnostic {
        Diagnostic { severity: sev, line: 1, message: String::new() }
    }

    #[test]
    fn no_diagnostics_is_clean() {
        let r = measure(&[], 100);
        assert_eq!(r.score, 0);
        assert_eq!(r.level, Level::Clean);
    }

    #[test]
    fn hints_alone_stay_clean() {
        let r = measure(&[d(Severity::Hint), d(Severity::Hint)], 50);
        assert_eq!(r.level, Level::Clean);
    }

    #[test]
    fn one_error_in_small_file_is_warning_level() {
        let r = measure(&[d(Severity::Error)], 20);
        assert_eq!(r.level, Level::Warning);
        assert_eq!(r.errors, 1);
    }

    #[test]
    fn many_errors_fail() {
        let diags: Vec<_> = (0..5).map(|_| d(Severity::Error)).collect();
        let r = measure(&diags, 20);
        assert_eq!(r.level, Level::Failing);
    }

    #[test]
    fn same_errors_weigh_less_in_bigger_file() {
        let diags = vec![d(Severity::Error), d(Severity::Error)];
        let small = measure(&diags, 20);
        let big = measure(&diags, 2000);
        assert!(big.score < small.score);
    }

    #[test]
    fn score_never_exceeds_100() {
        let diags: Vec<_> = (0..10_000).map(|_| d(Severity::Error)).collect();
        assert!(measure(&diags, 20).score <= 100);
    }
}
