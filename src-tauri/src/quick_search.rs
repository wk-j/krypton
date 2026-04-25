// Krypton — Quick File Search
//
// Long-lived per-project file pickers backed by `fff-search`. Each picker
// runs its own background scanner + fs watcher; pickers are cached in an
// LRU keyed by the resolved project root (walk-up from CWD to the nearest
// `.git/`, capped at $HOME).
//
// Frecency is global (a single LMDB DB under data_local_dir/krypton/frecency/)
// so eviction never loses ranking history. See docs/68-quick-file-search.md.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use fff_search::{
    FFFMode, FileItem, FilePicker, FilePickerOptions, FileSearchConfig, FuzzySearchOptions,
    GrepConfig, GrepSearchOptions, PaginationArgs, QueryParser, SharedFrecency, SharedPicker,
    SharedQueryTracker,
};

const PICKER_CAP: usize = 8;
/// Time to wait for a brand-new picker's first scan before returning its first
/// query. Ten ms is below interactive perception while letting tiny repos
/// finish cold-start scan synchronously.
const FIRST_SCAN_WAIT: Duration = Duration::from_millis(10);

pub struct QuickSearchState {
    /// LRU order (head = most-recent) + map of root → picker.
    /// Held under one mutex so order/map stay in sync.
    pickers: Mutex<(VecDeque<PathBuf>, HashMap<PathBuf, SharedPicker>)>,
    frecency: SharedFrecency,
    queries: SharedQueryTracker,
    parser: QueryParser<FileSearchConfig>,
    grep_parser: QueryParser<GrepConfig>,
}

#[derive(serde::Serialize, Clone)]
pub struct QuickSearchHit {
    pub path: String,
    pub absolute: String,
    pub score: i32,
}

#[derive(serde::Serialize)]
pub struct QuickSearchResponse {
    pub hits: Vec<QuickSearchHit>,
    pub indexing: bool,
    pub indexed_count: usize,
    pub root: String,
}

impl QuickSearchState {
    pub fn new() -> Self {
        let frecency = SharedFrecency::default();
        let queries = SharedQueryTracker::default();

        // Initialize frecency LMDB. Failure is non-fatal — frecency just
        // becomes a no-op and ranking falls back to raw fuzzy score.
        match data_dir() {
            Some(dir) => {
                let frecency_dir = dir.join("krypton").join("frecency");
                if let Err(e) = std::fs::create_dir_all(&frecency_dir) {
                    log::warn!("quick_search: create frecency dir failed: {e}");
                } else {
                    match fff_search::FrecencyTracker::new(&frecency_dir, false) {
                        Ok(tracker) => {
                            if let Err(e) = frecency.init(tracker) {
                                log::warn!("quick_search: frecency init failed: {e}");
                            }
                        }
                        Err(e) => {
                            log::warn!("quick_search: open frecency LMDB failed: {e}");
                        }
                    }
                }

                let queries_dir = dir.join("krypton").join("queries");
                if std::fs::create_dir_all(&queries_dir).is_ok() {
                    if let Ok(tracker) = fff_search::QueryTracker::new(&queries_dir, false) {
                        let _ = queries.init(tracker);
                    }
                }
            }
            None => log::warn!("quick_search: no data_local_dir; frecency disabled"),
        }

        Self {
            pickers: Mutex::new((VecDeque::new(), HashMap::new())),
            frecency,
            queries,
            parser: QueryParser::new(FileSearchConfig),
            grep_parser: QueryParser::new(GrepConfig),
        }
    }

    /// Resolve or construct the picker for `root`. Promotes to LRU head and
    /// evicts the tail when capacity is exceeded.
    fn picker_for(&self, root: &Path) -> Result<SharedPicker, String> {
        let mut guard = self.pickers.lock().map_err(|_| "picker lock poisoned")?;
        let (order, map) = &mut *guard;

        if let Some(p) = map.get(root).cloned() {
            // Promote to head
            if let Some(pos) = order.iter().position(|p| p == root) {
                order.remove(pos);
            }
            order.push_front(root.to_path_buf());
            return Ok(p);
        }

        let shared = SharedPicker::default();
        let opts = FilePickerOptions {
            base_path: root.to_string_lossy().into_owned(),
            mode: FFFMode::default(),
            ..Default::default()
        };
        FilePicker::new_with_shared_state(shared.clone(), self.frecency.clone(), opts)
            .map_err(|e| format!("file picker init failed: {e}"))?;

        map.insert(root.to_path_buf(), shared.clone());
        order.push_front(root.to_path_buf());

        while order.len() > PICKER_CAP {
            if let Some(evict) = order.pop_back() {
                map.remove(&evict);
                log::info!("quick_search: evicted picker for {}", evict.display());
            }
        }
        Ok(shared)
    }
}

impl Default for QuickSearchState {
    fn default() -> Self {
        Self::new()
    }
}

fn data_dir() -> Option<PathBuf> {
    dirs::data_local_dir()
}

/// Resolve a search root by walking up from `cwd` to the nearest `.git/`,
/// stopping at $HOME (never escaping the user's home tree). If no `.git/`
/// is found in that range, fall back to the canonicalized CWD.
pub fn resolve_search_root(cwd: PathBuf) -> PathBuf {
    let canon = cwd.canonicalize().unwrap_or(cwd);
    let home = dirs::home_dir();

    let mut cur: &Path = canon.as_path();
    loop {
        if cur.join(".git").exists() {
            return cur.to_path_buf();
        }
        if Some(cur) == home.as_deref() {
            break;
        }
        match cur.parent() {
            Some(p) if p != cur => cur = p,
            _ => break,
        }
    }
    canon
}

