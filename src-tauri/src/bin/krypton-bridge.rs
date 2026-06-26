//! `krypton-bridge` — Chrome Native Messaging host (doc 176).
//!
//! Chrome launches this binary on demand when the Krypton browser extension
//! calls `chrome.runtime.sendNativeMessage`. It reads the user-private control
//! descriptor (`~/.config/krypton/runtime/controller.json`, mode `0600`) as the
//! invoking user and hands the extension the control API URL + bearer token, so
//! the token never has to be configured by hand. Only the extension whose ID
//! matches the host manifest's `allowed_origins` can invoke it.
//!
//! Wire protocol (Native Messaging): each message is UTF-8 JSON prefixed with a
//! 4-byte length in native byte order. v1 handles a single request shape
//! `{ "cmd": "credentials" }` and replies once, then exits.

use std::io::{Read, Write};

use serde_json::{json, Value};

fn main() {
    // A single request/response cycle. Chrome relaunches the host per message
    // batch, so handling one message and exiting is the expected lifecycle.
    let request = match read_message() {
        Ok(Some(request)) => request,
        Ok(None) => return, // stdin closed with no message
        Err(e) => {
            let _ = write_message(&json!({ "error": "bad_request", "detail": e }));
            return;
        }
    };

    let cmd = request.get("cmd").and_then(Value::as_str).unwrap_or("");
    let reply = match cmd {
        "credentials" => credentials(),
        other => json!({ "error": "unknown_cmd", "detail": other }),
    };
    let _ = write_message(&reply);
}

/// Read the live control descriptor and project it to what the extension needs.
fn credentials() -> Value {
    let path = match app_lib::control::descriptor_path() {
        Ok(path) => path,
        Err(e) => return json!({ "error": "no_config_dir", "detail": e }),
    };
    let body = match std::fs::read_to_string(&path) {
        Ok(body) => body,
        Err(_) => return json!({ "error": "descriptor_missing" }),
    };
    let descriptor: app_lib::control::RuntimeDescriptor = match serde_json::from_str(&body) {
        Ok(descriptor) => descriptor,
        Err(_) => return json!({ "error": "descriptor_unreadable" }),
    };
    if !app_lib::control::pid_is_live(descriptor.pid) {
        return json!({ "error": "krypton_not_running" });
    }
    json!({
        "url": descriptor.url,
        "token": descriptor.token,
        "pid": descriptor.pid,
        "apiVersion": descriptor.api_version,
    })
}

/// Read one length-prefixed JSON message from stdin. `Ok(None)` on clean EOF.
fn read_message() -> Result<Option<Value>, String> {
    let mut len_buf = [0_u8; 4];
    let mut stdin = std::io::stdin();
    match stdin.read_exact(&mut len_buf) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e.to_string()),
    }
    // Chrome frames the length in native byte order.
    let len = u32::from_ne_bytes(len_buf) as usize;
    // Chrome caps a single message at 1 MB; refuse anything larger.
    if len == 0 || len > 1024 * 1024 {
        return Err(format!("invalid message length {len}"));
    }
    let mut buf = vec![0_u8; len];
    stdin.read_exact(&mut buf).map_err(|e| e.to_string())?;
    serde_json::from_slice(&buf).map_err(|e| e.to_string())
}

/// Write one length-prefixed JSON message to stdout.
fn write_message(value: &Value) -> std::io::Result<()> {
    let body = serde_json::to_vec(value)?;
    let len = body.len() as u32;
    let mut stdout = std::io::stdout();
    stdout.write_all(&len.to_ne_bytes())?;
    stdout.write_all(&body)?;
    stdout.flush()
}
