//! spec 353: pager hints for native command output in fish panes.
//!
//! Krypton ships a fish `vendor_conf.d` script (`shell-integration/fish/…`)
//! and points a fish pane at it through `XDG_DATA_DIRS`, the way kitty loads
//! its shell integration. While a plain `git diff` runs, the script exports
//! `GIT_PAGER=cat`, so the whole unified diff lands in the terminal and the
//! frontend draws its native card from those rows (spec 351). The script takes
//! Krypton's directory back out of `XDG_DATA_DIRS` once fish has loaded it.

use std::path::Path;

const FISH_SCRIPT: &str =
    include_str!("../shell-integration/fish/vendor_conf.d/krypton-native-output.fish");
const FISH_SCRIPT_NAME: &str = "krypton-native-output.fish";
/// What XDG-aware programs assume when `XDG_DATA_DIRS` is unset.
const XDG_DATA_DIRS_DEFAULT: &str = "/usr/local/share:/usr/share";

/// Env vars that make a fish pane load the native-output hints. Empty for any
/// other shell, or when the script cannot be written (the pane still opens).
/// `inherited_xdg_data_dirs` is the value the pane would get otherwise.
pub fn native_output_env(
    shell: &str,
    inherited_xdg_data_dirs: Option<&str>,
) -> Vec<(String, String)> {
    if !is_fish(shell) {
        return Vec::new();
    }
    let Some(base) = crate::config::config_dir() else {
        return Vec::new();
    };
    let data_dir = base.join("runtime").join("shell-integration");
    if let Err(e) = install_fish_script(&data_dir) {
        log::warn!(
            "native output: cannot write fish integration under {}: {e}",
            data_dir.display()
        );
        return Vec::new();
    }
    fish_env(&data_dir.to_string_lossy(), inherited_xdg_data_dirs)
}

fn is_fish(shell: &str) -> bool {
    Path::new(shell)
        .file_name()
        .is_some_and(|name| name == "fish")
}

/// Write the bundled script under `<data_dir>/fish/vendor_conf.d/`, only when
/// what is there differs (an older Krypton's copy, or none).
fn install_fish_script(data_dir: &Path) -> std::io::Result<()> {
    let dir = data_dir.join("fish").join("vendor_conf.d");
    let path = dir.join(FISH_SCRIPT_NAME);
    if std::fs::read_to_string(&path).is_ok_and(|current| current == FISH_SCRIPT) {
        return Ok(());
    }
    std::fs::create_dir_all(&dir)?;
    std::fs::write(&path, FISH_SCRIPT)
}

/// Krypton's directory goes first. When the pane had no `XDG_DATA_DIRS`, the
/// XDG default follows it and the script unsets the variable again.
fn fish_env(data_dir: &str, inherited: Option<&str>) -> Vec<(String, String)> {
    let mut env = vec![
        ("KRYPTON_NATIVE_OUTPUT".to_string(), "1".to_string()),
        (
            "KRYPTON_FISH_XDG_DATA_DIR".to_string(),
            data_dir.to_string(),
        ),
    ];
    match inherited.filter(|dirs| !dirs.is_empty()) {
        Some(dirs) => env.push(("XDG_DATA_DIRS".to_string(), format!("{data_dir}:{dirs}"))),
        None => {
            env.push((
                "XDG_DATA_DIRS".to_string(),
                format!("{data_dir}:{XDG_DATA_DIRS_DEFAULT}"),
            ));
            env.push(("KRYPTON_XDG_DATA_DIRS_UNSET".to_string(), "1".to_string()));
        }
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value<'a>(env: &'a [(String, String)], key: &str) -> Option<&'a str> {
        env.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    #[test]
    fn only_fish_gets_the_integration() {
        assert!(is_fish("/opt/homebrew/bin/fish"));
        assert!(is_fish("fish"));
        assert!(!is_fish("/bin/zsh"));
        assert!(!is_fish("/usr/bin/ssh"));
        assert!(!is_fish("/opt/fish/bin/bash"));
        assert!(native_output_env("/bin/zsh", None).is_empty());
    }

    #[test]
    fn prepends_to_an_inherited_xdg_data_dirs() {
        let env = fish_env("/k/si", Some("/opt/x/share:/usr/share"));
        assert_eq!(
            value(&env, "XDG_DATA_DIRS"),
            Some("/k/si:/opt/x/share:/usr/share")
        );
        assert_eq!(value(&env, "KRYPTON_FISH_XDG_DATA_DIR"), Some("/k/si"));
        assert_eq!(value(&env, "KRYPTON_NATIVE_OUTPUT"), Some("1"));
        assert_eq!(value(&env, "KRYPTON_XDG_DATA_DIRS_UNSET"), None);
    }

    #[test]
    fn marks_an_unset_xdg_data_dirs_for_the_script_to_unset_again() {
        for inherited in [None, Some("")] {
            let env = fish_env("/k/si", inherited);
            assert_eq!(
                value(&env, "XDG_DATA_DIRS"),
                Some("/k/si:/usr/local/share:/usr/share")
            );
            assert_eq!(value(&env, "KRYPTON_XDG_DATA_DIRS_UNSET"), Some("1"));
        }
    }

    #[test]
    fn installs_the_script_once_and_replaces_a_stale_copy() {
        let dir = std::env::temp_dir().join(format!("krypton-shell-int-{}", std::process::id()));
        let path = dir
            .join("fish")
            .join("vendor_conf.d")
            .join(FISH_SCRIPT_NAME);
        install_fish_script(&dir).expect("first install");
        assert_eq!(std::fs::read_to_string(&path).expect("read"), FISH_SCRIPT);
        std::fs::write(&path, "stale").expect("write stale");
        install_fish_script(&dir).expect("reinstall");
        assert_eq!(std::fs::read_to_string(&path).expect("read"), FISH_SCRIPT);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
