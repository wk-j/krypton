#!/usr/bin/env python3
"""Focused tests for the release gate; run with Python 3.11 or newer."""

import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("verify-release.py")
SPEC = importlib.util.spec_from_file_location("verify_release", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class ReleaseVerificationTests(unittest.TestCase):
    def test_matching_version_and_lockfiles(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.write_version_fixture(root, "1.2.3")
            self.assertEqual(release.verify_version(root, "v1.2.3"), "1.2.3")

            (root / "src-tauri/remote-runtime/Cargo.toml").write_text(
                '[package]\nname = "krypton-remote"\nversion = "1.2.2"\n', encoding="utf-8"
            )
            with self.assertRaisesRegex(release.ReleaseVerificationError, "krypton-remote Cargo.toml"):
                release.verify_version(root, "v1.2.3")
            with self.assertRaisesRegex(release.ReleaseVerificationError, "invalid release tag"):
                release.verify_version(root, "v1.2.3-rc1")

    def test_complete_assets_and_checksum_failures(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            for name in release.expected_assets("1.2.3"):
                if name.endswith(".sha256"):
                    continue
                payload = name.encode("utf-8")
                (directory / name).write_bytes(payload)
                digest = hashlib.sha256(payload).hexdigest()
                (directory / f"{name}.sha256").write_text(
                    f"{digest}  {name}\n", encoding="utf-8"
                )
            release.verify_assets(directory, "1.2.3")

            binary = directory / "krypton-remote-aarch64-apple-darwin"
            binary.write_bytes(b"tampered")
            with self.assertRaisesRegex(release.ReleaseVerificationError, "checksum mismatch"):
                release.verify_assets(directory, "1.2.3")

            binary.unlink()
            with self.assertRaisesRegex(release.ReleaseVerificationError, "asset inventory mismatch"):
                release.verify_assets(directory, "1.2.3")

    def test_collect_requires_all_six_distinct_artifact_groups(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "downloaded"
            source.mkdir()
            for target in release.MAC_TARGETS:
                self.write_group(source, f"release-macos-{target}", f"Krypton_1.2.3_{target}.dmg")
            for target in release.REMOTE_TARGETS:
                self.write_group(source, f"release-remote-{target}", f"krypton-remote-{target}")
            release.collect_artifacts(source, root / "assets", "1.2.3")

            shutil.rmtree(source / "release-remote-x86_64-unknown-linux-gnu")
            with self.assertRaisesRegex(release.ReleaseVerificationError, "artifact groups mismatch"):
                release.collect_artifacts(source, root / "missing-assets", "1.2.3")

    @staticmethod
    def write_group(source: Path, group: str, name: str) -> None:
        folder = source / group
        folder.mkdir()
        payload = name.encode("utf-8")
        (folder / name).write_bytes(payload)
        digest = hashlib.sha256(payload).hexdigest()
        (folder / f"{name}.sha256").write_text(f"{digest}  {name}\n", encoding="utf-8")

    @staticmethod
    def write_version_fixture(root: Path, version: str) -> None:
        (root / "src-tauri/remote-runtime").mkdir(parents=True)
        (root / "package.json").write_text(json.dumps({"version": version}), encoding="utf-8")
        (root / "package-lock.json").write_text(
            json.dumps({"version": version, "packages": {"": {"version": version}}}),
            encoding="utf-8",
        )
        (root / "src-tauri/tauri.conf.json").write_text(
            json.dumps({"version": version}), encoding="utf-8"
        )
        (root / "src-tauri/Cargo.toml").write_text(
            f'[package]\nname = "app"\nversion = "{version}"\n', encoding="utf-8"
        )
        (root / "src-tauri/remote-runtime/Cargo.toml").write_text(
            f'[package]\nname = "krypton-remote"\nversion = "{version}"\n', encoding="utf-8"
        )
        (root / "src-tauri/Cargo.lock").write_text(
            f'[[package]]\nname = "app"\nversion = "{version}"\n'
            f'[[package]]\nname = "krypton-remote"\nversion = "{version}"\n',
            encoding="utf-8",
        )


if __name__ == "__main__":
    unittest.main()
