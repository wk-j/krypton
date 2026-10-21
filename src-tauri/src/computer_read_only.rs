//! Read-only classifier for Connected Computer commands (spec 318).
//!
//! `read_only_script` decides whether a remote command may skip the human
//! approval row of spec 311. It fails closed: anything it cannot parse, any
//! command outside the table, and any argument it cannot vouch for returns
//! `None`, which keeps today's per-command approval. A qualifying command is
//! returned re-quoted from the argv this module parsed, so the remote `sh -s`
//! runs exactly what was classified, never the caller's original text.

enum Token {
    Word(String),
    Op(&'static str),
}

/// `Some(script)` when `command` qualifies; `script` is the re-quoted form to
/// send to the remote `sh -s`. `cwd` is the effective remote directory
/// (`None` = remote login home).
pub fn read_only_script(command: &str, cwd: Option<&str>) -> Option<String> {
    if cwd.is_some_and(|cwd| value_is_guarded(cwd, false)) {
        return None;
    }
    // A relative word resolves under `/` when `cwd` is the root, and the login
    // home is unknown, so treat both as the root for the device-tree check.
    let root_relative = cwd.map_or(true, |cwd| {
        cwd.split('/').all(|part| part.is_empty() || part == ".")
    });
    let tokens = tokenize(command)?;
    let mut segment: Vec<&str> = Vec::new();
    for token in &tokens {
        match token {
            Token::Word(word) => segment.push(word),
            Token::Op(_) => {
                if !segment_is_read_only(&segment, root_relative) {
                    return None;
                }
                segment.clear();
            }
        }
    }
    if !segment_is_read_only(&segment, root_relative) {
        return None;
    }
    let script = tokens
        .iter()
        .map(|token| match token {
            Token::Word(word) => format!("'{}'", word.replace('\'', "'\\''")),
            Token::Op(op) => (*op).to_string(),
        })
        .collect::<Vec<_>>()
        .join(" ");
    Some(script)
}

/// Unquoted characters with no special meaning to a POSIX shell in word
/// context (POSIX §2.2). Non-ASCII is literal to `sh`.
fn is_plain(c: char) -> bool {
    c.is_ascii_alphanumeric()
        || matches!(c, '_' | '.' | '/' | ',' | ':' | '=' | '+' | '@' | '%' | '-')
        || !c.is_ascii()
}

/// Words and `|`, `&&`, `||`, `;` only. Every other unquoted character,
/// a `$`/`` ` ``/`\` inside double quotes, an unterminated quote or a line
/// break returns `None`.
fn tokenize(command: &str) -> Option<Vec<Token>> {
    let mut tokens = Vec::new();
    let mut word = String::new();
    let mut in_word = false;
    let mut chars = command.chars().peekable();
    let flush = |tokens: &mut Vec<Token>, word: &mut String, in_word: &mut bool| {
        if *in_word {
            tokens.push(Token::Word(std::mem::take(word)));
            *in_word = false;
        }
    };
    while let Some(c) = chars.next() {
        match c {
            ' ' | '\t' => flush(&mut tokens, &mut word, &mut in_word),
            '\'' => {
                in_word = true;
                loop {
                    match chars.next()? {
                        '\'' => break,
                        '\n' | '\r' => return None,
                        ch => word.push(ch),
                    }
                }
            }
            '"' => {
                in_word = true;
                loop {
                    match chars.next()? {
                        '"' => break,
                        '$' | '`' | '\\' | '\n' | '\r' => return None,
                        ch => word.push(ch),
                    }
                }
            }
            '|' => {
                flush(&mut tokens, &mut word, &mut in_word);
                if chars.next_if_eq(&'|').is_some() {
                    tokens.push(Token::Op("||"));
                } else {
                    tokens.push(Token::Op("|"));
                }
            }
            '&' => {
                flush(&mut tokens, &mut word, &mut in_word);
                chars.next_if_eq(&'&')?;
                tokens.push(Token::Op("&&"));
            }
            ';' => {
                flush(&mut tokens, &mut word, &mut in_word);
                tokens.push(Token::Op(";"));
            }
            c if is_plain(c) => {
                in_word = true;
                word.push(c);
            }
            _ => return None,
        }
    }
    flush(&mut tokens, &mut word, &mut in_word);
    Some(tokens)
}

fn segment_is_read_only(words: &[&str], root_relative: bool) -> bool {
    let Some((&name, args)) = words.split_first() else {
        return false;
    };
    if args.iter().any(|arg| word_is_guarded(arg, root_relative)) {
        return false;
    }
    match name {
        "cat" | "head" | "tail" | "wc" | "ls" | "pwd" | "echo" | "true" | "false" | "cut"
        | "tr" | "nl" | "paste" | "rev" | "tac" | "seq" | "stat" | "which" | "whoami" | "id"
        | "uname" | "df" | "du" | "free" | "uptime" | "nproc" | "basename" | "dirname"
        | "realpath" | "readlink" | "cmp" | "comm" | "md5sum" | "sha1sum" | "sha256sum"
        | "sha512sum" => true,
        "grep" | "egrep" | "fgrep" => !args.iter().any(|arg| {
            has_short(arg, &['r', 'R', 'd'])
                || abbreviates(arg, &["recursive", "dereference-recursive", "directories"])
        }),
        "diff" => !args
            .iter()
            .any(|arg| has_short(arg, &['r']) || abbreviates(arg, &["recursive"])),
        "rg" => {
            let short_u = args
                .iter()
                .filter_map(|arg| short_flags(arg))
                .map(|flags| flags.matches('u').count())
                .sum::<usize>();
            short_u < 2
                && !args.iter().any(|arg| {
                    has_short(arg, &['z', '.'])
                        || abbreviates(
                            arg,
                            &[
                                "pre",
                                "hostname-bin",
                                "search-zip",
                                "hidden",
                                "unrestricted",
                            ],
                        )
                })
        }
        "find" => !args.iter().any(|arg| {
            matches!(
                *arg,
                "-exec"
                    | "-execdir"
                    | "-ok"
                    | "-okdir"
                    | "-delete"
                    | "-fls"
                    | "-fprint"
                    | "-fprint0"
                    | "-fprintf"
            )
        }),
        "sort" => !args
            .iter()
            .any(|arg| has_short(arg, &['o']) || abbreviates(arg, &["output", "compress-program"])),
        "uniq" => {
            let mut operands = 0;
            let mut after_options = false;
            for arg in args {
                if !after_options && *arg == "--" {
                    after_options = true;
                } else if after_options || *arg == "-" || !arg.starts_with('-') {
                    operands += 1;
                }
            }
            operands <= 1
        }
        "sed" => matches!(args.len(), 2 | 3) && args[0] == "-n" && is_sed_print_range(args[1]),
        // `e`/`E` prints process environments: `ps e`/`ps -E` on Linux,
        // `ps -e` on BSD and macOS.
        "ps" => !args
            .iter()
            .any(|arg| !arg.starts_with("--") && arg.contains(['e', 'E'])),
        "date" => {
            args.iter().filter(|arg| arg.starts_with('+')).count() <= 1
                && args
                    .iter()
                    .all(|arg| arg.starts_with('+') || matches!(*arg, "-u" | "--utc" | "-R"))
        }
        "hostname" => matches!(args, [] | ["-f"] | ["-s"]),
        "systemctl" => {
            args.first().is_some_and(|verb| {
                matches!(
                    *verb,
                    "status"
                        | "is-active"
                        | "is-enabled"
                        | "is-failed"
                        | "list-units"
                        | "list-unit-files"
                        | "list-timers"
                        | "show"
                        | "cat"
                )
            }) && !args
                .iter()
                .any(|arg| has_short(arg, &['H', 'M']) || abbreviates(arg, &["host", "machine"]))
        }
        "journalctl" => !args.iter().any(|arg| {
            abbreviates(
                arg,
                &[
                    "rotate",
                    "vacuum-size",
                    "vacuum-time",
                    "vacuum-files",
                    "flush",
                    "sync",
                    "relinquish-var",
                    "smart-relinquish-var",
                    "setup-keys",
                    "update-catalog",
                    "cursor-file",
                ],
            )
        }),
        // Inspection subcommands on the remote's default daemon. Global options
        // (`-H`, `--context`, `--config`) only parse before the subcommand, so
        // the subcommand must come first; the flag check also rejects them
        // later in case a CLI version accepts them there. `inspect` and `top`
        // stay on approval: like `ps e`, they print process environments.
        "docker" => {
            args.first().is_some_and(|verb| {
                matches!(
                    *verb,
                    "ps" | "logs" | "stats" | "events" | "images" | "version" | "info" | "port"
                )
            }) && !args.iter().any(|arg| {
                has_short(arg, &['H', 'c']) || abbreviates(arg, &["host", "context", "config"])
            })
        }
        _ => false,
    }
}

/// The letters of a word that starts with exactly one `-` (`-uo` → `uo`).
fn short_flags(word: &str) -> Option<&str> {
    word.strip_prefix('-')
        .filter(|rest| !rest.is_empty() && !rest.starts_with('-'))
}

/// Conservative: an attached option value containing a listed letter matches
/// too, which only sends the command to approval.
fn has_short(word: &str, letters: &[char]) -> bool {
    short_flags(word).is_some_and(|flags| flags.contains(letters))
}

/// GNU `getopt_long` accepts any unambiguous prefix of a long option, so
/// `--outp=f` is `--output=f`. A word matches when its option name is a
/// non-empty prefix of a listed name.
fn abbreviates(word: &str, names: &[&str]) -> bool {
    let Some(rest) = word.strip_prefix("--") else {
        return false;
    };
    let name = rest.split_once('=').map_or(rest, |(name, _)| name);
    !name.is_empty() && names.iter().any(|listed| listed.starts_with(name))
}

/// `N p` or `M,N p` with decimal line numbers.
fn is_sed_print_range(arg: &str) -> bool {
    let Some(range) = arg.strip_suffix('p') else {
        return false;
    };
    let mut parts = range.split(',');
    let numeric = |part: Option<&str>| {
        part.is_some_and(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
    };
    numeric(parts.next())
        && match parts.next() {
            None => true,
            second => numeric(second) && parts.next().is_none(),
        }
}

/// Path guard (spec 318): the word itself and the value after each `=`.
fn word_is_guarded(word: &str, root_relative: bool) -> bool {
    std::iter::once(word)
        .chain(word.match_indices('=').map(|(index, _)| &word[index + 1..]))
        .any(|value| value_is_guarded(value, root_relative))
}

/// A hidden component (`.ssh`, `.env`, `..`) anywhere, or a value under
/// `/dev`, `/proc` or `/sys` — absolute, or relative when it resolves from `/`.
fn value_is_guarded(value: &str, root_relative: bool) -> bool {
    let mut components = value
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".");
    if components.clone().any(|part| part.starts_with('.')) {
        return true;
    }
    (value.starts_with('/') || root_relative)
        && matches!(components.next(), Some("dev" | "proc" | "sys"))
}

#[cfg(test)]
mod tests {
    use super::read_only_script;

