#!/usr/bin/env python3
"""Rails check `osv` (ADR 0029): fail only on a high or critical vulnerability.

A manual check (spec 368): it runs only when the human starts it. Every lockfile
in LOCKFILES that exists is scanned whole with OSV-Scanner on every run. A group
fails the check only when its severity is high or critical (CVSS base score
>= 7.0, the same cut OSV-Scanner uses). A lower or unscored finding is counted
and does not fail the row.

Exit 0: no lockfile exists, or none has a high or critical vulnerability.
Exit 1: a high or critical vulnerability, or the scan could not run (the output says which).
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
# CVSS v3 high starts at 7.0; critical starts at 9.0. OSV-Scanner's group
# `max_severity` is that base score, as a string ("7.2").
HIGH_SCORE = 7.0
HIGH_WORDS = frozenset({"HIGH", "CRITICAL"})
BELOW_WORDS = frozenset({"LOW", "MEDIUM", "MODERATE", "NONE", "NEGLIGIBLE", "UNKNOWN"})


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


def numeric_score(raw: object) -> float | None:
    """A CVSS base score, or None when `raw` is not one."""
    if isinstance(raw, bool) or raw is None:
        return None
    if isinstance(raw, (int, float)):
        return float(raw)
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return None
        try:
            return float(text)
        except ValueError:
            return None
    return None


def word_rating(raw: object) -> str | None:
    """A severity word OSV records when it has no numeric score."""
    if not isinstance(raw, str):
        return None
    word = raw.strip().upper()
    if word in HIGH_WORDS or word in BELOW_WORDS:
        return word
    return None


def _roundup(value: float) -> float:
    """CVSS v3.1 Roundup: the smallest tenth that is not below `value`."""
    scaled = int(round(value * 100000))
    if scaled % 10000 == 0:
        return scaled / 100000.0
    return (scaled // 10000 + 1) / 10.0


def cvss3_base(vector: str) -> float | None:
    """CVSS v3.0/v3.1 base score, or None when the vector is not one."""
    if not vector.startswith("CVSS:3."):
        return None
    parts: dict[str, str] = {}
    for piece in vector.split("/")[1:]:
        if ":" not in piece:
            return None
        key, val = piece.split(":", 1)
        parts[key] = val
    av = {"N": 0.85, "A": 0.62, "L": 0.55, "P": 0.20}.get(parts.get("AV", ""))
    ac = {"L": 0.77, "H": 0.44}.get(parts.get("AC", ""))
    ui = {"N": 0.85, "R": 0.62}.get(parts.get("UI", ""))
    cia = {"H": 0.56, "L": 0.22, "N": 0.0}
    scope = parts.get("S", "")
    c = cia.get(parts.get("C", ""))
    i = cia.get(parts.get("I", ""))
    a = cia.get(parts.get("A", ""))
    if scope == "U":
        pr = {"N": 0.85, "L": 0.62, "H": 0.27}.get(parts.get("PR", ""))
    elif scope == "C":
        pr = {"N": 0.85, "L": 0.68, "H": 0.50}.get(parts.get("PR", ""))
    else:
        pr = None
    if None in (av, ac, ui, pr, c, i, a):
        return None
    iss = 1 - (1 - c) * (1 - i) * (1 - a)
    if scope == "U":
        impact = 6.42 * iss
    else:
        impact = 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15
    exploitability = 8.22 * av * ac * pr * ui
    if impact <= 0:
        return 0.0
    raw = impact + exploitability if scope == "U" else 1.08 * (impact + exploitability)
    return _roundup(min(raw, 10))


def group_severity(group: dict, vulns: dict[str, dict]) -> tuple[bool, float | None, str]:
    """(fails the check, CVSS score or None, label such as `HIGH 7.2`).

    Prefer the group's `max_severity`. Fall back to a member advisory's
    `database_specific.severity` word or its CVSS v3 vector, for a scanner
    that left `max_severity` empty.
    """
    score = numeric_score(group.get("max_severity"))
    if score is not None:
        return score >= HIGH_SCORE, score, _label(score)
    word = word_rating(group.get("max_severity"))
    if word is not None:
        return word in HIGH_WORDS, None, word
    best: float | None = None
    best_word: str | None = None
    for vid in group.get("ids") or []:
        vuln = vulns.get(vid) or {}
        specific = vuln.get("database_specific")
        if isinstance(specific, dict):
            member = word_rating(specific.get("severity"))
            if member in HIGH_WORDS:
                return True, best, member
            if member is not None and best_word is None:
                best_word = member
        for item in vuln.get("severity") or []:
            if not isinstance(item, dict):
                continue
            if str(item.get("type") or "").upper() != "CVSS_V3":
                continue
            parsed = cvss3_base(str(item.get("score") or ""))
            if parsed is None:
                continue
            best = parsed if best is None else max(best, parsed)
            if parsed >= HIGH_SCORE:
                return True, best, _label(best)
    if best is not None:
        return False, best, _label(best)
    if best_word is not None:
        return False, None, best_word
    return False, None, "unscored"


def _label(score: float) -> str:
    if score >= 9.0:
        name = "CRITICAL"
    elif score >= HIGH_SCORE:
        name = "HIGH"
    elif score >= 4.0:
        name = "MEDIUM"
    elif score > 0:
        name = "LOW"
    else:
        name = "NONE"
    return f"{name} {score:.1f}"


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
            # A vulnerability the report did not put in a group still counts, with no score of its own
            # until `group_severity` reads the advisory.
            extra = [{"ids": [vid], "max_severity": ""} for vid in vulns if vid not in grouped]
            for group in list(entry.get("groups") or []) + extra:
                ids = group.get("ids") or []
                if not ids:
                    continue
                fails, score, label = group_severity(group, vulns)
                rows.append({
                    "lockfile": rel,
                    "package": f"{package.get('name', '?')}@{package.get('version', '?')}",
                    "ids": ids,
                    "summary": next((vulns[vid].get("summary") for vid in ids if vulns.get(vid, {}).get("summary")), ""),
                    "fails": fails,
                    "score": score,
                    "severity": label,
                })
    return rows


def report(rows: list[dict]) -> str:
    lines = []
    for row in sorted(rows, key=lambda row: (row["lockfile"], row["package"], row["ids"][0])):
        summary = row["summary"]
        if len(summary) > SUMMARY_CHARS:
            summary = summary[: SUMMARY_CHARS - 1] + "…"
        lines.append(f"  {row['lockfile']}  {row['package']}  {row['severity']}  {', '.join(row['ids'])}")
        lines.append(f"    {summary + '  ' if summary else ''}https://osv.dev/{row['ids'][0]}")
    return "\n".join(lines)


def _aside(below: int, unscored: int) -> str:
    parts = []
    if below:
        parts.append(f"{below} below high")
    if unscored:
        parts.append(f"{unscored} unscored")
    return f" ({', '.join(parts)})" if parts else ""


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

    failing = [row for row in rows if row["fails"]]
    below = sum(1 for row in rows if not row["fails"] and row["severity"] != "unscored")
    unscored = sum(1 for row in rows if row["severity"] == "unscored")
    scanned = ", ".join(rels)
    aside = _aside(below, unscored)
    if not failing:
        if aside:
            print(f"osv: no high or critical vulnerabilities in {scanned}{aside}")
        else:
            print(f"osv: no known vulnerabilities in {scanned}")
        return 0
    packages = len({(row["lockfile"], row["package"]) for row in failing})
    # Rails keeps the output's tail (80 lines) and the judge reads its last 2 000
    # chars, so the count goes last where a long list cannot push it out.
    print(report(failing))
    print(f"osv: {len(failing)} high or critical vulnerabilities in {packages} packages of {scanned}{aside}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
