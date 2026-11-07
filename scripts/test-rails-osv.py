#!/usr/bin/env python3
"""Focused tests for rails-osv.py; run with Python 3.11 or newer."""

import importlib.util
from pathlib import Path
import unittest


SCRIPT = Path(__file__).with_name("rails-osv.py")
SPEC = importlib.util.spec_from_file_location("rails_osv", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
osv = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(osv)


def report_for(*groups: tuple[str, str]) -> dict:
    """One npm package whose groups are (id, max_severity) pairs."""
    return {
        "results": [{
            "source": {"path": "/repo/package-lock.json", "type": "lockfile"},
            "packages": [{
                "package": {"name": "lodash", "version": "4.17.20"},
                "groups": [{"ids": [gid], "max_severity": score} for gid, score in groups],
                "vulnerabilities": [{"id": gid, "summary": gid} for gid, _score in groups],
            }],
        }],
    }


class SeverityTests(unittest.TestCase):
    def test_cvss3_base_scores(self) -> None:
        self.assertEqual(osv.cvss3_base("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"), 9.8)
        self.assertEqual(osv.cvss3_base("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:L/A:L"), 6.5)
        self.assertIsNone(osv.cvss3_base("not-a-vector"))

    def test_high_score_fails_and_medium_does_not(self) -> None:
        rows = osv.findings(report_for(("GHSA-high", "7.2"), ("GHSA-mid", "6.9"), ("GHSA-crit", "9.8")), ["package-lock.json"])
        by_id = {row["ids"][0]: row for row in rows}
        self.assertEqual([row["fails"] for row in (by_id["GHSA-high"], by_id["GHSA-mid"], by_id["GHSA-crit"])], [True, False, True])
        self.assertEqual(by_id["GHSA-high"]["severity"], "HIGH 7.2")
        self.assertEqual(by_id["GHSA-crit"]["severity"], "CRITICAL 9.8")
        self.assertEqual(by_id["GHSA-mid"]["severity"], "MEDIUM 6.9")

    def test_exact_seven_fails(self) -> None:
        rows = osv.findings(report_for(("GHSA-edge", "7.0")), ["package-lock.json"])
        self.assertTrue(rows[0]["fails"])
        self.assertEqual(rows[0]["severity"], "HIGH 7.0")

    def test_empty_score_uses_advisory_word(self) -> None:
        report = report_for(("GHSA-word", ""))
        report["results"][0]["packages"][0]["vulnerabilities"][0]["database_specific"] = {"severity": "HIGH"}
        rows = osv.findings(report, ["package-lock.json"])
        self.assertTrue(rows[0]["fails"])
        self.assertEqual(rows[0]["severity"], "HIGH")

    def test_empty_score_uses_cvss_vector(self) -> None:
        report = report_for(("GHSA-vec", ""))
        report["results"][0]["packages"][0]["vulnerabilities"][0]["severity"] = [{
            "type": "CVSS_V3",
            "score": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:L/A:L",
        }]
        rows = osv.findings(report, ["package-lock.json"])
        self.assertFalse(rows[0]["fails"])
        self.assertEqual(rows[0]["severity"], "MEDIUM 6.5")

    def test_moderate_word_does_not_fail(self) -> None:
        report = report_for(("GHSA-mod", ""))
        report["results"][0]["packages"][0]["vulnerabilities"][0]["database_specific"] = {"severity": "MODERATE"}
        rows = osv.findings(report, ["package-lock.json"])
        self.assertFalse(rows[0]["fails"])

    def test_report_lists_only_the_rows_it_is_given(self) -> None:
        rows = osv.findings(report_for(("GHSA-high", "8.1")), ["package-lock.json"])
        text = osv.report(rows)
        self.assertIn("HIGH 8.1", text)
        self.assertIn("https://osv.dev/GHSA-high", text)


if __name__ == "__main__":
    unittest.main()
