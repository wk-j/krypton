#!/usr/bin/env python3
"""Per-session matrix of Krypton harness lanes, built on request from local logs.

Sources (read-only):
  <project>/.krypton/usage/<date>.jsonl      one row per completed turn, every backend (spec 214)
  ~/.omp/agent/sessions/*/<time>_<id>.jsonl  OMP transcripts, read for OMP lanes only to measure
                                             the prefix Krypton prepends to each prompt (spec 289)

A session appears when it completed at least one turn in the window. Prefix columns exist only
for OMP lanes; the OMP transcript format belongs to OMP, so a new OMP release can break them.
"""

import argparse
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta
import fnmatch
import html
import json
from pathlib import Path
import re
import sys


# Turn-header lines (specs 289 and 332); everything else in the prefix is lane policy.
HEADER_PREFIXES = (
    "You are lane ",
    "Krypton tools (if not visible",
    "Ticket state:",
    "Timeline legacy pending:",
    "Telegram provenance",
)
# Spec 332 header block: this heading plus one `- [slug] …` line per changed lesson.
LESSONS_UPDATE = "Lessons update ("
ROLE_HEADING = re.compile(r"## (Directive\b|Polly |Debby |Salty )")
TIMELINE_LINES = (
    "- Timeline ownership",
    "- Respect explicit read-only",
    "- Automatic recording",
    "- Legacy pending",
    "- After a record",
    "- timeline_",
)
SECTIONS = (
    "ticket", "peers", "memory-off", "tools", "timeline", "computers", "lessons", "figures", "role", "other",
)
TICKET_ID = re.compile(r"Active local ticket: (\S+)")
STRIP_SESSIONS = 12


# ── prompt prefix parsing ────────────────────────────────────────────────────


def policy_lines(prefix: str) -> list[str]:
    """The prefix without its turn-header lines."""
    lines: list[str] = []
    in_update = False
    for line in prefix.split("\n"):
        if line.startswith(LESSONS_UPDATE):
            in_update = True
            continue
        if in_update and line.startswith("- ["):
            continue
        in_update = False
        if not line.startswith(HEADER_PREFIXES):
            lines.append(line)
    return lines


def has_policy(prefix: str) -> bool:
    return any(policy_lines(prefix))


def split_prompt(text: str) -> tuple[str, str, bool]:
    """Split a lane prompt into (Krypton prefix, user text, approximate).

    OMP joins a prompt's text blocks with a blank line and the prefix itself contains none,
    so the first blank line ends it. A directive/role block is the exception: it follows a
    blank line inside the prefix and may hold blank lines of its own, so it is taken to end
    at the last blank line, which is approximate when the user text has blank lines too.
    """
    cut = text.find("\n\n")
    if cut < 0:
        return text, "", False
    prefix, rest = text[:cut], text[cut + 2 :]
    if not (ROLE_HEADING.match(rest) and has_policy(prefix)):
        return prefix, rest, False
    last = rest.rfind("\n\n")
    if last < 0:
        return text, "", True
    return text[: cut + 2 + last], rest[last + 2 :], True


def policy_sections(prefix: str) -> dict[str, str]:
    """Policy text by section; empty for a header-only prefix. Header lines are excluded."""
    sections: dict[str, list[str]] = {}
    current = "other"
    for line in policy_lines(prefix):
        if current == "role":
            sections["role"].append(line)
            continue
        if not line:
            continue
        if ROLE_HEADING.match(line):
            current = "role"
        elif line.startswith("Active local ticket"):
            current = "ticket"
        elif line.startswith(("Lanes:", "Inter-lane peering")):
            current = "peers"
        elif line.startswith("Shared Krypton memory is unavailable"):
            current = "memory-off"
        elif line.startswith("Krypton tools — each tool"):
            current = "tools"
        elif current in ("tools", "timeline") and line.startswith(TIMELINE_LINES):
            current = "timeline"
        elif current == "timeline" and line.startswith("- "):
            current = "tools"
        elif line.startswith("Write these tools"):
            current = "tools"
        elif line.startswith("Connected computers"):
            current = "computers"
        elif line.startswith("Lessons (global"):
            current = "lessons"
        elif line.startswith(("```svg", "```mermaid")):
            current = "figures"
        sections.setdefault(current, []).append(line)
    return {name: "\n".join(lines) for name, lines in sections.items()}