    fn qualifies(command: &str) -> bool {
        read_only_script(command, Some("/srv/app")).is_some()
    }

    #[test]
    fn plain_read_only_commands_qualify_and_are_requoted() {
        assert_eq!(
            read_only_script("ls -la /var/log", None).as_deref(),
            Some("'ls' '-la' '/var/log'")
        );
        assert_eq!(
            read_only_script("ps aux | grep 'nginx: worker' | wc -l", Some("/srv")).as_deref(),
            Some("'ps' 'aux' | 'grep' 'nginx: worker' | 'wc' '-l'")
        );
        assert_eq!(
            read_only_script("grep \"it's\" notes.txt", Some("/srv")).as_deref(),
            Some("'grep' 'it'\\''s' 'notes.txt'")
        );
        assert_eq!(
            read_only_script("df -h && uptime || true; date +%F", None).as_deref(),
            Some("'df' '-h' && 'uptime' || 'true' ; 'date' '+%F'")
        );
        for command in [
            "cat README.md",
            "tail -n 200 /var/log/syslog",
            "grep 'a|b;c' log.txt",
            "echo \"x;y\"",
            "find . -name '*.log' -mtime -1",
            "rg -n TODO src",
            "sort -n -k2,2 data.tsv",
            "uniq -c",
            "sed -n 10,20p server.log",
            "ps -p 123",
            "hostname -f",
            "systemctl status nginx --no-pager",
            "journalctl -u app -n 100 --since today",
            "stat ./build/output.bin",
            "ls .",
            "cat ''",
        ] {
            assert!(qualifies(command), "{command}");
        }
    }

