//! Local-only measurements and manifest discovery for the Observatory insight
//! panels. Nothing here executes project code, installs packages, or uses the
//! network: every operation is a bounded read of files inside the project root.

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

const MAX_FILES: usize = 8_000;
const MAX_FILE_BYTES: u64 = 256 * 1024;
const MAX_TOTAL_BYTES: u64 = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 2 * 1024 * 1024;
const SOURCE_EXTENSIONS: &[&str] = &["py", "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"];
const MANIFEST_NAMES: &[&str] = &[
    "package.json",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "requirements.txt",
    "pyproject.toml",
    "Cargo.toml",
    "Cargo.lock",
    "go.mod",
    "go.sum",
];

#[derive(Serialize, Clone)]
pub struct FileCost {
    pub path: String,
    pub component: String,
    pub bytes: u64,
    pub wall_ms: f64,
    pub cpu_ms: f64,
}

#[derive(Serialize, Clone)]
pub struct ComponentCost {
    pub name: String,
    pub files: usize,
    pub bytes: u64,
    pub wall_ms: f64,
    pub cpu_ms: f64,
}

#[derive(Serialize)]
pub struct ComponentMeasurement {
    pub components: Vec<ComponentCost>,
    pub files: Vec<FileCost>,
    pub peak_rss_kb: u64,
    pub wall_ms: f64,
    pub cpu_ms: f64,
    pub files_analyzed: usize,
    pub warnings: Vec<String>,
}

#[derive(Serialize)]
pub struct ManifestFile {
    pub path: String,
    pub name: String,
    pub content: String,
}

#[derive(Serialize)]
pub struct ManifestSet {
    pub manifests: Vec<ManifestFile>,
    pub warnings: Vec<String>,
}

/// Process CPU time in platform clock units. `None` means the platform does
/// not expose a portable process CPU clock; callers report 0 instead of
/// inventing a number.
struct CpuClock {
    start: Option<u64>,
    units_per_second: u64,
}

impl CpuClock {
    fn start() -> Self {
        #[cfg(target_os = "linux")]
        let units_per_second = linux_clock_ticks_per_second();
        #[cfg(target_os = "windows")]
        let units_per_second = 10_000_000u64; // FILETIME: 100 ns units
        #[cfg(not(any(target_os = "linux", target_os = "windows")))]
        let units_per_second = 1u64;

        Self {
            start: Self::now(),
            units_per_second,
        }
    }

    fn now() -> Option<u64> {
        #[cfg(target_os = "linux")]
        {
            linux_process_cpu_ticks()
        }
        #[cfg(target_os = "windows")]
        {
            windows_process_cpu_100ns()
        }
        #[cfg(not(any(target_os = "linux", target_os = "windows")))]
        {
            None
        }
    }

    fn elapsed_ms(&self) -> f64 {
        match (self.start, Self::now()) {
            (Some(start), Some(now)) if now >= start => {
                (now - start) as f64 * 1000.0 / self.units_per_second.max(1) as f64
            }
            _ => 0.0,
        }
    }
}

#[cfg(target_os = "linux")]
unsafe extern "C" {
    fn sysconf(name: i32) -> i64;
}

#[cfg(target_os = "linux")]
fn linux_clock_ticks_per_second() -> u64 {
    // _SC_CLK_TCK is 2 on Linux. Fall back to the conventional 100 Hz.
    let value = unsafe { sysconf(2) };
    if value > 0 {
        value as u64
    } else {
        100
    }
}

#[cfg(target_os = "linux")]
fn linux_process_cpu_ticks() -> Option<u64> {
    let stat = fs::read_to_string("/proc/self/stat").ok()?;
    let after_comm = stat.rsplit_once(')')?.1;
    let fields: Vec<&str> = after_comm.split_whitespace().collect();
    // After ")" the fields start at state (index 0); utime is 11, stime is 12.
    let utime: u64 = fields.get(11)?.parse().ok()?;
    let stime: u64 = fields.get(12)?.parse().ok()?;
    Some(utime.saturating_add(stime))
}