def ticket_id(section: str | None) -> str | None:
    match = TICKET_ID.match(section or "")
    return match.group(1) if match else None


def resend_reason(previous: dict[str, str], current: dict[str, str]) -> str:
    """Why the full policy went out again: the sections that changed since the last send.

    `refresh` means identical text (the 20-turn refresh, a detected compaction, or a lane
    respawn). `ticket-meta` means the same ticket with a changed status, revision or count.
    """
    if previous == current:
        return "refresh"
    changed = []
    for name in SECTIONS:
        before, after = previous.get(name), current.get(name)
        if before == after:
            continue
        same_ticket = name == "ticket" and ticket_id(before) is not None and ticket_id(before) == ticket_id(after)
        changed.append("ticket-meta" if same_ticket else name)
    return "+".join(changed)


@dataclass
class Prompt:
    at: int
    kind: str  # first | resend | header | legacy
    prefix: int
    user: int
    reason: str = ""
    approximate: bool = False


def message_text(content: object) -> str | None:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return None
    texts = [block.get("text", "") for block in content if isinstance(block, dict) and block.get("type") == "text"]
    return "\n\n".join(texts) if texts else None


def parse_timestamp(value: object) -> int | None:
    if not isinstance(value, str):
        return None
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def read_omp_prompts(path: Path) -> list[Prompt]:
    """Every Krypton lane prompt in one OMP transcript, classified against the previous policy."""
    prompts: list[Prompt] = []
    previous: dict[str, str] | None = None
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if '"user"' not in line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            message = entry.get("message") if isinstance(entry, dict) else None
            if not isinstance(message, dict) or message.get("role") != "user":
                continue
            text = message_text(message.get("content"))
            at = parse_timestamp(entry.get("timestamp"))
            if text is None or at is None or not text.startswith("You are lane "):
                continue
            if ". " in text.split("\n", 1)[0]:
                # Pre-spec-289 prompts put the roster on the first line and sent everything
                # every turn; their prefix cannot be split from the user text.
                prompts.append(Prompt(at, "legacy", 0, 0))
                continue
            prefix, user, approximate = split_prompt(text)
            sections = policy_sections(prefix)
            if not sections:
                kind, reason = "header", ""
            elif previous is None:
                kind, reason = "first", ""
            else:
                kind, reason = "resend", resend_reason(previous, sections)
            if sections:
                previous = sections
            prompts.append(Prompt(at, kind, len(prefix), len(user), reason, approximate))
    return prompts


def omp_index(root: Path) -> dict[str, Path]:
    index: dict[str, Path] = {}
    for path in root.glob("*/*.jsonl"):
        _, separator, session_id = path.stem.partition("_")
        if separator:
            index[session_id] = path
    return index


# ── aggregation ──────────────────────────────────────────────────────────────


@dataclass
class PrefixTotals:
    prompts: int = 0
    header_only: int = 0
    first: int = 0
    resends: int = 0
    legacy: int = 0
    approximate: int = 0
    first_chars: int = 0
    resend_chars: int = 0
    header_chars: int = 0
    user_chars: int = 0
    reasons: Counter = field(default_factory=Counter)
    reason_chars: Counter = field(default_factory=Counter)

    def add(self, prompt: Prompt) -> None:
        self.prompts += 1
        self.approximate += prompt.approximate
        if prompt.kind == "legacy":
            self.legacy += 1
            return
        self.user_chars += prompt.user
        if prompt.kind == "header":
            self.header_only += 1
            self.header_chars += prompt.prefix
        elif prompt.kind == "first":
            self.first += 1
            self.first_chars += prompt.prefix
        else:
            self.resends += 1
            self.resend_chars += prompt.prefix
            self.reasons[prompt.reason] += 1
            self.reason_chars[prompt.reason] += prompt.prefix

    @property
    def krypton_chars(self) -> int:
        return self.first_chars + self.resend_chars + self.header_chars

    @property
    def share(self) -> float | None:
        total = self.krypton_chars + self.user_chars
        return self.krypton_chars / total if total else None


