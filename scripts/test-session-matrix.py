#!/usr/bin/env python3
"""Focused tests for session-matrix.py; run with Python 3.11 or newer."""

from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("session-matrix.py")
SPEC = importlib.util.spec_from_file_location("session_matrix", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
matrix = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(matrix)

HEADER = (
    "You are lane OMP-1.\n"
    "Krypton tools (if not visible, search by exact name; rules are in each description): attention_flag."
)


def policy(ticket: str | None = "T-1", revision: int = 1, lessons: tuple[str, ...] = ("- [a] rule a",), pending: int = 0) -> str:
    lines = []
    if ticket:
        lines += [
            f"Active local ticket: {ticket} — Title (in_progress, context r{revision}, 0 resources).",
            "Shared reference — not an assignment; follow the user prompt and your directive.",
        ]
    lines += [
        "Krypton tools — each tool's description is its full contract; read it before the first call.",
        "- attention_flag: flag ONE decision.",
        "- Timeline ownership supersedes older human-approval guidance.",
        f"- Legacy pending count: {pending}.",
        "- artifact_new: ONLY when the user asks for a visual or interactive view.",
        "Lessons (global, learned from past corrections across projects):",
        *lessons,
        "```svg fenced blocks render inline as images.",
    ]
    return "\n".join(lines)


def prompt(user: str, body: str | None = None) -> str:
    text = HEADER if body is None else f"{HEADER}\n{body}"
    return f"{text}\n\n{user}" if user else text


def iso(minute: int) -> str:
    return f"2026-10-20T03:{minute:02d}:00.000Z"


def transcript_line(minute: int, text: str) -> str:
    entry = {
        "type": "message",
        "timestamp": iso(minute),
        "message": {"role": "user", "content": [{"type": "text", "text": text}]},
    }
    return json.dumps(entry)


TRANSCRIPT = [
    prompt("fix the bug", policy()),
    prompt("next"),
    prompt(""),  # image-only turn: header with no user text is still header-only
    prompt("go", policy(revision=2)),
    prompt("go", policy(revision=2, lessons=("- [a] rule a", "- [b] rule b"))),
    prompt("go", policy(revision=2, lessons=("- [a] rule a", "- [b] rule b"), pending=3)),
    prompt("go", policy(ticket="T-2", lessons=("- [a] rule a", "- [b] rule b"), pending=3)),
    prompt("go", policy(ticket="T-2", lessons=("- [a] rule a", "- [b] rule b"), pending=3)),
    "You are lane OMP-1. Lanes: OMP-1.\nAttention triage: legacy prompt\n\nold ask",
    "Unrelated user message without a lane header",
]


def write_transcript(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [json.dumps({"type": "session", "id": "S1"})]
    lines += [transcript_line(minute, text) for minute, text in enumerate(TRANSCRIPT)]
    lines.append(json.dumps({"type": "message", "message": {"role": "assistant", "content": "user"}}))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def epoch_ms(day: int, hour: int) -> int:
    return int(datetime(2026, 10, day, hour, tzinfo=timezone.utc).timestamp() * 1000)


class PromptClassificationTests(unittest.TestCase):
    def test_policy_sends_and_resend_reasons(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "-proj" / "2026-10-20T03-00-00-000Z_S1.jsonl"
            write_transcript(path)
            prompts = matrix.read_omp_prompts(path)

        self.assertEqual(
            [p.kind for p in prompts],
            ["first", "header", "header", "resend", "resend", "resend", "resend", "resend", "legacy"],
        )
        self.assertEqual(
            [p.reason for p in prompts if p.kind == "resend"],
            ["ticket-meta", "lessons", "timeline", "ticket", "refresh"],
        )
        first = prompts[0]
        self.assertEqual(first.user, len("fix the bug"))
        self.assertEqual(first.prefix, len(f"{HEADER}\n{policy()}"))
        self.assertEqual((prompts[2].prefix, prompts[2].user), (len(HEADER), 0))

    def test_directive_block_belongs_to_the_prefix(self) -> None:
        body = f"{policy()}\n\n## Directive: Review\nLine one\n\nLine two"
        prefix, user, approximate = matrix.split_prompt(prompt("user ask", body))
        self.assertEqual(user, "user ask")
        self.assertTrue(approximate)
        self.assertEqual(matrix.policy_sections(prefix)["role"], "## Directive: Review\nLine one\n\nLine two")

        _, user, approximate = matrix.split_prompt(prompt("## Directive is just user text"))
        self.assertEqual(user, "## Directive is just user text")
        self.assertFalse(approximate)

    def test_spec_332_header_lines_are_not_policy(self) -> None:
        header = (
            f"{HEADER}\n"
            "Ticket state: done · context r2 · 0 resources — re-read ticket.md when the revision changes.\n"
            "Timeline legacy pending: 3. In this working turn read timeline_list { pending: true }.\n"
            "Lessons update (replaces the matching entries in your Lessons list):\n"
            "- [b] rule b\n"
            "- [a] retired"
        )
        prefix, user, approximate = matrix.split_prompt(f"{header}\n\nnext")
        self.assertEqual((prefix, user, approximate), (header, "next", False))
        self.assertEqual(matrix.policy_sections(prefix), {})
        # The lessons block inside a policy is still policy.
        self.assertIn("lessons", matrix.policy_sections(f"{HEADER}\n{policy()}"))


class SessionMatrixTests(unittest.TestCase):
    def build(self, root: Path, **filters: list[str]) -> list:
        return matrix.build_sessions(
            root / "project",
            epoch_ms(19, 0),
            filters.get("lanes", []),
            filters.get("backends", []),
            root / "omp",
        )

    def write_fixture(self, root: Path) -> None:
        usage = root / "project" / ".krypton" / "usage"
        usage.mkdir(parents=True)
        rows = {
            "2026-10-01": [
                {"at": epoch_ms(1, 9), "lane": "OMP-1", "backend": "omp", "sessionId": "S1", "harnessId": "h"},
            ],
            "2026-10-20": [
                {
                    "at": epoch_ms(20, 4), "durationMs": 60_000, "lane": "OMP-1", "backend": "omp",
                    "sessionId": "S1", "harnessId": "h", "model": "anthropic/claude-opus-5-5",
                    "stopReason": "end_turn", "tokens": {"input": 100, "output": 50, "cachedRead": 900},
                    "context": {"used": 40_000, "size": 200_000},
                },
                {
                    "at": epoch_ms(20, 5), "durationMs": 120_000, "lane": "OMP-1", "backend": "omp",
                    "sessionId": "S1", "harnessId": "h", "stopReason": "cancelled", "tokens": None,
                    "context": {"used": 30_000, "size": 200_000},
                },
                {
                    "at": epoch_ms(20, 6), "durationMs": 1_000, "lane": "Claude-<x>", "backend": "claude",
                    "sessionId": "C1", "harnessId": "h", "stopReason": "end_turn", "tokens": None,
                },
            ],
        }
        for day, entries in rows.items():
            text = "\n".join(json.dumps(entry) for entry in entries) + "\nnot json\n"
            (usage / f"{day}.jsonl").write_text(text, encoding="utf-8")
        write_transcript(root / "omp" / "-proj" / "2026-10-20T03-00-00-000Z_S1.jsonl")

    def test_usage_rows_join_omp_transcript_within_window(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.write_fixture(root)
            sessions = {session.key: session for session in self.build(root)}

        self.assertEqual(set(sessions), {"S1", "C1"})
        omp = sessions["S1"]
        self.assertEqual((omp.turns, omp.cancelled, omp.wall_ms, omp.context_peak), (2, 1, 180_000, 40_000))
        self.assertAlmostEqual(omp.cache_rate, 0.9)
        self.assertEqual((omp.prefix.first, omp.prefix.resends, omp.prefix.header_only, omp.prefix.legacy), (1, 5, 2, 1))
        cells = matrix.session_cells(omp)
        self.assertEqual(cells[3], "claude-opus-5-5")
        self.assertEqual(cells[-3:], ["6", "5", "ticket-meta×1 lessons×1 timeline×1 ticket×1 refresh×1"])

        claude = sessions["C1"]
        self.assertIsNone(claude.prefix)
        self.assertEqual(matrix.session_cells(claude)[6:9], ["-", "-", "-"])

    def test_lane_and_backend_filters(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.write_fixture(root)
            self.assertEqual([s.key for s in self.build(root, lanes=["omp-*"])], ["S1"])
            self.assertEqual([s.key for s in self.build(root, backends=["claude"])], ["C1"])
            self.assertEqual(self.build(root, lanes=["omp-2"]), [])

    def test_html_escapes_lane_names(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.write_fixture(root)
            page = matrix.render_html(root, "since 2026-10-19", self.build(root), datetime(2026, 10, 20))
        self.assertIn("Claude-&lt;x&gt;", page)
        self.assertNotIn("Claude-<x>", page)


class CliTests(unittest.TestCase):
    def test_since_forms(self) -> None:
        now = datetime(2026, 10, 25, 15, 30)
        self.assertEqual(matrix.parse_since("all", now), (None, "all time"))
        self.assertEqual(matrix.parse_since("1d", now)[1], "since 2026-10-25")
        self.assertEqual(matrix.parse_since("7d", now)[1], "since 2026-10-19")
        self.assertEqual(matrix.parse_since("2026-10-01", now)[1], "since 2026-10-01")
        for bad in ("0d", "yesterday", "2026-13-01"):
            with self.assertRaises(ValueError):
                matrix.parse_since(bad, now)

    def test_missing_usage_log_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            self.assertEqual(matrix.main(["--project", temporary]), 1)


if __name__ == "__main__":
    unittest.main()
