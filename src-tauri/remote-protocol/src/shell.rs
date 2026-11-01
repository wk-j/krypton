// The text a `!shell` transcript row shows for a finished command (spec 247).
//
// Lives in the protocol crate because both ends run typed commands: the app's
// local `run_shell` and the remote companion's `RemoteMethod::WorkspaceShell`.
// One implementation keeps a command's row identical on either host.

use std::process::ExitStatus;

/// `Ok(output)` when the command succeeded. Otherwise the text a failed row
/// shows: a signal label followed by any output, the output alone, or
/// `exit code N` when the command printed nothing. Output is stdout, then
/// stderr on a new line.
pub fn shell_outcome(status: &ExitStatus, stdout: &[u8], stderr: &[u8]) -> Result<String, String> {
    let mut combined = String::from_utf8_lossy(stdout).into_owned();
    let stderr = String::from_utf8_lossy(stderr);
    if !stderr.is_empty() {
        if !combined.is_empty() && !combined.ends_with('\n') {
            combined.push('\n');
        }
        combined.push_str(&stderr);
    }

    if status.success() {
        Ok(combined)
    } else if let Some(signal) = signal_label(status) {
        if combined.is_empty() {
            Err(signal)
        } else {
            Err(format!("{signal}\n{combined}"))
        }
    } else if combined.is_empty() {
        let code = status
            .code()
            .map_or("signal".to_string(), |c| c.to_string());
        Err(format!("exit code {code}"))
    } else {
        Err(combined)
    }
}

#[cfg(unix)]
fn signal_label(status: &ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt;
    // SIGINT, SIGKILL and SIGTERM carry these numbers on every Unix.
    status.signal().map(|s| match s {
        15 => "terminated (SIGTERM)".to_string(),
        9 => "killed (SIGKILL)".to_string(),
        2 => "interrupted (SIGINT)".to_string(),
        other => format!("signal {other}"),
    })
}

#[cfg(not(unix))]
fn signal_label(_status: &ExitStatus) -> Option<String> {
    None
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;

    #[test]
    fn failures_read_as_signal_output_or_exit_code() {
        let exited = |code: i32| ExitStatus::from_raw(code << 8);
        assert_eq!(
            shell_outcome(&exited(0), b"out", b"err"),
            Ok("out\nerr".to_string())
        );
        assert_eq!(
            shell_outcome(&exited(2), b"", b""),
            Err("exit code 2".to_string())
        );
        assert_eq!(
            shell_outcome(&exited(1), b"", b"fatal: not a git repository\n"),
            Err("fatal: not a git repository\n".to_string())
        );
        assert_eq!(
            shell_outcome(&ExitStatus::from_raw(15), b"partial\n", b""),
            Err("terminated (SIGTERM)\npartial\n".to_string())
        );
        assert_eq!(
            shell_outcome(&ExitStatus::from_raw(9), b"", b""),
            Err("killed (SIGKILL)".to_string())
        );
    }
}
