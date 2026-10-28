#!/bin/sh
# Runner for the [[check]] commands in .krypton/rails.toml (spec 337).
#
#   scripts/rails-check.sh vitest <test file>...
#   scripts/rails-check.sh cargo <libtest filter>...
#
# A check that names a test which no longer exists must fail, not pass with
# nothing run: vitest skips an unmatched path when another one matches, and
# libtest runs zero tests for an unmatched filter. So every named file must
# exist and every filter must match at least one app_lib unit test.
set -u

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root" || exit 2

[ "$#" -ge 2 ] || { echo "usage: $0 vitest|cargo <test file or filter>..." >&2; exit 2; }
mode=$1
shift

case "$mode" in
  vitest)
    for file in "$@"; do
      [ -f "$file" ] || { echo "rails-check: no such test file: $file" >&2; exit 1; }
    done
    exec npx vitest run "$@"
    ;;
  cargo)
    manifest="$root/src-tauri/Cargo.toml"
    for filter in "$@"; do
      listed=$(cargo test --manifest-path "$manifest" --lib -q -- --list "$filter" 2>&1) || {
        printf '%s\n' "$listed"
        exit 1
      }
      printf '%s\n' "$listed" | grep -q ': test$' || {
        echo "rails-check: no app_lib test matches filter: $filter" >&2
        exit 1
      }
    done
    exec cargo test --manifest-path "$manifest" --lib -- "$@"
    ;;
  *)
    echo "rails-check: unknown mode: $mode" >&2
    exit 2
    ;;
esac
