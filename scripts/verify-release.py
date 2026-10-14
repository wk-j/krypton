#!/usr/bin/env python3
"""Check a release tag against source versions and verify staged release assets."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys
import tomllib


REMOTE_TARGETS = (
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "aarch64-unknown-linux-gnu",
    "x86_64-unknown-linux-gnu",
)
MAC_TARGETS = REMOTE_TARGETS[:2]


class ReleaseVerificationError(Exception):
    """A release candidate does not satisfy the repository contract."""


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def read_toml(path: Path) -> dict:
    return tomllib.loads(path.read_text(encoding="utf-8"))


def locked_version(packages: list[dict], name: str) -> str:
    versions = [package["version"] for package in packages if package.get("name") == name]
    if len(versions) != 1:
        raise ReleaseVerificationError(f"Cargo.lock must contain exactly one {name} package")
    return versions[0]


def verify_version(root: Path, tag: str) -> str:
    if re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", tag) is None:
        raise ReleaseVerificationError(f"invalid release tag: {tag}")
    version = tag[1:]
    npm_package = read_json(root / "package.json")
    npm_lock = read_json(root / "package-lock.json")
    tauri = read_json(root / "src-tauri/tauri.conf.json")
    app = read_toml(root / "src-tauri/Cargo.toml")
    remote = read_toml(root / "src-tauri/remote-runtime/Cargo.toml")
    packages = read_toml(root / "src-tauri/Cargo.lock")["package"]
    actual = {
        "package.json": npm_package["version"],
        "package-lock.json": npm_lock["version"],
        "package-lock.json root": npm_lock["packages"][""]["version"],
        "tauri.conf.json": tauri["version"],
        "app Cargo.toml": app["package"]["version"],
        "krypton-remote Cargo.toml": remote["package"]["version"],
        "app Cargo.lock": locked_version(packages, "app"),
        "krypton-remote Cargo.lock": locked_version(packages, "krypton-remote"),
    }
    mismatches = [f"{source}: {value}" for source, value in actual.items() if value != version]
    if mismatches:
        raise ReleaseVerificationError(
            f"{tag} does not match these versions: " + ", ".join(mismatches)
        )
    return version


def expected_assets(version: str) -> set[str]:
    binaries = {f"Krypton_{version}_{target}.dmg" for target in MAC_TARGETS}
    binaries.update(f"krypton-remote-{target}" for target in REMOTE_TARGETS)
    return binaries | {f"{name}.sha256" for name in binaries}


def collect_artifacts(source: Path, destination: Path, version: str) -> None:
    groups = {
        f"release-macos-{target}": {f"Krypton_{version}_{target}.dmg"}
        for target in MAC_TARGETS
    }
    groups.update(
        {f"release-remote-{target}": {f"krypton-remote-{target}"} for target in REMOTE_TARGETS}
    )
    actual_groups = {path.name for path in source.iterdir()}
    if actual_groups != set(groups):
        raise ReleaseVerificationError(
            f"artifact groups mismatch; missing={sorted(set(groups) - actual_groups)}, "
            f"unexpected={sorted(actual_groups - set(groups))}"
        )
    destination.mkdir()
    for group, binaries in groups.items():
        folder = source / group
        if not folder.is_dir():
            raise ReleaseVerificationError(f"artifact group is not a directory: {group}")
        expected = binaries | {f"{name}.sha256" for name in binaries}
        actual = {path.name for path in folder.iterdir()}
        if actual != expected:
            raise ReleaseVerificationError(f"wrong files in artifact group {group}: {sorted(actual)}")
        for name in expected:
            path = folder / name
            if not path.is_file():
                raise ReleaseVerificationError(f"artifact is not a file: {group}/{name}")
            target = destination / name
            if target.exists():
                raise ReleaseVerificationError(f"duplicate release asset: {name}")
            shutil.copyfile(path, target)
    verify_assets(destination, version)


def verify_assets(directory: Path, version: str) -> None:
    expected = expected_assets(version)
    actual = {path.name for path in directory.iterdir() if path.is_file()}
    if actual != expected:
        missing = sorted(expected - actual)
        unexpected = sorted(actual - expected)
        raise ReleaseVerificationError(
            f"asset inventory mismatch; missing={missing}, unexpected={unexpected}"
        )
    for name in sorted(expected):
        path = directory / name
        if path.stat().st_size == 0:
            raise ReleaseVerificationError(f"empty release asset: {name}")
        if name.endswith(".sha256"):
            continue
        line = (directory / f"{name}.sha256").read_text(encoding="utf-8").strip()
        match = re.fullmatch(r"([0-9a-fA-F]{64}) [ *](.+)", line)
        if match is None or match.group(2) != name:
            raise ReleaseVerificationError(f"invalid checksum file: {name}.sha256")
        with path.open("rb") as binary:
            digest = hashlib.file_digest(binary, "sha256").hexdigest()
        if digest.lower() != match.group(1).lower():
            raise ReleaseVerificationError(f"checksum mismatch: {name}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    version_command = subcommands.add_parser("version")
    version_command.add_argument("--tag", required=True)
    version_command.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    assets_command = subcommands.add_parser("assets")
    assets_command.add_argument("--version", required=True)
    assets_command.add_argument("--dir", type=Path, required=True)
    collect_command = subcommands.add_parser("collect")
    collect_command.add_argument("--version", required=True)
    collect_command.add_argument("--dir", type=Path, required=True)
    collect_command.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    try:
        if args.command == "version":
            print(f"Verified release v{verify_version(args.root, args.tag)}")
        elif args.command == "assets":
            verify_assets(args.dir, args.version)
            print(f"Verified {len(expected_assets(args.version))} release assets")
        else:
            collect_artifacts(args.dir, args.output, args.version)
            print(f"Collected and verified {len(expected_assets(args.version))} release assets")
    except (ReleaseVerificationError, OSError, KeyError, ValueError) as error:
        print(f"Release verification failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
