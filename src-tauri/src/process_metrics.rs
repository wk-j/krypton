// Krypton — Process metrics sampler.
//
// Long-lived `sysinfo::System` shared across metric polls. One refresh per
// poll covers every ACP lane and its descendants — cost stays flat as the
// lane count grows. Holding the snapshot between calls also gives sysinfo
// the prior baseline it needs to report a non-zero `cpu_usage()` (the
// first call after sampler creation reports 0%, subsequent calls are
// real). See docs/91-acp-lane-resource-metrics.md.

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
    pub total_cpu_percent: f64,
    pub total_rss_mb: f64,
    pub proc_count: u32,
    pub processes: Vec<ProcMetric>,
}

pub struct MetricsSampler {
    sys: Mutex<sysinfo::System>,
}

impl MetricsSampler {
    pub fn new() -> Self {
        Self {
            sys: Mutex::new(sysinfo::System::new()),
        }
    }

    /// Refresh once and collect metrics for each root PID and its descendants.
    pub fn collect(&self, roots: &[u32]) -> Vec<TreeMetrics> {
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

        roots
            .iter()
            .map(|&root| collect_tree(&sys, &children, root))
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
    root: u32,
) -> TreeMetrics {
    let root_proc = sys.process(sysinfo::Pid::from_u32(root));
    if root_proc.is_none() {
        return TreeMetrics {
            root_pid: root,
            root_alive: false,
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
