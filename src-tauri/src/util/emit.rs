use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub trait EmitExt {
    fn emit_or_log<P: Serialize + Clone>(&self, event: &str, payload: P);
}

impl EmitExt for AppHandle {
    fn emit_or_log<P: Serialize + Clone>(&self, event: &str, payload: P) {
        if let Err(e) = self.emit(event, payload) {
            log::warn!("emit '{event}' failed: {e}");
        }
    }
}
