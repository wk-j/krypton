#!/usr/bin/env python3
"""Rails check `osv` (ADR 0029): no lockfile may carry a known vulnerability.

A manual check (spec 368): it runs only when the human starts it. Every lockfile
in LOCKFILES that exists is scanned whole with OSV-Scanner on every run, and every
known vulnerability in it fails the check.

Exit 0: no lockfile exists, or none has a known vulnerability.
Exit 1: a known vulnerability, or the scan could not run (the output says which).
"""

from collections.abc import Iterable
import json
from pathlib import Path
import shutil
import subprocess
import sys


LOCKFILES = ("package-lock.json", "src-tauri/Cargo.lock", "raycast/package-lock.json")
SCANNER = "osv-scanner"
SUMMARY_CHARS = 90


class ScanError(Exception):
    """OSV-Scanner did not produce a result; never a vulnerability finding."""


def lockfile_for(reported: str, rels: Iterable[str]) -> str | None:
    """Map OSV-Scanner's absolute source path back to its lockfile.

    Longest first, so `raycast/package-lock.json` is never read as the root
    `package-lock.json`. A suffix match survives a symlinked or `/private`
    prefix on macOS.
    """
    for rel in sorted(rels, key=len, reverse=True):
        if reported == rel or reported.endswith("/" + rel):
            return rel
    return None


def scan(scanner: str, base: Path, rels: list[str]) -> tuple[bool, dict]:
    """(whether OSV-Scanner exited 1 for vulnerabilities found, its JSON report)."""
    argv = [scanner, "scan", "--format", "json", "--verbosity", "error"]
    for rel in rels:
        argv += ["-L", str(base / rel)]
    done = subprocess.run(argv, capture_output=True, text=True)
    if done.returncode not in (0, 1):
        reason = {127: "general error", 128: "no packages found"}.get(done.returncode, "error")
        detail = (done.stderr or done.stdout).strip().splitlines()[-5:]
        raise ScanError(f"osv-scanner exit {done.returncode} ({reason})\n" + "\n".join(detail))
    try:
        return done.returncode == 1, json.loads(done.stdout)
    except json.JSONDecodeError as error:
        raise ScanError(f"osv-scanner output is not JSON: {error}") from error


def findings(report: dict, rels: list[str]) -> list[dict]:
    """One row per advisory group (aliases together) per package, as OSV-Scanner groups them."""
    rows = []
    for result in report.get("results") or []:
        rel = lockfile_for(result.get("source", {}).get("path", ""), rels)
        if rel is None:
            continue
        for entry in result.get("packages") or []:
            package = entry.get("package", {})
            vulns = {vuln.get("id"): vuln for vuln in entry.get("vulnerabilities") or [] if vuln.get("id")}
            groups = [group.get("ids") or [] for group in entry.get("groups") or []]
            grouped = {vid for ids in groups for vid in ids}
            groups += [[vid] for vid in vulns if vid not in grouped]
            for ids in groups:
                if not ids:
                    continue
                rows.append({
                    "lockfile": rel,
                    "package": f"{package.get('name', '?')}@{package.get('version', '?')}",
                    "ids": ids,
                    "summary": next((vulns[vid].get("summary") for vid in ids if vulns.get(vid, {}).get("summary")), ""),
                })
    return rows


def report(rows: list[dict]) -> str:
    lines = []
    for row in sorted(rows, key=lambda row: (row["lockfile"], row["package"], row["ids"][0])):
        summary = row["summary"]
        if len(summary) > SUMMARY_CHARS:
            summary = summary[: SUMMARY_CHARS - 1] + "…"
        lines.append(f"  {row['lockfile']}  {row['package']}  {', '.join(row['ids'])}")
        lines.append(f"    {summary + '  ' if summary else ''}https://osv.dev/{row['ids'][0]}")
    return "\n".join(lines)


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    rels = [rel for rel in LOCKFILES if (root / rel).is_file()]
    if not rels:
        print(f"osv: none of {', '.join(LOCKFILES)} exists, nothing to scan")
        return 0

    scanner = shutil.which(SCANNER)
    if scanner is None:
        print(f"osv: {SCANNER} is not on PATH, so {', '.join(rels)} went unscanned (brew install osv-scanner)")
        return 1
    try:
        found, result = scan(scanner, root, rels)
    except ScanError as error:
        print(f"osv: scan did not finish, this is not a vulnerability finding\n{error}")
        return 1
    rows = findings(result, rels)
    if found and not rows:
        # Exit 1 with no row read means the report changed shape: never a pass.
        print(f"osv: osv-scanner found vulnerabilities in {', '.join(rels)} but this check could not read its report")
        return 1

    scanned = ", ".join(rels)
    if not rows:
        print(f"osv: no known vulnerabilities in {scanned}")
        return 0
    packages = len({(row["lockfile"], row["package"]) for row in rows})
    # Rails keeps the output's tail (80 lines) and the judge reads its last 2 000
    # chars, so the count goes last where a long list cannot push it out.
    print(report(rows))
    print(f"osv: {len(rows)} known vulnerabilities in {packages} packages of {scanned}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