@dataclass
class Session:
    key: str
    session_id: str | None
    lane: str
    backend: str
    model: str | None = None
    turns: int = 0
    started: int | None = None
    wall_ms: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    cache_read: int = 0
    cache_write: int = 0
    token_turns: int = 0
    context_peak: int | None = None
    context_size: int | None = None
    cancelled: int = 0
    transcript: Path | None = None
    prompts: list[Prompt] = field(default_factory=list)
    # Set with the transcript; None for non-OMP lanes and OMP lanes without a transcript.
    prefix: PrefixTotals | None = None

    def add(self, row: dict) -> None:
        self.turns += 1
        at = int(row["at"])
        duration = row.get("durationMs")
        duration = int(duration) if isinstance(duration, (int, float)) and duration > 0 else 0
        self.wall_ms += duration
        start = at - duration
        self.started = start if self.started is None else min(self.started, start)
        if row.get("model"):
            self.model = str(row["model"])
        if row.get("stopReason") == "cancelled":
            self.cancelled += 1
        tokens = row.get("tokens")
        if isinstance(tokens, dict):
            self.token_turns += 1
            self.tokens_in += int(tokens.get("input") or 0)
            self.tokens_out += int(tokens.get("output") or 0)
            self.cache_read += int(tokens.get("cachedRead") or 0)
            self.cache_write += int(tokens.get("cachedWrite") or 0)
        context = row.get("context")
        if isinstance(context, dict):
            used, size = context.get("used"), context.get("size")
            if isinstance(used, (int, float)):
                self.context_peak = int(max(self.context_peak or 0, used))
            if isinstance(size, (int, float)):
                self.context_size = int(max(self.context_size or 0, size))

    @property
    def cache_rate(self) -> float | None:
        return cache_rate(self.tokens_in, self.cache_read, self.cache_write)


def cache_rate(tokens_in: int, cache_read: int, cache_write: int) -> float | None:
    """Same arithmetic as the harness: cachedRead / (input + cachedRead + cachedWrite)."""
    if cache_read <= 0 and cache_write <= 0:
        return None
    denominator = tokens_in + cache_read + cache_write
    return cache_read / denominator if denominator else None


def matches(value: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatchcase(value.lower(), pattern) for pattern in patterns)


def load_usage(usage_dir: Path, since_ms: int | None) -> list[dict]:
    floor = None
    if since_ms is not None:
        # File names are dates; a day of margin keeps a turn whose file date differs by time zone.
        floor = (datetime.fromtimestamp(since_ms / 1000) - timedelta(days=1)).strftime("%Y-%m-%d")
    rows = []
    for path in sorted(usage_dir.glob("*.jsonl")):
        if floor is not None and path.stem < floor:
            continue
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(row, dict) or not isinstance(row.get("at"), (int, float)):
                    continue
                if since_ms is None or row["at"] >= since_ms:
                    rows.append(row)
    return rows


def build_sessions(
    project: Path,
    since_ms: int | None,
    lanes: list[str],
    backends: list[str],
    omp_root: Path,
) -> list[Session]:
    sessions: dict[str, Session] = {}
    for row in load_usage(project / ".krypton" / "usage", since_ms):
        lane = str(row.get("lane") or "?")
        backend = str(row.get("backend") or "?")
        if lanes and not matches(lane, lanes):
            continue
        if backends and backend.lower() not in backends:
            continue
        session_id = row.get("sessionId") or None
        key = session_id or f"{row.get('harnessId')}/{lane}"
        if key not in sessions:
            sessions[key] = Session(key, session_id, lane, backend)
        sessions[key].add(row)
    omp = [session for session in sessions.values() if session.backend == "omp" and session.session_id]
    if omp:
        index = omp_index(omp_root)
        for session in omp:
            path = index.get(session.session_id)
            if path is None:
                continue
            session.transcript = path
            session.prompts = [p for p in read_omp_prompts(path) if since_ms is None or p.at >= since_ms]
            session.prefix = PrefixTotals()
            for prompt in session.prompts:
                session.prefix.add(prompt)
    return sorted(sessions.values(), key=lambda session: session.started or 0, reverse=True)


