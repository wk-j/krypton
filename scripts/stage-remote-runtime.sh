#!/bin/sh
set -eu

profile="${1:-release}"
case "$profile" in
  debug)
    cargo_flags=""
    ;;
  release)
    cargo_flags="--release"
    ;;
  *)
    echo "usage: $0 <debug|release>" >&2
    exit 2
    ;;
esac

host_target="$(rustc -vV | sed -n 's/^host: //p')"
if [ -z "$host_target" ]; then
  echo "could not detect the Rust host target" >&2
  exit 1
fi

app_version="$(sed -n '/^name = "app"$/,/^$/s/^version = "\([^"]*\)"$/\1/p' src-tauri/Cargo.toml)"
runtime_version="$(sed -n '/^name = "krypton-remote"$/,/^$/s/^version = "\([^"]*\)"$/\1/p' src-tauri/remote-runtime/Cargo.toml)"
if [ -z "$app_version" ] || [ "$app_version" != "$runtime_version" ]; then
  echo "app and krypton-remote versions must match" >&2
  exit 1
fi

# shellcheck disable=SC2086 # An empty flag is intentional for debug builds.
cargo build $cargo_flags --manifest-path src-tauri/Cargo.toml -p krypton-remote

source_path="src-tauri/target/$profile/krypton-remote"
destination_dir="src-tauri/remote-binaries/$host_target"
mkdir -p "$destination_dir"
install -m 755 "$source_path" "$destination_dir/krypton-remote"
echo "Staged krypton-remote for $host_target"