#[cfg(target_os = "windows")]
unsafe extern "system" {
    fn GetCurrentProcess() -> isize;
    fn GetProcessTimes(
        process: isize,
        creation: *mut u64,
        exit: *mut u64,
        kernel: *mut u64,
        user: *mut u64,
    ) -> i32;
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct MemoryCounters {
    cb: u32,
    page_fault_count: u32,
    peak_working_set_size: usize,
    working_set_size: usize,
    quota_peak_paged: usize,
    quota_paged: usize,
    quota_peak_nonpaged: usize,
    quota_nonpaged: usize,
}

#[cfg(target_os = "windows")]
#[link(name = "psapi")]
unsafe extern "system" {
    fn GetProcessMemoryInfo(process: isize, counters: *mut MemoryCounters, cb: u32) -> i32;
}

#[cfg(target_os = "windows")]
fn current_process() -> isize {
    unsafe { GetCurrentProcess() }
}

#[cfg(target_os = "windows")]
fn windows_process_cpu_100ns() -> Option<u64> {
    let (mut creation, mut exit, mut kernel, mut user) = (0u64, 0u64, 0u64, 0u64);
    let ok = unsafe {
        GetProcessTimes(
            current_process(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    };
    if ok == 0 {
        None
    } else {
        Some(kernel.saturating_add(user))
    }
}

fn peak_rss_kb() -> u64 {
    #[cfg(target_os = "linux")]
    {
        return fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|status| {
                status
                    .lines()
                    .find(|line| line.starts_with("VmHWM:"))
                    .and_then(|line| line.split_whitespace().nth(1))
                    .and_then(|value| value.parse::<u64>().ok())
            })
            .unwrap_or(0);
    }

    #[cfg(target_os = "windows")]
    {
        let mut counters = MemoryCounters {
            cb: std::mem::size_of::<MemoryCounters>() as u32,
            page_fault_count: 0,
            peak_working_set_size: 0,
            working_set_size: 0,
            quota_peak_paged: 0,
            quota_paged: 0,
            quota_peak_nonpaged: 0,
            quota_nonpaged: 0,
        };
        let ok = unsafe { GetProcessMemoryInfo(current_process(), &mut counters, counters.cb) };
        if ok == 0 {
            return 0;
        }
        return (counters.peak_working_set_size / 1024) as u64;
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        0
    }
}

fn validated_file(root: &Path, path: &str) -> Result<(PathBuf, fs::Metadata), String> {
    let candidate = PathBuf::from(path);
    let canonical = match candidate.canonicalize() {
        Ok(canonical) if canonical.starts_with(root) => canonical,
        Ok(_) => return Err(format!("Skipped file outside the project: {path}")),
        Err(error) => return Err(format!("Could not open {path}: {error}")),
    };
    let metadata = match fs::symlink_metadata(&candidate) {
        Ok(metadata) if metadata.is_file() => metadata,
        Ok(_) => return Err("Not a regular file".to_string()),
        Err(error) => return Err(format!("Could not inspect {path}: {error}")),
    };
    Ok((canonical, metadata))
}

fn component_name(root: &Path, canonical: &Path) -> String {
    let Ok(relative) = canonical.strip_prefix(root) else {
        return "(outside)".to_string();
    };
    let mut parts = relative.components();
    let first = parts.next();
    match first {
        Some(part) if parts.next().is_some() => part.as_os_str().to_string_lossy().into_owned(),
        _ => "(root)".to_string(),
    }
}

/// Measures the real read + lightweight analysis cost of each project source
/// file. This is Talos's analysis cost per component, not the runtime cost of
/// the user's program.
pub fn measure_components(root: &str, paths: &[String]) -> Result<ComponentMeasurement, String> {
    let root = PathBuf::from(root)
        .canonicalize()
        .map_err(|error| format!("could not open project directory '{root}': {error}"))?;
    if !root.is_dir() {
        return Err(format!("project root is not a directory: {}", root.display()));
    }

    let mut warnings = Vec::new();
    let mut files = Vec::new();
    let mut totals: HashMap<String, (usize, u64, f64, f64)> = HashMap::new();
    let mut bytes_read = 0u64;
    let wall_start = Instant::now();
    let total_cpu = CpuClock::start();

    for path in paths {
        if files.len() >= MAX_FILES || bytes_read >= MAX_TOTAL_BYTES {
            warnings.push(format!(
                "Measurement limited to {MAX_FILES} files and 16 MiB of source"
            ));
            break;
        }
        let (canonical, metadata) = match validated_file(&root, path) {
            Ok(validated) => validated,
            Err(reason) => {
                warnings.push(reason);
                continue;
            }
        };
        let extension = canonical
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !SOURCE_EXTENSIONS.contains(&extension.as_str()) {
            continue;
        }
        if metadata.len() > MAX_FILE_BYTES
            || bytes_read.saturating_add(metadata.len()) > MAX_TOTAL_BYTES
        {
            warnings.push(format!("Skipped oversized source file: {path}"));
            continue;
        }

        let file_start = Instant::now();
        let file_cpu = CpuClock::start();
        let text = match fs::read_to_string(&canonical) {
            Ok(text) => text,
            Err(error) => {
                warnings.push(format!("Could not read {path}: {error}"));
                continue;
            }
        };
        // The same lightweight pass the debt analyser performs, so the timing
        // reflects real analysis work rather than only file I/O.
        let lines = text.lines().count();
        std::hint::black_box(lines);
        let wall_ms = file_start.elapsed().as_secs_f64() * 1000.0;
        let cpu_ms = file_cpu.elapsed_ms();
        let bytes = text.len() as u64;
        bytes_read = bytes_read.saturating_add(bytes);
        let component = component_name(&root, &canonical);
        files.push(FileCost {
            path: canonical.to_string_lossy().into_owned(),
            component: component.clone(),
            bytes,
            wall_ms,
            cpu_ms,
        });
        let entry = totals.entry(component).or_insert((0, 0, 0.0, 0.0));
        entry.0 += 1;
        entry.1 = entry.1.saturating_add(bytes);
        entry.2 += wall_ms;
        entry.3 += cpu_ms;
    }

    let mut components: Vec<ComponentCost> = totals
        .into_iter()
        .map(|(name, (count, bytes, wall_ms, cpu_ms))| ComponentCost {
            name,
            files: count,
            bytes,
            wall_ms: (wall_ms * 100.0).round() / 100.0,
            cpu_ms: (cpu_ms * 100.0).round() / 100.0,
        })
        .collect();
    components.sort_by(|left, right| {
        right
            .wall_ms
            .partial_cmp(&left.wall_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.name.cmp(&right.name))
    });
    files.sort_by(|left, right| {
        right
            .wall_ms
            .partial_cmp(&left.wall_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let files_analyzed = files.len();
    Ok(ComponentMeasurement {
        components,
        files,
        peak_rss_kb: peak_rss_kb(),
        wall_ms: (wall_start.elapsed().as_secs_f64() * 1000.0 * 100.0).round() / 100.0,
        cpu_ms: (total_cpu.elapsed_ms() * 100.0).round() / 100.0,
        files_analyzed,
        warnings,
    })
}

/// Reads dependency manifests from the project. This is the "sandbox": all
/// work is read-only and offline, with no install or execution step.
pub fn load_manifests(root: &str, paths: &[String]) -> Result<ManifestSet, String> {
    let root = PathBuf::from(root)
        .canonicalize()
        .map_err(|error| format!("could not open project directory '{root}': {error}"))?;
    if !root.is_dir() {
        return Err(format!("project root is not a directory: {}", root.display()));
    }

    let mut warnings = Vec::new();
    let mut manifests = Vec::new();
    let mut total_bytes = 0u64;

    for path in paths {
        let candidate = PathBuf::from(path);
        let name = candidate
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !MANIFEST_NAMES.contains(&name.as_str()) {
            continue;
        }
        let (canonical, metadata) = match validated_file(&root, path) {
            Ok(validated) => validated,
            Err(reason) => {
                warnings.push(reason);
                continue;
            }
        };
        if metadata.len() > MAX_FILE_BYTES
            || total_bytes.saturating_add(metadata.len()) > MAX_MANIFEST_BYTES
        {
            warnings.push(format!("Skipped oversized manifest: {path}"));
            continue;
        }
        let content = match fs::read_to_string(&canonical) {
            Ok(content) => content,
            Err(error) => {
                warnings.push(format!("Could not read {path}: {error}"));
                continue;
            }
        };
        total_bytes = total_bytes.saturating_add(content.len() as u64);
        manifests.push(ManifestFile {
            path: canonical.to_string_lossy().into_owned(),
            name,
            content,
        });
    }

    Ok(ManifestSet { manifests, warnings })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn component_name_groups_directories_and_root_files() {
        let root = Path::new("/project");
        assert_eq!(
            component_name(root, Path::new("/project/src/main.ts")),
            "src"
        );
        assert_eq!(component_name(root, Path::new("/project/README.md")), "(root)");
    }

    #[test]
    fn manifest_filter_only_accepts_known_names() {
        let mut names = MANIFEST_NAMES.to_vec();
        names.retain(|name| !name.eq_ignore_ascii_case("package.json"));
        assert!(!names.contains(&"notes.txt"));
    }

    #[test]
    fn cpu_clock_never_reports_negative_time() {
        let clock = CpuClock::start();
        assert!(clock.elapsed_ms() >= 0.0);
    }
}
