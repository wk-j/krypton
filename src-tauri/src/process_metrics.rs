// Krypton — Process metrics sampler.
//
// Long-lived `sysinfo::System` shared across metric polls. One refresh per
// poll covers every ACP lane and its descendants — cost stays flat as the
// lane count grows. Holding the snapshot between calls also gives sysinfo
// the prior baseline it needs to report a non-zero `cpu_usage()` (the
// first call after sampler creation reports 0%, subsequent calls are
// real). See docs/0091-acp-lane-resource-metrics.md.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize)]
pub struct ProcMetric {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub name: String,
    /// Full argv. The bare `name` ("node", "python3") is useless once a lane
    /// spawns half a dozen interpreters; the command line is what tells the
    /// user *which* MCP server / script each process actually is. The frontend
    /// derives a short label (package / module / script basename) and shows the
    /// joined command on hover. Bounded defensively — see `clamp_cmd`.
    pub cmd: Vec<String>,
    /// Resolved executable path, when sysinfo can read it. Fallback label
    /// source when argv is empty (e.g. permission-restricted process).
    pub exe: Option<String>,
    pub cpu_percent: f64,
    pub rss_mb: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TreeMetrics {
    pub root_pid: u32,
    pub root_alive: bool,
    pub cpu_ready: bool,
    pub total_cpu_percent: f64,
    pub total_rss_mb: f64,
    pub proc_count: u32,
    pub processes: Vec<ProcMetric>,
}
/// Captured at spawn, never learned from a later metrics poll.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub start_time: u64,
    /// OS birth token: microseconds on macOS, clock ticks on Linux, FILETIME on Windows.
    birth_token: u64,
}

impl ProcessIdentity {
    pub fn capture(pid: u32) -> Option<Self> {
        let mut sys = sysinfo::System::new();
        sys.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(pid)]),
            true,
            sysinfo::ProcessRefreshKind::nothing(),
        );
        sys.process(sysinfo::Pid::from_u32(pid))
            .and_then(|process| {
                Some(Self {
                    pid,
                    start_time: process.start_time(),
                    birth_token: process_birth_token(pid, process.start_time())?,
                })
            })
    }

    fn matches(&self, process: &sysinfo::Process) -> bool {
        self.start_time == process.start_time()
            && process_birth_token(self.pid, process.start_time()) == Some(self.birth_token)
    }
}
#[cfg(target_os = "macos")]
fn process_birth_token(pid: u32, _start_time: u64) -> Option<u64> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
    let size = std::mem::size_of::<libc::proc_bsdinfo>();
    let read = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size as i32,
        )
    };
    if read != size as i32 {
        return None;
    }
    let info = unsafe { info.assume_init() };
    Some(info.pbi_start_tvsec.saturating_mul(1_000_000) + info.pbi_start_tvusec)
}

#[cfg(target_os = "linux")]
fn process_birth_token(pid: u32, _start_time: u64) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // comm may itself contain spaces and parentheses. Field 22 follows the
    // final ')' and the 19 fields beginning with state (field 3).
    stat.rsplit_once(')')?
        .1
        .split_whitespace()
        .nth(19)?
        .parse()
        .ok()
}

#[cfg(target_os = "windows")]
fn process_birth_token(pid: u32, _start_time: u64) -> Option<u64> {
    use std::ffi::c_void;
    use std::mem::MaybeUninit;

    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        #[link_name = "OpenProcess"]
        fn open_process(access: u32, inherit_handle: i32, pid: u32) -> *mut c_void;
        #[link_name = "GetProcessTimes"]
        fn get_process_times(
            process: *mut c_void,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
        #[link_name = "CloseHandle"]
        fn close_handle(handle: *mut c_void) -> i32;
    }

    // PROCESS_QUERY_LIMITED_INFORMATION; no debug privilege or full-access handle.
    let process = unsafe { open_process(0x1000, 0, pid) };
    if process.is_null() {
        return None;
    }
    let mut creation = MaybeUninit::<FileTime>::uninit();
    let mut exit = MaybeUninit::<FileTime>::uninit();
    let mut kernel = MaybeUninit::<FileTime>::uninit();
    let mut user = MaybeUninit::<FileTime>::uninit();
    let success = unsafe {
        get_process_times(
            process,
            creation.as_mut_ptr(),
            exit.as_mut_ptr(),
            kernel.as_mut_ptr(),
            user.as_mut_ptr(),
        )
    };
    unsafe {
        close_handle(process);
    }
    if success == 0 {
        return None;
    }
    let creation = unsafe { creation.assume_init() };
    Some((u64::from(creation.high) << 32) | u64::from(creation.low))
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn process_birth_token(_pid: u32, _start_time: u64) -> Option<u64> {
    // Do not attach a reused PID's resources when precise identity is unavailable.
    None
}

pub struct MetricsSampler {
    sys: Mutex<sysinfo::System>,
    sampled: Mutex<HashMap<ProcessIdentity, std::time::Instant>>,
}

impl MetricsSampler {
    pub fn new() -> Self {
        Self {
            sys: Mutex::new(sysinfo::System::new()),
            sampled: Mutex::new(HashMap::new()),
        }
    }

    /// Refresh once and collect metrics for each root PID and its descendants.
    pub fn collect(&self, roots: &[ProcessIdentity]) -> Vec<TreeMetrics> {
        let mut sys = match self.sys.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        // Mirror the default `refresh_processes` kind but also pull `cmd` —
        // the default omits it, so `Process::cmd()` would be empty and the
        // breakdown could only show bare interpreter names. `OnlyIfNotSet`
        // means cmd/exe are read once per process and cached, so the per-tick
        // cost stays flat (cmd doesn't change over a process's lifetime).
        sys.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::All,
            true,
            sysinfo::ProcessRefreshKind::nothing()
                .with_memory()
                .with_cpu()
                .with_disk_usage()
                .with_exe(sysinfo::UpdateKind::OnlyIfNotSet)
                .with_cmd(sysinfo::UpdateKind::OnlyIfNotSet)
                .with_tasks(),
        );

        // parent_pid -> children
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        for (pid, proc_) in sys.processes() {
            if let Some(parent) = proc_.parent() {
                children
                    .entry(parent.as_u32())
                    .or_default()
                    .push(pid.as_u32());
            }
        }

        let mut sampled = self.sampled.lock().unwrap_or_else(|p| p.into_inner());
        sampled.retain(|identity, _| roots.contains(identity));
        let now = std::time::Instant::now();
        roots
            .iter()
            .map(|root| {
                let mut tree = collect_tree(&sys, &children, *root);
                if tree.root_alive {
                    tree.cpu_ready = sampled.get(root).is_some_and(|first| {
                        now.duration_since(*first) >= sysinfo::MINIMUM_CPU_UPDATE_INTERVAL
                    });
                    sampled.entry(*root).or_insert(now);
                }
                tree
            })
            .collect()
    }
}