# ── formatting ───────────────────────────────────────────────────────────────


def compact(value: float | None) -> str:
    if value is None:
        return "-"
    for unit, size in (("M", 1_000_000), ("K", 1_000)):
        if abs(value) >= size:
            text = f"{value / size:.1f}"
            return (text[:-2] if text.endswith(".0") else text) + unit
    return f"{int(value)}"


def duration(ms: int) -> str:
    minutes = round(ms / 60_000)
    if minutes >= 60:
        return f"{minutes // 60}h{minutes % 60:02d}m"
    if minutes >= 1:
        return f"{minutes}m"
    return f"{round(ms / 1000)}s"


def percent(rate: float | None) -> str:
    return "-" if rate is None else f"{round(rate * 100)}%"


def stamp(ms: int | None) -> str:
    return "-" if ms is None else datetime.fromtimestamp(ms / 1000).strftime("%m-%d %H:%M")


def reasons_text(reasons: Counter) -> str:
    return " ".join(f"{reason}×{count}" for reason, count in reasons.most_common())


def tokens_text(value: int, measured_turns: int) -> str:
    """A counter no turn reported is unknown, not zero."""
    return compact(value) if measured_turns else "-"


def session_cells(session: Session) -> list[str]:
    prefix = session.prefix
    if prefix is None:
        injected = ["-"] * 4 if session.backend != "omp" else ["?"] * 4
    else:
        injected = [
            percent(prefix.share),
            str(prefix.first + prefix.resends),
            str(prefix.resends),
            reasons_text(prefix.reasons),
        ]
    return [
        stamp(session.started),
        session.lane,
        session.backend,
        (session.model or "-").rsplit("/", 1)[-1][:24],
        str(session.turns),
        duration(session.wall_ms),
        tokens_text(session.tokens_in, session.token_turns),
        tokens_text(session.tokens_out, session.token_turns),
        percent(session.cache_rate),
        compact(session.context_peak),
        str(session.cancelled) if session.cancelled else "",
        *injected,
    ]


MATRIX_HEADERS = [
    "started", "lane", "backend", "model", "turns", "wall", "in", "out", "cache", "ctx peak",
    "cancelled", "krypton", "policy", "resend", "resend reasons",
]
MATRIX_RIGHT = {4, 5, 6, 7, 8, 9, 10, 11, 12, 13}


def table(headers: list[str], rows: list[list[str]], right: set[int]) -> list[str]:
    widths = [max([len(header)] + [len(row[i]) for row in rows]) for i, header in enumerate(headers)]

    def line(cells: list[str]) -> str:
        return "  ".join(
            cell.rjust(width) if i in right else cell.ljust(width)
            for i, (cell, width) in enumerate(zip(cells, widths))
        ).rstrip()

    return [line(headers)] + [line(row) for row in rows]


@dataclass
class BackendTotals:
    sessions: int = 0
    turns: int = 0
    wall_ms: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    cache_read: int = 0
    cache_write: int = 0
    cancelled: int = 0
    token_turns: int = 0


def backend_totals(sessions: list[Session]) -> dict[str, BackendTotals]:
    totals: dict[str, BackendTotals] = {}
    for session in sessions:
        entry = totals.setdefault(session.backend, BackendTotals())
        entry.sessions += 1
        entry.turns += session.turns
        entry.wall_ms += session.wall_ms
        entry.tokens_in += session.tokens_in
        entry.tokens_out += session.tokens_out
        entry.cache_read += session.cache_read
        entry.cache_write += session.cache_write
        entry.cancelled += session.cancelled
        entry.token_turns += session.token_turns
    return dict(sorted(totals.items(), key=lambda item: -item[1].turns))


