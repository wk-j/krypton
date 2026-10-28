//! Child processes that run project commands outside a PTY: the login
//! environment, an own process group, capped output reads and group signals.
//! Shared by the e2e runner (spec 328) and the Rails check runner (spec 337).

use std::path::Path;
use std::process::Stdio;

use tokio::io::{AsyncRead, AsyncReadExt};

#[derive(Clone, Copy)]
pub(crate) enum Signal {
    Term,
    Kill,
}

/// Signal a whole process group (negative pid), as `acp::dispose_client` does.
pub(crate) fn kill_group(pgid: Option<i32>, signal: Signal) {
    #[cfg(unix)]
    if let Some(pgid) = pgid.filter(|p| *p > 0) {
        let sig = match signal {
            Signal::Term => libc::SIGTERM,
            Signal::Kill => libc::SIGKILL,
        };
        unsafe {
            libc::kill(-pgid, sig);
        }
    }
    #[cfg(not(unix))]
    let _ = (pgid, signal);
}

/// `argv` as a child process: login env, stdin null, own process group,
/// cwd = `cwd`. The caller sets stdout/stderr and spawns.
pub(crate) fn login_command(
    cwd: &Path,
    argv: &[String],
) -> Result<tokio::process::Command, String> {
    let (program, args) = argv
        .split_first()
        .ok_or_else(|| "argv is empty".to_string())?;
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args).current_dir(cwd).stdin(Stdio::null());
    for (k, v) in crate::pty::login_env_pairs() {
        cmd.env(k, v);
    }
    #[cfg(unix)]
    cmd.process_group(0);
    Ok(cmd)
}

/// Drain `reader` to EOF, keeping at most the first `cap` bytes. Reading
/// continues past the cap so the child never blocks on a full pipe.
pub(crate) async fn read_capped<R: AsyncRead + Unpin>(reader: Option<R>, cap: usize) -> Vec<u8> {
    let mut out = Vec::new();
    let Some(mut reader) = reader else {
        return out;
    };
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let room = cap.saturating_sub(out.len());
                out.extend_from_slice(&buf[..n.min(room)]);
            }
        }
    }
    out
}
