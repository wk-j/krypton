use serde::{Deserialize, Serialize};
use serde_json::Value;

pub mod diff_stat;
pub mod shell;

pub const PROTOCOL_VERSION: u16 = 1;
pub const MAX_FRAME_BYTES: usize = 32 * 1024 * 1024;

/// Hello capability of a runtime that answers `WorkspaceDiffStat`.
pub const CAPABILITY_WORKSPACE_DIFF_STAT: &str = "workspace_diff_stat";

/// Hello capability of a runtime that answers `WorkspaceShell` and
/// `WorkspaceShellKill`.
pub const CAPABILITY_WORKSPACE_SHELL: &str = "workspace_shell";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWorkspace {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteMethod {
    RuntimeShutdown,
    AgentSpawn,
    AgentWrite,
    AgentTerminate,
    RuntimeOverlayWrite,
    RuntimeOverlayRemove,
    WorkspaceCanonicalize,
    WorkspaceRead,
    WorkspaceWrite,
    WorkspaceRemove,
    WorkspaceStat,
    WorkspaceReadDir,
    WorkspaceRun,
    /// The window rail's `diff_stat::WorkingDiffStat` for a workspace cwd.
    WorkspaceDiffStat,
    /// A command the user typed after `!` in a remote Harness, run with
    /// `/bin/sh -c` in the workspace (spec 247).
    WorkspaceShell,
    /// Signal a running `WorkspaceShell` command's process group.
    WorkspaceShellKill,
}

impl RemoteMethod {
    /// The Hello capability a runtime must advertise before this method may be
    /// sent. A runtime that predates a method fails to parse its request frame
    /// and exits, so a method added after protocol 1 shipped is gated here
    /// rather than sent blind. `None`: every protocol-1 runtime handles it.
    pub fn required_capability(&self) -> Option<&'static str> {
        match self {
            RemoteMethod::WorkspaceDiffStat => Some(CAPABILITY_WORKSPACE_DIFF_STAT),
            RemoteMethod::WorkspaceShell | RemoteMethod::WorkspaceShellKill => {
                Some(CAPABILITY_WORKSPACE_SHELL)
            }
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "stream", rename_all = "snake_case")]
pub enum RuntimeFrame {
    Hello {
        protocol: u16,
        app_version: String,
        workspace: RemoteWorkspace,
        #[serde(default)]
        capabilities: Vec<String>,
    },
    Request {
        id: u64,
        method: RemoteMethod,
        params: Value,
    },
    Response {
        id: u64,
        result: Option<Value>,
        error: Option<RuntimeError>,
    },
    Event {
        topic: String,
        payload: Value,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeError {
    pub code: String,
    pub message: String,
}

impl RuntimeError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_round_trips_with_snake_case_method() {
        let frame = RuntimeFrame::Request {
            id: 7,
            method: RemoteMethod::WorkspaceRead,
            params: json!({ "path": "/srv/repo/README.md" }),
        };
        let encoded = serde_json::to_string(&frame).expect("serialize frame");
        assert!(encoded.contains("\"workspace_read\""));
        assert_eq!(
            serde_json::from_str::<RuntimeFrame>(&encoded).unwrap(),
            frame
        );
    }

    #[test]
    fn hello_accepts_missing_capabilities_for_forward_compatibility() {
        let frame: RuntimeFrame = serde_json::from_value(json!({
            "stream": "hello",
            "protocol": 1,
            "app_version": "0.1.0",
            "workspace": { "path": "/srv/repo" }
        }))
        .unwrap();
        let RuntimeFrame::Hello { capabilities, .. } = frame else {
            panic!("expected hello");
        };
        assert!(capabilities.is_empty());
    }

    #[test]
    fn frame_limit_is_large_enough_for_normal_acp_but_bounded() {
        assert_eq!(MAX_FRAME_BYTES, 32 * 1024 * 1024);
        let frame = RuntimeFrame::Request {
            id: 1,
            method: RemoteMethod::AgentWrite,
            params: json!({ "data": "hello" }),
        };
        assert!(serde_json::to_vec(&frame).unwrap().len() < MAX_FRAME_BYTES);
    }
}