def prefix_totals(sessions: list[Session]) -> tuple[PrefixTotals, int, int]:
    """Totals over OMP sessions with a transcript, plus (sessions measured, transcripts missing)."""
    totals = PrefixTotals()
    measured = missing = 0
    for session in sessions:
        if session.backend != "omp":
            continue
        if session.transcript is None:
            missing += 1
            continue
        measured += 1
        for prompt in session.prompts:
            totals.add(prompt)
    return totals, measured, missing


def render_text(project: Path, window: str, sessions: list[Session]) -> str:
    turns = sum(session.turns for session in sessions)
    out = [f"Session matrix · {project} · {window} · {len(sessions)} sessions · {turns} turns", ""]
    if not sessions:
        out.append("No completed turns in this window.")
        return "\n".join(out)

    backend_rows = [
        [
            backend,
            str(entry.sessions),
            str(entry.turns),
            duration(entry.wall_ms),
            tokens_text(entry.tokens_in, entry.token_turns),
            tokens_text(entry.tokens_out, entry.token_turns),
            percent(cache_rate(entry.tokens_in, entry.cache_read, entry.cache_write)),
            str(entry.cancelled),
        ]
        for backend, entry in backend_totals(sessions).items()
    ]
    out += table(
        ["backend", "sessions", "turns", "wall", "in", "out", "cache", "cancelled"],
        backend_rows,
        {1, 2, 3, 4, 5, 6, 7},
    )

    totals, measured, missing = prefix_totals(sessions)
    if measured or missing:
        out.append("")
        note = f" ({missing} transcripts not found)" if missing else ""
        out.append(f"Krypton prefix · OMP lanes · {totals.prompts} prompts in {measured} sessions{note}")
        if totals.prompts:
            out.append(
                f"  {percent(totals.share)} of prompt text · policy {totals.first} first + {totals.resends} resends"
                f" · {totals.header_only} header-only · {compact(totals.krypton_chars)} chars"
                f" ({compact(totals.resend_chars)} in resends)"
            )
            if totals.reasons:
                out.append(f"  resend reasons: {reasons_text(totals.reasons)}")
            if totals.legacy or totals.approximate:
                out.append(f"  not split: {totals.legacy} legacy · approximate: {totals.approximate} with a directive")

    out.append("")
    out += table(MATRIX_HEADERS, [session_cells(session) for session in sessions], MATRIX_RIGHT)
    return "\n".join(out)


# ── HTML ─────────────────────────────────────────────────────────────────────

