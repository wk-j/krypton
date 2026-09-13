use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u16 = 1;
pub const MAX_FRAME_BYTES: usize = 32 * 1024 * 1024;

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
