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
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

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
