use crate::pty::PtyManager;
use crate::util::lock::lock_mutex;
use std::sync::Mutex;

#[derive(Default)]
pub struct WorkspaceState {
    snapshot: Mutex<Option<serde_json::Value>>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBootstrap {
    lifecycle: &'static str,
    snapshot: Option<serde_json::Value>,
    active_session_ids: Vec<u32>,
}

impl WorkspaceState {
    fn save(&self, snapshot: serde_json::Value) -> Result<(), String> {
        *lock_mutex(&self.snapshot, "WorkspaceState")? = Some(snapshot);
        Ok(())
    }

    fn bootstrap(&self, pty_manager: &PtyManager) -> Result<WorkspaceBootstrap, String> {
        let snapshot = lock_mutex(&self.snapshot, "WorkspaceState")?.clone();
        let mut active_session_ids = pty_manager.active_session_ids();
        active_session_ids.sort_unstable();
        let lifecycle = if snapshot.is_some() || !active_session_ids.is_empty() {
            "reload"
        } else {
            "startup"
        };
        log::info!(
            "WebContent {lifecycle}: snapshot={}, active_ptys={}",
            snapshot.is_some(),
            active_session_ids.len()
        );
        Ok(WorkspaceBootstrap {
            lifecycle,
            snapshot,
            active_session_ids,
        })
    }
}

#[tauri::command]
pub fn save_workspace_state(
    state: tauri::State<'_, WorkspaceState>,
    snapshot: serde_json::Value,
) -> Result<(), String> {
    state.save(snapshot)
}

#[tauri::command]
pub fn load_workspace_bootstrap(
    state: tauri::State<'_, WorkspaceState>,
    pty_manager: tauri::State<'_, std::sync::Arc<PtyManager>>,
) -> Result<WorkspaceBootstrap, String> {
    state.bootstrap(&pty_manager)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fresh_backend_reports_startup() {
        let state = WorkspaceState::default();
        let ptys = PtyManager::new();
        let bootstrap = state.bootstrap(&ptys).expect("bootstrap");
        assert_eq!(bootstrap.lifecycle, "startup");
        assert!(bootstrap.snapshot.is_none());
        assert!(bootstrap.active_session_ids.is_empty());
    }

    #[test]
    fn saved_snapshot_marks_later_frontend_as_reload() {
        let state = WorkspaceState::default();
        let ptys = PtyManager::new();
        state.save(json!({ "version": 1 })).expect("save");
        let bootstrap = state.bootstrap(&ptys).expect("bootstrap");
        assert_eq!(bootstrap.lifecycle, "reload");
        assert_eq!(bootstrap.snapshot, Some(json!({ "version": 1 })));
    }
}
