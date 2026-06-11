use app_lib::control::{ControlReply, ControlRequest, RuntimeDescriptor};
use serde_json::{json, Value};

#[tokio::main]
async fn main() {
    match run().await {
        Ok((value, as_json)) => print_value(&value, as_json),
        Err(message) => {
            eprintln!("kryptonctl: {message}");
            std::process::exit(1);
        }
    }
}

async fn run() -> Result<(Value, bool), String> {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let as_json = remove_flag(&mut args, "--json");
    let yes = remove_flag(&mut args, "--yes");
    if args.first().map(String::as_str) != Some("acp") {
        return Err(usage());
    }
    args.remove(0);
    let descriptor = read_descriptor()?;
    let client = reqwest::Client::new();
    if args.first().map(String::as_str) == Some("capabilities") {
        return Ok((get(&client, &descriptor, "capabilities").await?, as_json));
    }
    confirm_destructive(&args, yes)?;
    let (operation, params, wait_lane) = parse_operation(&args)?;
    let result = post(&client, &descriptor, operation, params).await?;
    if let Some(lane) = wait_lane {
        wait_for_lane(&client, &descriptor, &lane).await?;
    }
    Ok((result, as_json))
}

fn confirm_destructive(args: &[String], yes: bool) -> Result<(), String> {
    if !is_destructive(args) || yes {
        return Ok(());
    }
    use std::io::{IsTerminal, Write};
    if !std::io::stdin().is_terminal() {
        return Err("destructive command requires --yes outside a TTY".to_string());
    }
    eprint!("Proceed with destructive ACP operation? [y/N] ");
    std::io::stderr().flush().map_err(|e| e.to_string())?;
    let mut answer = String::new();
    std::io::stdin()
        .read_line(&mut answer)
        .map_err(|e| e.to_string())?;
    if answer.trim().eq_ignore_ascii_case("y") || answer.trim().eq_ignore_ascii_case("yes") {
        Ok(())
    } else {
        Err("cancelled".to_string())
    }
}

fn is_destructive(args: &[String]) -> bool {
    matches!(
        args.iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
            .as_slice(),
        ["close", _] | ["new", _] | ["new", _, "--clear-memory"] | ["memory", "clear", _]
    )
}

fn parse_operation(args: &[String]) -> Result<(&'static str, Value, Option<String>), String> {
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["harnesses"] => Ok(("harness.list", json!({}), None)),
        ["harness", "create", "--cwd", cwd] => Ok(("harness.create", json!({ "cwd": cwd }), None)),
        ["lanes"] => Ok(("lane.list", json!({}), None)),
        ["lanes", "--harness", harness] => Ok(("lane.list", json!({ "harnessId": harness }), None)),
        ["spawn", backend, "--harness", harness] => Ok((
            "lane.spawn",
            json!({ "backendId": backend, "harnessId": harness }),
            None,
        )),
        ["send", lane, text] => Ok(("lane.send", json!({ "lane": lane, "text": text }), None)),
        ["send", lane, text, "--wait"] => Ok((
            "lane.send",
            json!({ "lane": lane, "text": text }),
            Some((*lane).to_string()),
        )),
        ["cancel", lane] => Ok(("lane.cancel", json!({ "lane": lane }), None)),
        ["close", lane] => Ok(("lane.close", json!({ "lane": lane }), None)),
        ["restart", lane] => Ok(("lane.restart", json!({ "lane": lane }), None)),
        ["new", lane] => Ok(("lane.new", json!({ "lane": lane }), None)),
        ["new", lane, "--clear-memory"] => Ok((
            "lane.new",
            json!({ "lane": lane, "clearMemory": true }),
            None,
        )),
        ["model", lane, model_id] => Ok((
            "lane.model",
            json!({ "lane": lane, "modelId": model_id }),
            None,
        )),
        ["directive", lane, "--clear"] => Ok((
            "lane.directive",
            json!({ "lane": lane, "directiveId": null }),
            None,
        )),
        ["directive", lane, directive_id] => Ok((
            "lane.directive",
            json!({ "lane": lane, "directiveId": directive_id }),
            None,
        )),
        ["goal", lane, "--clear"] => Ok(("lane.goal", json!({ "lane": lane, "text": null }), None)),
        ["goal", lane, text] => Ok(("lane.goal", json!({ "lane": lane, "text": text }), None)),
        ["permission-mode", lane, mode] => Ok((
            "lane.permission_mode",
            json!({ "lane": lane, "mode": mode }),
            None,
        )),
        ["transcript", lane] => Ok(("lane.transcript", json!({ "lane": lane }), None)),
        ["permissions", lane] => Ok(("permission.list", json!({ "lane": lane }), None)),
        ["permission", "approve", lane, request_id] => Ok((
            "permission.resolve",
            json!({ "lane": lane, "requestId": parse_u64(request_id)?, "action": "accept" }),
            None,
        )),
        ["permission", "reject", lane, request_id] => Ok((
            "permission.resolve",
            json!({ "lane": lane, "requestId": parse_u64(request_id)?, "action": "reject" }),
            None,
        )),
        ["memory", "list", "--harness", harness] => {
            Ok(("memory.list", json!({ "harnessId": harness }), None))
        }
        ["memory", "get", lane] => Ok(("memory.get", json!({ "lane": lane }), None)),
        ["memory", "clear", lane] => Ok(("memory.clear", json!({ "lane": lane }), None)),
        ["peers"] => Ok(("peer.list", json!({}), None)),
        _ => Err(usage()),
    }
}