CSS = """
:root { --bg:#17191d; --fg:#eaecef; --muted:#707a8a; --border:#2f353d; --accent:#fcd535;
  --card:#21242a; --code-bg:#1d1f24; --add:#0ecb81; --del:#f6465d; color-scheme:dark;
  --sans:'BinanceNova','IBM Plex Sans',-apple-system,BlinkMacSystemFont,sans-serif;
  --mono:'BinancePlex','JetBrains Mono','SF Mono',Menlo,ui-monospace,monospace; }
@media (prefers-color-scheme: light) { :root { color-scheme:light; --bg:#fff; --fg:#181a20;
  --border:#eaecef; --accent:#f0b90b; --card:#fafafa; --code-bg:#f5f5f5; } }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 var(--sans); }
main { max-width:1400px; margin:0 auto; padding:18px 20px 48px; }
h1 { color:var(--accent); font-size:24px; margin:0 0 4px; }
h2 { font-size:17px; margin:34px 0 10px; }
.meta, .note, footer { color:var(--muted); font:12px var(--mono); }
.tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-top:16px; }
.tile { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:12px 13px; }
.tile b { display:block; color:var(--accent); font:600 22px var(--mono); font-variant-numeric:tabular-nums; }
.tile.bad b { color:var(--del); }
.tile span { color:var(--muted); font-size:12px; }
table { border-collapse:collapse; width:100%; font-size:13px; }
th, td { border:1px solid var(--border); padding:4px 8px; text-align:left; white-space:nowrap; }
th { color:var(--accent); font:500 12px var(--mono); }
td.n { text-align:right; font-family:var(--mono); font-variant-numeric:tabular-nums; }
td.bad { color:var(--del); }
td.dim { color:var(--muted); }
.wrap { overflow-x:auto; }
.bar { display:flex; height:30px; border:1px solid var(--border); border-radius:6px; overflow:hidden; background:var(--code-bg); }
.bar i { display:block; min-width:2px; background:var(--c); }
.legend { display:flex; flex-wrap:wrap; gap:6px 18px; margin-top:8px; color:var(--muted); font:12px var(--mono); }
.legend span::before { content:''; display:inline-block; width:10px; height:10px; border-radius:2px;
  margin-right:6px; vertical-align:-1px; background:var(--c); }
.c-first { --c:color-mix(in srgb,var(--accent) 55%,var(--bg)); }
.c-resend { --c:var(--del); }
.c-header { --c:color-mix(in srgb,var(--muted) 45%,var(--bg)); }
.c-user { --c:var(--fg); }
.c-legacy { --c:color-mix(in srgb,var(--muted) 20%,var(--bg)); }
.share { display:inline-block; width:46px; height:6px; margin-left:6px; border-radius:3px;
  background:var(--code-bg); vertical-align:1px; overflow:hidden; }
.share i { display:block; height:100%; background:var(--accent); }
.strip-card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:10px 13px; margin-top:10px; }
.strip-card p { margin:0 0 6px; font:12px var(--mono); color:var(--muted); }
.strip-card p b { color:var(--fg); font-weight:500; }
.strip { display:flex; align-items:flex-end; gap:2px; height:64px; border-bottom:1px solid var(--border); }
.strip i { flex:1 1 0; min-width:3px; max-width:22px; border-radius:2px 2px 0 0; background:var(--c); }
.empty { color:var(--muted); font:13px var(--mono); padding:18px 0; }
footer { margin-top:36px; border-top:1px solid var(--border); padding-top:10px; line-height:1.7; }
"""


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def tile(value: str, label: str, bad: bool = False) -> str:
    return f'<div class="tile{" bad" if bad else ""}"><b>{esc(value)}</b><span>{esc(label)}</span></div>'


def segment(css: str, part: int, whole: int, label: str) -> str:
    if part <= 0 or whole <= 0:
        return ""
    return f'<i class="{css}" style="width:{100 * part / whole:.2f}%" title="{esc(label)}"></i>'


def prompt_strip(session: Session) -> str:
    tallest = max((prompt.prefix for prompt in session.prompts), default=0) or 1
    cells = []
    for prompt in session.prompts:
        height = max(4.0, 100 * prompt.prefix / tallest)
        detail = prompt.kind + (f" · {prompt.reason}" if prompt.reason else "")
        title = f"{stamp(prompt.at)} · {detail} · {prompt.prefix:,} chars"
        cells.append(f'<i class="c-{prompt.kind}" style="height:{height:.1f}%" title="{esc(title)}"></i>')
    return "".join(cells)