impl Default for MetricsSampler {
    fn default() -> Self {
        Self::new()
    }
}

fn collect_tree(
    sys: &sysinfo::System,
    children: &HashMap<u32, Vec<u32>>,
    identity: ProcessIdentity,
) -> TreeMetrics {
    let root = identity.pid;
    let root_proc = sys.process(sysinfo::Pid::from_u32(root));
    if !root_proc.is_some_and(|process| identity.matches(process)) {
        return TreeMetrics {
            root_pid: root,
            root_alive: false,
            cpu_ready: false,
            total_cpu_percent: 0.0,
            total_rss_mb: 0.0,
            proc_count: 0,
            processes: Vec::new(),
        };
    }

    let mut processes: Vec<ProcMetric> = Vec::new();
    let mut total_cpu = 0.0_f64;
    let mut total_rss = 0.0_f64;

    // BFS — bound depth/visited so a pathological cycle (shouldn't happen on
    // real /proc, but defensive) can't hang the sampler thread.
    let mut queue: Vec<u32> = vec![root];
    let mut seen: std::collections::HashSet<u32> = std::collections::HashSet::new();
    while let Some(pid) = queue.pop() {
        if !seen.insert(pid) {
            continue;
        }
        if seen.len() > 4096 {
            break;
        }
        let Some(p) = sys.process(sysinfo::Pid::from_u32(pid)) else {
            continue;
        };
        let cpu = p.cpu_usage() as f64;
        let rss = p.memory() as f64 / (1024.0 * 1024.0);
        total_cpu += cpu;
        total_rss += rss;
        processes.push(ProcMetric {
            pid,
            parent_pid: p.parent().map(|pp| pp.as_u32()),
            name: p.name().to_string_lossy().to_string(),
            cmd: clamp_cmd(p.cmd()),
            exe: p.exe().map(|path| clamp_str(&path.to_string_lossy())),
            cpu_percent: cpu,
            rss_mb: rss,
        });
        if let Some(kids) = children.get(&pid) {
            for &k in kids {
                queue.push(k);
            }
        }
    }

    TreeMetrics {
        root_pid: root,
        root_alive: true,
        cpu_ready: false,
        total_cpu_percent: total_cpu,
        total_rss_mb: total_rss,
        proc_count: processes.len() as u32,
        processes,
    }
}

/// Upper bound on argv we ship per process. A pathological command line (a
/// `node -e '<huge inline script>'` or a giant `--flag=<blob>`) must not bloat
/// the 2 Hz metrics payload. Paths and module names — the parts the label is
/// derived from — sit comfortably under these limits.
const MAX_CMD_ARGS: usize = 48;
const MAX_ARG_LEN: usize = 1024;

fn clamp_str(s: &str) -> String {
    if s.len() <= MAX_ARG_LEN {
        return s.to_string();
    }
    // Truncate on a char boundary so we never split a UTF-8 sequence.
    let mut end = MAX_ARG_LEN;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    let mut out = s[..end].to_string();
    out.push('…');
    out
}

fn clamp_cmd(cmd: &[std::ffi::OsString]) -> Vec<String> {
    cmd.iter()
        .take(MAX_CMD_ARGS)
        .map(|s| clamp_str(&s.to_string_lossy()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sampler_rejects_reused_pid_even_with_the_same_start_second() {
        let identity = ProcessIdentity::capture(std::process::id()).unwrap();
        let sampler = MetricsSampler::new();
        let live = sampler.collect(&[identity]).remove(0);
        assert!(live.root_alive);
        assert!(live
            .processes
            .iter()
            .any(|process| process.pid == identity.pid));
        let reused = ProcessIdentity {
            birth_token: identity.birth_token.wrapping_add(1),
            ..identity
        };
        let rejected = sampler.collect(&[reused]).remove(0);
        assert!(!rejected.root_alive);
        assert!(!rejected.cpu_ready);
        assert!(rejected.processes.is_empty());
        assert_eq!(rejected.proc_count, 0);
    }

    #[test]
    fn sampler_cpu_stays_warming_until_identity_has_a_baseline() {
        let identity = ProcessIdentity::capture(std::process::id()).unwrap();
        let sampler = MetricsSampler::new();
        let first = sampler.collect(&[identity]).remove(0);
        assert!(first.root_alive);
        assert!(!first.cpu_ready);
        sampler.sampled.lock().unwrap().insert(
            identity,
            std::time::Instant::now() - sysinfo::MINIMUM_CPU_UPDATE_INTERVAL,
        );
        let next = sampler.collect(&[identity]).remove(0);
        assert!(next.root_alive);
        assert!(next.cpu_ready);
    }
}