    #[test]
    fn shell_syntax_outside_the_subset_needs_approval() {
        for command in [
            "cat $(whoami)",
            "cat `whoami`",
            "echo $HOME",
            "echo \"$HOME\"",
            "echo \"a\\b\"",
            "ls > out.txt",
            "cat < in.txt",
            "ls 2>/dev/null",
            "sleep 1 &",
            "ls *.log",
            "ls file?.txt",
            "ls [ab]",
            "cat ~/notes",
            "ls # comment",
            "(ls)",
            "{ ls; }",
            "ls\nrm -rf x",
            "ls\rrm",
            "ls 'unterminated",
            "ls;",
            "; ls",
            "ls || ",
            "ls | | wc",
            "",
            "   ",
            "echo a\\ b",
            "! ls",
            "ls ^ wc",
        ] {
            assert!(!qualifies(command), "{command:?}");
        }
    }

    #[test]
    fn unknown_and_lookalike_command_names_need_approval() {
        for command in [
            "lsx",
            "/bin/ls",
            "./ls",
            "LD_PRELOAD=x cat f",
            "FOO=1 ls",
            "'ls'x",
            "ls && rm -rf build",
            "cat f | tee g",
            "git status",
            "cd /srv && ls",
            "env",
            "printenv",
            "awk '{print}' f",
            "xargs cat",
            "less f",
            "jq . f.json",
            "docker",
            "sh -c ls",
            "bash -lc ls",
            "sudo cat f",
            "rm -rf x",
        ] {
            assert!(!qualifies(command), "{command:?}");
        }
    }