def render_html(project: Path, window: str, sessions: list[Session], generated: datetime) -> str:
    turns = sum(session.turns for session in sessions)
    wall = sum(session.wall_ms for session in sessions)
    tokens_in = sum(session.tokens_in for session in sessions)
    tokens_out = sum(session.tokens_out for session in sessions)
    token_turns = sum(session.token_turns for session in sessions)
    rate = cache_rate(
        tokens_in, sum(s.cache_read for s in sessions), sum(s.cache_write for s in sessions)
    )
    totals, measured, missing = prefix_totals(sessions)

    parts = [
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">",
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
        f"<title>Session matrix · {esc(project.name)}</title><style>{CSS}</style></head><body><main>",
        "<h1>Session matrix</h1>",
        f'<div class="meta">{esc(project)} · {esc(window)} · generated {generated:%Y-%m-%d %H:%M}</div>',
        '<div class="tiles">',
        tile(str(len(sessions)), "sessions"),
        tile(str(turns), "completed turns"),
        tile(duration(wall), "lane wall-clock"),
        tile(f"{tokens_text(tokens_in, token_turns)} / {tokens_text(tokens_out, token_turns)}", "tokens in / out"),
        tile(percent(rate), "cache hit"),
    ]
    if totals.prompts:
        parts += [
            tile(percent(totals.share), "of OMP prompt text is Krypton prefix"),
            tile(str(totals.resends), "full policy resends (OMP)", bad=totals.resends > 0),
        ]
    parts.append("</div>")

    if not sessions:
        parts.append('<p class="empty">No completed turns in this window.</p>')
    else:
        parts.append("<h2>By backend</h2><div class=\"wrap\"><table><tr>")
        parts += [f"<th>{name}</th>" for name in ("backend", "sessions", "turns", "wall", "in", "out", "cache", "cancelled")]
        parts.append("</tr>")
        for backend, entry in backend_totals(sessions).items():
            cells = [
                str(entry.sessions), str(entry.turns), duration(entry.wall_ms),
                tokens_text(entry.tokens_in, entry.token_turns), tokens_text(entry.tokens_out, entry.token_turns),
                percent(cache_rate(entry.tokens_in, entry.cache_read, entry.cache_write)),
                str(entry.cancelled),
            ]
            parts.append(f"<tr><td>{esc(backend)}</td>" + "".join(f'<td class="n">{esc(c)}</td>' for c in cells) + "</tr>")
        parts.append("</table></div>")

    if measured or missing:
        parts.append("<h2>Krypton prefix · OMP lanes</h2>")
        note = f" · {missing} transcripts not found" if missing else ""
        parts.append(f'<p class="note">{totals.prompts} prompts in {measured} sessions{esc(note)}</p>')
        whole = totals.krypton_chars + totals.user_chars
        if whole:
            parts += [
                '<div class="bar">',
                segment("c-first", totals.first_chars, whole, f"first policy send {totals.first_chars:,}"),
                segment("c-resend", totals.resend_chars, whole, f"policy resends {totals.resend_chars:,}"),
                segment("c-header", totals.header_chars, whole, f"header-only {totals.header_chars:,}"),
                segment("c-user", totals.user_chars, whole, f"user text {totals.user_chars:,}"),
                "</div><div class=\"legend\">",
                f'<span class="c-first">first policy · {totals.first} · {compact(totals.first_chars)} chars</span>',
                f'<span class="c-resend">resends · {totals.resends} · {compact(totals.resend_chars)} chars</span>',
                f'<span class="c-header">header-only · {totals.header_only} · {compact(totals.header_chars)} chars</span>',
                f'<span class="c-user">user text · {compact(totals.user_chars)} chars</span>',
                "</div>",
            ]
        if totals.reasons:
            parts.append('<h2>Why the policy was resent</h2><div class="wrap"><table><tr><th>changed sections</th><th>resends</th><th>chars</th></tr>')
            for reason, count in totals.reasons.most_common():
                parts.append(
                    f"<tr><td>{esc(reason)}</td><td class=\"n\">{count}</td>"
                    f"<td class=\"n\">{totals.reason_chars[reason]:,}</td></tr>"
                )
            parts.append(
                "</table></div><p class=\"note\">refresh = identical text (20-turn refresh, compaction or respawn) ·"
                " ticket-meta = same ticket, changed status / context revision / resource count</p>"
            )

    if sessions:
        parts.append("<h2>Sessions</h2><div class=\"wrap\"><table><tr>")
        parts += [f"<th>{esc(name)}</th>" for name in MATRIX_HEADERS]
        parts.append("</tr>")
        for session in sessions:
            cells = session_cells(session)
            prefix = session.prefix
            row = []
            for i, cell in enumerate(cells):
                css = "n" if i in MATRIX_RIGHT else ""
                content = esc(cell)
                if i == 11 and prefix is not None and prefix.share is not None:
                    content += f'<span class="share"><i style="width:{100 * prefix.share:.0f}%"></i></span>'
                if i == 13 and prefix is not None and prefix.resends:
                    css += " bad"
                if cell in ("-", "?"):
                    css += " dim"
                row.append(f'<td class="{css.strip()}">{content}</td>' if css.strip() else f"<td>{content}</td>")
            parts.append("<tr>" + "".join(row) + "</tr>")
        parts.append("</table></div>")

    resent = [s for s in sessions if s.prefix is not None and s.prefix.resends]
    resent.sort(key=lambda s: s.prefix.resend_chars, reverse=True)
    if resent:
        parts.append("<h2>Prompt prefixes in the sessions with the most resent text</h2>")
        parts.append(
            '<div class="legend"><span class="c-first">first policy</span><span class="c-resend">resend</span>'
            '<span class="c-header">header-only</span><span class="c-legacy">legacy</span></div>'
        )
        for session in resent[:STRIP_SESSIONS]:
            prefix = session.prefix
            parts.append(
                f'<div class="strip-card"><p><b>{esc(session.lane)}</b> · {esc(stamp(session.started))} · '
                f"{prefix.prompts} prompts · {prefix.resends} resends · {prefix.resend_chars:,} chars resent · "
                f"{esc(session.session_id or '')}</p><div class=\"strip\">{prompt_strip(session)}</div></div>"
            )

    parts.append(
        "<footer>Sources: .krypton/usage/*.jsonl (every backend) · ~/.omp/agent/sessions (OMP prefix only).<br>"
        "A session appears when it completed a turn in the window; wall-clock includes time waiting on the human.<br>"
        "Cache hit = cachedRead / (input + cachedRead + cachedWrite), as in the harness."
    )
    if totals.legacy or totals.approximate:
        parts.append(
            f"<br>Not split: {totals.legacy} pre-spec-289 prompts · approximate: {totals.approximate} prompts with a directive block."
        )
    parts.append("</footer></main></body></html>")
    return "\n".join(part for part in parts if part)