#[tauri::command]
pub async fn quick_search_warm_root(
    cwd: String,
    state: tauri::State<'_, QuickSearchState>,
) -> Result<String, String> {
    let root = resolve_search_root(PathBuf::from(cwd));
    state.picker_for(&root)?;
    Ok(root.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn quick_search_query(
    root: String,
    query: String,
    limit: usize,
    state: tauri::State<'_, QuickSearchState>,
) -> Result<QuickSearchResponse, String> {
    let root_path = PathBuf::from(&root);
    let shared = state.picker_for(&root_path)?;

    // For the very first query against a fresh picker we wait briefly so
    // tiny repos return a populated list on the first call.
    let _ = shared.wait_for_scan(FIRST_SCAN_WAIT);

    let parsed = state.parser.parse(&query);

    let opts = FuzzySearchOptions {
        pagination: PaginationArgs {
            offset: 0,
            limit: limit.max(1),
        },
        ..Default::default()
    };

    let guard = shared.read().map_err(|e| format!("picker read: {e}"))?;
    let picker = guard.as_ref().ok_or("picker not initialized")?;

    let q_tracker_guard = state.queries.read().map_err(|e| format!("queries: {e}"))?;
    let q_tracker = q_tracker_guard.as_ref();

    let result = picker.fuzzy_search(&parsed, q_tracker, opts);
    let indexing = picker.is_scanning.load(std::sync::atomic::Ordering::Relaxed);
    let indexed_count = picker.get_files().len();

    let hits: Vec<QuickSearchHit> = result
        .items
        .iter()
        .zip(result.scores.iter())
        .map(|(item, score)| hit_from_item(item, picker, score.total))
        .collect();

    Ok(QuickSearchResponse {
        hits,
        indexing,
        indexed_count,
        root,
    })
}

fn hit_from_item(item: &FileItem, picker: &FilePicker, score: i32) -> QuickSearchHit {
    let rel = item.relative_path(picker);
    let abs = item.absolute_path(picker, picker.base_path());
    QuickSearchHit {
        path: rel,
        absolute: abs.to_string_lossy().into_owned(),
        score,
    }
}

#[derive(serde::Serialize, Clone)]
pub struct QuickGrepHit {
    pub path: String,
    pub absolute: String,
    pub line: u64,
    pub col: usize,
    pub line_content: String,
    /// (start, end) byte offsets within `line_content` for each match span.
    pub match_ranges: Vec<(u32, u32)>,
}

#[derive(serde::Serialize)]
pub struct QuickGrepResponse {
    pub hits: Vec<QuickGrepHit>,
    pub indexing: bool,
    pub indexed_count: usize,
    pub root: String,
    pub regex_fallback_error: Option<String>,
}

#[tauri::command]
pub async fn quick_grep_query(
    root: String,
    query: String,
    limit: usize,
    state: tauri::State<'_, QuickSearchState>,
) -> Result<QuickGrepResponse, String> {
    let root_path = PathBuf::from(&root);
    let shared = state.picker_for(&root_path)?;
    let _ = shared.wait_for_scan(FIRST_SCAN_WAIT);

    if query.trim().is_empty() {
        let guard = shared.read().map_err(|e| format!("picker read: {e}"))?;
        let picker = guard.as_ref().ok_or("picker not initialized")?;
        return Ok(QuickGrepResponse {
            hits: Vec::new(),
            indexing: picker.is_scanning.load(std::sync::atomic::Ordering::Relaxed),
            indexed_count: picker.get_files().len(),
            root,
            regex_fallback_error: None,
        });
    }

    let parsed = state.grep_parser.parse(&query);
    let opts = GrepSearchOptions {
        page_limit: limit.max(1),
        trim_whitespace: true,
        ..Default::default()
    };

    let guard = shared.read().map_err(|e| format!("picker read: {e}"))?;
    let picker = guard.as_ref().ok_or("picker not initialized")?;

    let result = picker.grep(&parsed, &opts);
    let indexing = picker.is_scanning.load(std::sync::atomic::Ordering::Relaxed);
    let indexed_count = picker.get_files().len();

    let hits: Vec<QuickGrepHit> = result
        .matches
        .iter()
        .map(|m| {
            let file = result.files[m.file_index];
            let abs = file.absolute_path(picker, picker.base_path());
            QuickGrepHit {
                path: file.relative_path(picker),
                absolute: abs.to_string_lossy().into_owned(),
                line: m.line_number,
                col: m.col,
                line_content: m.line_content.clone(),
                match_ranges: m.match_byte_offsets.iter().copied().collect(),
            }
        })
        .collect();

    Ok(QuickGrepResponse {
        hits,
        indexing,
        indexed_count,
        root,
        regex_fallback_error: result.regex_fallback_error,
    })
}

#[tauri::command]
pub fn quick_search_record_pick(
    absolute: String,
    state: tauri::State<'_, QuickSearchState>,
) -> Result<(), String> {
    let path = PathBuf::from(absolute);
    let guard = state
        .frecency
        .read()
        .map_err(|e| format!("frecency lock: {e}"))?;
    if let Some(tracker) = guard.as_ref() {
        if let Err(e) = tracker.track_access(&path) {
            log::warn!("quick_search: track_access failed: {e}");
        }
    }
    Ok(())
}