async fn wait_for_lane(
    client: &reqwest::Client,
    descriptor: &RuntimeDescriptor,
    lane: &str,
) -> Result<(), String> {
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let lanes = post(client, descriptor, "lane.list", json!({ "lane": lane })).await?;
        let target = lanes
            .as_array()
            .and_then(|items| items.iter().find(|item| item["displayName"] == lane))
            .ok_or_else(|| format!("lane disappeared while waiting: {lane}"))?;
        let status = target["status"].as_str().unwrap_or("unknown");
        let queue_depth = target["queueDepth"].as_u64().unwrap_or(0);
        if status == "idle" && queue_depth == 0 {
            return Ok(());
        }
        if status == "error" || status == "stopped" {
            return Err(format!("{lane} ended in state {status}"));
        }
    }
}

fn parse_u64(value: &str) -> Result<u64, String> {
    value
        .parse::<u64>()
        .map_err(|_| format!("invalid numeric id: {value}"))
}

fn remove_flag(args: &mut Vec<String>, flag: &str) -> bool {
    if let Some(index) = args.iter().position(|arg| arg == flag) {
        args.remove(index);
        true
    } else {
        false
    }
}

fn usage() -> String {
    "usage: kryptonctl [--json] [--yes] acp <capabilities|harness|harnesses|lanes|spawn|send|cancel|close|restart|new|model|directive|goal|permission-mode|transcript|permissions|permission|memory|peers>".to_string()
}

fn read_descriptor() -> Result<RuntimeDescriptor, String> {
    let path = app_lib::control::descriptor_path()?;
    let body = std::fs::read_to_string(&path)
        .map_err(|_| format!("Krypton control descriptor not found at {}", path.display()))?;
    let descriptor: RuntimeDescriptor =
        serde_json::from_str(&body).map_err(|e| format!("invalid control descriptor: {e}"))?;
    if !app_lib::control::pid_is_live(descriptor.pid) {
        return Err(format!(
            "stale Krypton control descriptor (dead pid {})",
            descriptor.pid
        ));
    }
    let supported_major = app_lib::control::API_VERSION.split('.').next();
    let descriptor_major = descriptor.api_version.split('.').next();
    if descriptor_major != supported_major {
        return Err(format!(
            "unsupported control API version {} (kryptonctl supports {})",
            descriptor.api_version,
            app_lib::control::API_VERSION
        ));
    }
    Ok(descriptor)
}

async fn get(
    client: &reqwest::Client,
    descriptor: &RuntimeDescriptor,
    path: &str,
) -> Result<Value, String> {
    let reply = client
        .get(format!("{}/{}", descriptor.url, path))
        .bearer_auth(&descriptor.token)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<ControlReply>()
        .await
        .map_err(|e| e.to_string())?;
    unpack(reply)
}

async fn post(
    client: &reqwest::Client,
    descriptor: &RuntimeDescriptor,
    operation: &str,
    params: Value,
) -> Result<Value, String> {
    let request = ControlRequest {
        operation_id: format!("ctl-{}-{}", std::process::id(), timestamp_nanos()),
        operation: operation.to_string(),
        params,
    };
    let reply = client
        .post(format!("{}/operations", descriptor.url))
        .bearer_auth(&descriptor.token)
        .json(&request)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<ControlReply>()
        .await
        .map_err(|e| e.to_string())?;
    unpack(reply)
}

fn unpack(reply: ControlReply) -> Result<Value, String> {
    if let Some(error) = reply.error {
        return Err(format!("{}: {}", error.code, error.message));
    }
    Ok(reply.result.unwrap_or(Value::Null))
}

fn print_value(value: &Value, as_json: bool) {
    if as_json || !value.is_string() {
        println!(
            "{}",
            serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".to_string())
        );
    } else if let Some(text) = value.as_str() {
        println!("{text}");
    }
}

fn timestamp_nanos() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn send_wait_targets_only_its_lane() {
        let args = strings(&["send", "Codex-1", "ship it", "--wait"]);
        let (operation, params, wait_lane) = parse_operation(&args).unwrap();
        assert_eq!(operation, "lane.send");
        assert_eq!(params["lane"], "Codex-1");
        assert_eq!(wait_lane.as_deref(), Some("Codex-1"));
    }

    #[test]
    fn peer_send_is_not_exposed() {
        let args = strings(&["peer", "send", "Claude-1", "hello"]);
        assert!(parse_operation(&args).is_err());
    }

    #[test]
    fn destructive_commands_are_recognized() {
        assert!(is_destructive(&strings(&["close", "Codex-1"])));
        assert!(is_destructive(&strings(&["memory", "clear", "Codex-1"])));
        assert!(!is_destructive(&strings(&["send", "Codex-1", "hello"])));
    }
}