# ── CLI ──────────────────────────────────────────────────────────────────────


def parse_since(value: str, now: datetime) -> tuple[int | None, str]:
    if value == "all":
        return None, "all time"
    match = re.fullmatch(r"(\d+)d", value)
    if match:
        days = int(match.group(1))
        if days < 1:
            raise ValueError("--since Nd needs N >= 1")
        start = (now - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0, microsecond=0)
    else:
        try:
            start = datetime.strptime(value, "%Y-%m-%d")
        except ValueError:
            raise ValueError(f"--since must be YYYY-MM-DD, Nd or all, not {value!r}") from None
    return int(start.timestamp() * 1000), f"since {start:%Y-%m-%d}"


def split_list(value: str | None) -> list[str]:
    return [item.strip().lower() for item in (value or "").split(",") if item.strip()]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Per-session matrix of Krypton harness lanes from .krypton/usage and OMP transcripts.",
    )
    parser.add_argument("--project", type=Path, default=Path.cwd(), help="project root holding .krypton/usage (default: cwd)")
    parser.add_argument(
        "--since",
        default="7d",
        help="YYYY-MM-DD, Nd (today and the N-1 days before it) or all (default: 7d)",
    )
    parser.add_argument("--lane", help="lane names, comma-separated; globs allowed (e.g. 'OMP-*')")
    parser.add_argument("--backend", help="backend ids, comma-separated (e.g. omp,claude)")
    parser.add_argument("--html", type=Path, metavar="PATH", help="also write the matrix as an HTML page")
    args = parser.parse_args(argv)

    now = datetime.now()
    try:
        since_ms, window = parse_since(args.since, now)
    except ValueError as error:
        parser.error(str(error))
    project = args.project.expanduser().resolve()
    usage_dir = project / ".krypton" / "usage"
    if not usage_dir.is_dir():
        print(f"session-matrix: no usage log at {usage_dir}", file=sys.stderr)
        return 1

    sessions = build_sessions(
        project,
        since_ms,
        split_list(args.lane),
        split_list(args.backend),
        Path.home() / ".omp" / "agent" / "sessions",
    )
    print(render_text(project, window, sessions))
    if args.html is not None:
        target = args.html.expanduser()
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(render_html(project, window, sessions, now), encoding="utf-8")
        print(f"\nwrote {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