    #[test]
    fn writing_executing_or_environment_options_need_approval() {
        for command in [
            "grep -r TODO src",
            "grep -Rn TODO src",
            "grep -d recurse TODO src",
            "grep --directories=recurse TODO src",
            "grep --recursive TODO src",
            "grep --recur TODO src",
            "diff -ru a b",
            "diff --recursive a b",
            "rg --pre cat x",
            "rg --pre=cat x",
            "rg --hostname-bin=x y",
            "rg -z x",
            "rg -iz x",
            "rg --search-zip x",
            "rg --hidden x",
            "rg -uu x",
            "rg -u -u x",
            "rg -. x",
            "rg --unrestricted x",
            "find . -delete",
            "find . -exec rm {} ;",
            "find . -execdir ls",
            "find . -ok rm",
            "find . -fprint out",
            "find . -fprintf out %p",
            "find . -fls out",
            "sort -o out in",
            "sort -uo out in",
            "sort --output=out in",
            "sort --outp=out in",
            "sort --compress-program=gzip in",
            "uniq in out",
            "uniq -c in out",
            "uniq - out",
            "uniq -- -in out",
            "sed -i s/a/b/ f",
            "sed -n 1w out f",
            "sed -n 1p f g",
            "sed 1p f",
            "sed -n p f",
            "ps auxe",
            "ps aux -e",
            "ps -ef",
            "ps eww",
            "ps -E",
            "date -s 2020-01-01",
            "date --set=2020-01-01",
            "date 010100002020",
            "date +%F +%T",
            "hostname evil",
            "hostname -F file",
            "hostname -b",
            "systemctl restart nginx",
            "systemctl stop nginx",
            "systemctl --user status app",
            "systemctl status nginx -H other",
            "systemctl status nginx --host=other",
            "systemctl status nginx -M box",
            "systemctl status nginx --mach=box",
            "systemctl",
            "journalctl --rotate",
            "journalctl --vacuum-size=1G",
            "journalctl --vacuum-t=1d",
            "journalctl --flush",
            "journalctl --sync",
            "journalctl --setup-keys",
            "journalctl --update-catalog",
            "journalctl --cursor-file=/tmp/c",
            "journalctl --relinquish-var",
            "journalctl --smart-relinquish-var",
        ] {
            assert!(!qualifies(command), "{command:?}");
        }
    }

    #[test]
    fn docker_inspection_on_the_default_daemon_qualifies() {
        for command in [
            "docker ps -a --format '{{.Names}} {{.Status}}'",
            "docker logs --tail 100 beflex-alfresco",
            "docker logs -f --since 10m app",
            "docker stats --no-stream",
            "docker events --since 3h --until 0s --filter container=solr",
            "docker images",
            "docker version",
            "docker info --format '{{.ServerVersion}}'",
            "docker port web",
            "docker ps | grep alfresco",
        ] {
            assert!(qualifies(command), "{command}");
        }
        for command in [
            "docker inspect app",
            "docker inspect --format '{{.State.Status}}' app",
            "docker top app",
            "docker exec app ls",
            "docker rm app",
            "docker restart app",
            "docker compose ps",
            "docker container ls",
            "docker -H ssh://other ps",
            "docker --context prod ps",
            "docker --config /srv/cfg ps",
            "docker ps -H tcp://other",
            "docker ps --host=tcp://other",
            "docker logs --cont=prod app",
            "docker logs .ssh",
        ] {
            assert!(!qualifies(command), "{command:?}");
        }
    }

    #[test]
    fn credential_dotfiles_and_device_trees_need_approval() {
        for command in [
            "cat .env",
            "cat ./.env",
            "cat /home/alice/.ssh/id_ed25519",
            "cat config/.aws/credentials",
            "cat ../secret",
            "ls src/../..",
            "grep --file=.patterns x",
            "cat /dev/watchdog",
            "cat /proc/1/environ",
            "ls /sys/kernel",
            "ls /dev",
            "wc --files0-from=/proc/self/environ",
        ] {
            assert!(!qualifies(command), "{command:?}");
        }
        // Relative words resolve from `/` when cwd is the root or unknown.
        assert!(read_only_script("cat proc/1/environ", Some("/")).is_none());
        assert!(read_only_script("cat dev/watchdog", None).is_none());
        assert!(read_only_script("cat dev/notes.txt", Some("/srv/app")).is_some());
        // The effective cwd itself is guarded.
        for cwd in ["/dev", "/proc/1", "/home/alice/.ssh", "/srv/../dev"] {
            assert!(read_only_script("ls", Some(cwd)).is_none(), "{cwd}");
        }
        assert!(read_only_script("ls", Some("/srv/app")).is_some());
    }
}
