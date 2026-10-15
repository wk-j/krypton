#!/usr/bin/env python3
"""Render the static component previews embedded by docs/0302.

Run from anywhere: python3 docs/images/harness-components/render.py
The drawings are design examples, not screenshots of the live application.
"""

from __future__ import annotations

from dataclasses import dataclass
from html import escape
from pathlib import Path


@dataclass(frozen=True)
class Preview:
    number: str
    name: str
    kind: str
    lines: tuple[str, ...]
    live: bool = False


PREVIEWS = (
    Preview('0.1', 'LayoutHost', 'layout', ('lane.head  /  lane.understats', 'transcript · pinned', 'rail.top  plan · peek · thought', 'rail.bottom  queue')),
    Preview('0.1', 'Slot', 'layout', ('rail.top', '10  plan', '20  peek', '30  thought')),
    Preview('1.1', 'Chip', 'chips', ('Code', 'polly-bypass', 'mcp ✓ 14', '12.4% 843M')),
    Preview('1.2', 'Spinner', 'spinner', ('busy  ⠋', 'sealed  ✓', 'failed  ✗'), True),
    Preview('1.3', 'Meter', 'meter', ('CPU  12.4%', 'CACHE HIT  93%', 'DEEP  ▰▰▰▱▱')),
    Preview('1.4', 'StatRow', 'stats', ('Session', '4f2a9c', 'Cost', '$0.4412 USD')),
    Preview('1.4', 'StatList', 'stats', ('Turns  14', 'Input  182.0k', 'Output  12.4k', 'Cost  $0.44')),
    Preview('1.5', 'EmptyState', 'empty', ('NO ACP LANES', 'Start a lane to see its transcript.')),
    Preview('1.6', 'ActionButton', 'actions', ('⌘1  Analyze', '⌘2  Post comment', '⌘3  Fix here')),
    Preview('1.7', 'KeyHintBar', 'hints', ('h / l  switch lane', 'j / k  select round', 'esc  close')),
    Preview('1.8', 'TabStrip', 'tabs', ('codex-1 · 4', 'grok-1 · 2', 'review priority')),
    Preview('1.9', 'Caret', 'caret', ('convert the UI into reusable components', '█')),
    Preview('2.1', 'Card', 'card', ('◫  Render path comparison', '184.2 KB · a91f3c2', 'press f to open in browser')),
    Preview('2.2', 'OverlayShell', 'overlay', ('Review quality matrix', 'this session · in memory', 'codex-1 · 4    grok-1 · 2')),
    Preview('2.3', 'ListPicker', 'picker', ('Claude Code       · 2 running', 'Codex', 'Oh My Pi         · 1 running')),
    Preview('2.4', 'InlinePalette', 'palette', ('/resume   <session>', '/compact', '/review    fan out to reviewer lanes')),
    Preview('2.5', 'DiffBlock', 'diff', ('12   const next = renderTranscriptItem(item)', '-    current.replaceWith(next);', '+    current.replaceChildren(...next.childNodes);')),
    Preview('3.0', 'TranscriptRow', 'row', ('agent', 'A sealed transcript row keeps its node.', 'REFERENCES  src/acp/list.ts')),
    Preview('3.1', 'AssistantRow', 'row', ('agent  ▰▰▰▱▱', 'The reconciler keeps node identity.', 'REFERENCES  src/acp/list.ts · main@a91f3c2'), True),
    Preview('3.2', 'ThoughtRow', 'row', ('thought  ▰▰▰▰▱  extended', 'Considering the tail window…'), True),
    Preview('3.3', 'UserRow', 'row', ('user', 'Refactor the harness view.', 'steer… also check the scroll anchor'), True),
    Preview('3.4', 'ToolRow', 'tool', ('execute  npm run check', 'exit 0', '> tsc --noEmit'), True),
    Preview('3.5', 'SubagentCard', 'subagent', ('● scout-1  explore', 'reading src/acp/lane-peek.ts', '14 tools · 8k tok · 42s'), True),
    Preview('3.6', 'PermissionRow', 'permission', ('Bash  git push origin main', 'a accept   A all   r reject   R all')),
    Preview('3.7', 'QuestionRow', 'question', ('Which reconciler should phase 3 use?', '1  keyed reconcile', '2  morph against a fresh tree')),
    Preview('3.8', 'FsActivityRow', 'row', ('fs  read', 'src/acp/list.ts', 'completed')),
    Preview('3.9', 'FsWriteReviewRow', 'diff', ('write  src/ui/list.ts   +18 −0', '+    reconcile(container, items, spec)', '[ apply ]     [ reject ]')),
    Preview('3.10', 'ProviderErrorRow', 'error', ('rate_limited · 429', 'Retry in 32s', 'Provider request paused')),
    Preview('3.11', 'InterLaneRow', 'row', ('mail ←  codex-1', 'Please check the ToolRow deps tuple.', 'mail →  grok-1  done')),
    Preview('3.12', 'DocCardRow', 'card', ('▤  Review Board — spec 301', '3 reviewers · 1 blocker · 4 warnings', 'press g to open in browser')),
    Preview('3.13', 'UsageRow', 'usage', ('2026-10-15       14 turns', 'Cache hit 93%', 'sonnet-4-5  182.0k / 12.4k  ·  $0.44')),
    Preview('3.14', 'SystemRow', 'row', ('sys', 'Lane restarted — session 4f2a9c', 'reviewer-1 finished round 2')),
    Preview('3.14', 'HiddenRowsIndicator', 'row', ('sys', '↑ 142 earlier rows hidden', 'Ctrl+H  show 60 more')),
    Preview('3.15', 'ImageStrip', 'images', ('3 images', 'screenshot.png', 'diagram.png')),
    Preview('3.16', 'ResourceRail', 'resource', ('REFERENCES  2', 'docs/0301-harness-ui-components.md', 'src/ui/list.ts')),
    Preview('3.17', 'Transcript', 'transcript', ('user    Refactor the component kernel.', 'agent   I will preserve sealed rows.', 'tool    ✓  npm run check')),
    Preview('4.1', 'LaneShell', 'lane', ('claude-1   busy   sonnet-4-6', 'sess 4f2a9c · 128.4k/200.0k', 'agent   transcript body · pinned')),
    Preview('4.2', 'LaneHead', 'lane', ('⠙  claude-1  busy', 'sonnet-4-6   mcp ✓ 14', '12.4% 843M')),
    Preview('4.3', 'LaneSymbol', 'spinner', ('busy  ⠋', 'permission  !', 'idle  ○'), True),
    Preview('4.4', 'LaneStats', 'stats', ('sess 4f2a9c', 'cache 93%', 'cost $0.4412', 'tools 37')),
    Preview('4.5', 'RailEntry', 'rail', ('●  claude-1    ⇆ 37', 'impl  harness UI refactor', '128.4k tokens')),
    Preview('4.6', 'LaneRail', 'rail', ('●  claude-1   busy', '○  codex-1    idle', '●  grok-1     review')),
    Preview('5.1', 'PeekCard', 'panel', ('codex-1   awaiting peer · 5m+', '▸ approve Bash', 'tool  Edit · lane-peek.ts')),
    Preview('5.2', 'ReviewLoopRows', 'panel', ('review   pass 2/4 · reviewing', 'replies  codex PASS · salty pending', 'rounds   3 → 0')),
    Preview('5.3', 'HeatPanel', 'meter', ('TOOLS  5m', 'active  0.62', 'peek  ███░░░░░')),
    Preview('5.4', 'ThoughtCard', 'panel', ('claude-1   thinking', 'The tail window can slide', 'past a live row…'), True),
    Preview('5.5', 'QueueCard', 'panel', ('⏎ queue (3) · held behind lane mail', '1  rerun the type check', '2  open the model picker')),
    Preview('5.6', 'PlanPanel', 'panel', ('plan  4/9', '✓ extract kernel', '▸ wire composer meta segments')),
    Preview('5.7', 'TicketDock', 'panel', ('active ticket', 'Harness UI refactor  ›', 'KR-301 · open · codex-1')),
    Preview('5.8', 'AnnotationRail', 'panel', ('ANNOTATED  3 · 2 unsent', 'deps tuple needs the lane arg', '[ send 2 ]     [ del ]')),
    Preview('6.1', 'Composer', 'composer', ('claude-1  ⠋', 'Convert the UI into reusable components█', 'reviewing · 2:14 · 3 queued')),
    Preview('6.2', 'ComposerMeta', 'stats', ('reviewing  2:14', '3 queued', 'auto-edit ⇧⇥', '⎇ main')),
    Preview('6.3', 'DraftLine', 'caret', ('convert the UI into reusable components', '█')),
    Preview('6.4', 'StagingStrip', 'images', ('2 images · Esc to clear', 'screenshot.png', 'diagram.png')),
    Preview('6.5', 'PeerStrip', 'panel', ('⇆ awaiting codex · 5m+', '#cancel drops pending lane-mail wait', '▼ 3 lane mails queued')),
    Preview('6.6', 'DictationControl', 'voice', ('● REC th   ⌘D', 'MIC · FINALIZING…')),
    Preview('6.7', 'LiveVoiceStrip', 'voice', ('LIVE   listening   alloy', 'you: refactor the composer', '⌘⇧L stop · ⌘⌥L mute')),
    Preview('6.8', 'DecisionComposer', 'composer', ('perm', 'a accept · A all · r reject · R all', 'awaiting decision')),
    Preview('7.1', 'LanePicker', 'picker', ('Claude Code · 2 running', 'Codex', 'Oh My Pi · 1 running')),
    Preview('7.2', 'DirectivePicker', 'picker', ('0301-impl · harness UI', '0302-catalog', 'preview  component migration')),
    Preview('7.3', 'ModelPicker', 'picker', ('sonnet-4-6', 'gpt-5-codex', 'grok-code-fast')),
    Preview('7.4', 'SessionPicker', 'picker', ('4f2a9c  · today', 'a91f3c  · yesterday', 'resume selected session')),
    Preview('7.5', 'TicketPicker', 'picker', ('Open 7       Closed 23', '▸ KR-301  Harness UI refactor', 'Enter  set ticket')),
    Preview('7.6', 'RemotePicker', 'picker', ('local harness', 'workstation via SSH', 'remote runtime · connected')),
    Preview('7.7', 'TriageOverlay', 'overlay', ('Judgement queue   2 / 5', '▸ Review the newest finding', 'j/k move · Enter open')),
    Preview('7.8', 'ReviewMatrixOverlay', 'overlay', ('Review quality matrix', 'codex-1 · 4     grok-1 · 2', 'round 12:04  ·  1 block  4 warn')),
    Preview('7.9', 'ReviewPriorityOverlay', 'overlay', ('Review priority', '▸ 1 blocker · 4 warnings', 'h/l switch lane · esc close')),
    Preview('7.10', 'OrchestratorConsole', 'overlay', ('orchestrator · seat codex-1', 'seat grid · dispatch form', 'feed  3 recent events')),
    Preview('7.11', 'MemoryDrawer', 'overlay', ('Memory', '▸ lane handoff', 'read-only · 3 entries')),
    Preview('7.12', 'HelpOverlay', 'hints', ('⌘P  compositor', 'j/k  move selection', 'Esc  close overlay')),
    Preview('7.13', 'MetricsOverlay', 'meter', ('Process  PID  CPU  Mem', 'claude  1423  12%  843M', 'codex   588  4%  412M')),
    Preview('7.14', 'ImageViewer', 'imageviewer', ('image viewer', 'n/p next · =/- zoom', '0 fit · 1 100% · Esc close')),
    Preview('7.15', 'TimelineCapture', 'timeline', ('หัวข้อที่น่าจะตรง', 'confidence 87%', '[ Capture ]      [ Cancel ]')),
    Preview('7.16', 'ReviewThreadDialog', 'overlay', ('Start Review', 'Review the selected thread?', 'Enter  start       Esc  cancel')),
)


BG = '#07111d'
PANEL = '#0d1c2b'
PANEL_2 = '#102436'
BORDER = '#315166'
TEXT = '#d8e8d8'
MUTED = '#8aa7b8'
CYAN = '#6dd0ff'
GREEN = '#8effb0'
AMBER = '#ffd166'
RED = '#ff6d8a'


def slug(name: str) -> str:
    return ''.join(c.lower() if c.isalnum() else '-' for c in name).strip('-')


def filename(preview: Preview) -> str:
    return f'{preview.number}-{slug(preview.name)}.svg'


def rect(x: int, y: int, w: int, h: int, fill: str = PANEL, stroke: str = BORDER, radius: int = 8) -> str:
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{fill}" stroke="{stroke}"/>'


def text(x: int, y: int, value: str, color: str = TEXT, size: int = 13, weight: int = 400) -> str:
    return f'<text x="{x}" y="{y}" fill="{color}" font-family="JetBrains Mono, Menlo, monospace" font-size="{size}" font-weight="{weight}">{escape(value)}</text>'


def line(x1: int, y1: int, x2: int, y2: int, color: str = BORDER) -> str:
    return f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}"/>'


def pill(x: int, y: int, value: str, color: str = CYAN, width: int | None = None) -> str:
    width = width or max(54, min(166, len(value) * 7 + 24))
    return rect(x, y, width, 27, PANEL_2, BORDER, 8) + text(x + 11, y + 18, value, color, 12, 600)


def body(preview: Preview) -> list[str]:
    kind, values = preview.kind, preview.lines
    out: list[str] = []
    if kind == 'layout':
        out += [rect(29, 76, 244, 113), rect(288, 76, 323, 51), rect(288, 138, 323, 51)]
        for i, value in enumerate(values[:4]):
            out.append(text(43 if i < 2 else 302, 101 + i * 26 if i < 2 else 101 + (i - 2) * 62, value, CYAN if i == 0 else TEXT, 12))
    elif kind == 'chips':
        x = 35
        for i, value in enumerate(values):
            out.append(pill(x, 111, value, (CYAN, GREEN, AMBER, MUTED)[i % 4]))
            x += max(54, min(166, len(value) * 7 + 24)) + 10
    elif kind == 'spinner':
        out.append('<circle cx="92" cy="132" r="22" fill="none" stroke="#315166" stroke-width="5"/>')
        out.append('<path d="M92 110 A22 22 0 0 1 114 132" fill="none" stroke="#6dd0ff" stroke-width="5" stroke-linecap="round"/>')
        for i, value in enumerate(values):
            out.append(text(147, 103 + i * 29, value, (CYAN, GREEN, RED)[i % 3], 14))
    elif kind == 'meter':
        for i, value in enumerate(values[:3]):
            y = 84 + i * 37
            out += [text(44, y + 13, value, TEXT, 12), rect(280, y, 291, 16, PANEL_2, BORDER, 8), rect(281, y + 1, (92, 250, 172)[i], 14, (CYAN, GREEN, AMBER)[i], (CYAN, GREEN, AMBER)[i], 7)]
    elif kind == 'stats':
        for i, value in enumerate(values[:4]):
            x = 43 + (i % 2) * 276
            y = 108 + (i // 2) * 48
            out += [rect(x - 10, y - 24, 255, 37, PANEL_2, BORDER), text(x, y, value, CYAN if i % 2 else TEXT, 12)]
    elif kind == 'empty':
        out += [text(225, 120, values[0], CYAN, 18, 700), text(163, 151, values[1], MUTED, 12)]
    elif kind == 'actions':
        x = 43
        for value in values:
            out.append(pill(x, 108, value, CYAN, 166))
            x += 178
    elif kind == 'hints':
        for i, value in enumerate(values[:3]):
            out += [pill(47, 85 + i * 35, value.split('  ')[0], CYAN, 93), text(153, 104 + i * 35, value.split('  ')[-1], TEXT, 12)]
    elif kind == 'tabs':
        x = 43
        for i, value in enumerate(values):
            out.append(pill(x, 104, value, CYAN if i == 0 else MUTED, 174))
            x += 184
        out.append(line(43, 146, 595, 146))
    elif kind == 'caret':
        out += [rect(42, 96, 555, 58, PANEL_2, BORDER, 0), text(55, 130, values[0][:47], TEXT, 13), text(55 + min(len(values[0]), 47) * 7.85, 130, values[1], CYAN, 15)]
    elif kind in ('card', 'panel'):
        out += [rect(42, 79, 555, 101, PANEL_2, BORDER, 8), text(57, 105, values[0], CYAN, 13, 700), line(57, 116, 580, 116)]
        for i, value in enumerate(values[1:3]):
            out.append(text(57, 139 + i * 24, value, TEXT if i == 0 else MUTED, 12))
    elif kind == 'overlay':
        out += [rect(72, 77, 495, 111, PANEL_2, CYAN, 8), text(89, 101, values[0], CYAN, 14, 700), line(89, 111, 550, 111)]
        for i, value in enumerate(values[1:3]):
            out.append(text(89, 139 + i * 25, value, TEXT if i == 0 else MUTED, 12))
    elif kind in ('picker', 'palette'):
        out += [rect(53, 77, 532, 112, PANEL_2, BORDER, 8)]
        for i, value in enumerate(values[:3]):
            if i == 0:
                out.append(rect(66, 85, 505, 28, '#173b4d', CYAN, 5))
            out.append(text(81, 104 + i * 33, ('▸ ' if i == 0 else '  ') + value, CYAN if i == 0 else TEXT, 12))
    elif kind == 'diff':
        out += [rect(44, 79, 551, 105, '#0b1724', BORDER, 5)]
        for i, value in enumerate(values[:3]):
            out.append(text(56, 104 + i * 31, value[:68], (MUTED, RED, GREEN)[i], 12))
    elif kind in ('row', 'tool', 'subagent', 'permission', 'question', 'error'):
        out += [rect(39, 79, 558, 105, PANEL_2, BORDER, 5), line(120, 80, 120, 183)]
        color = RED if kind == 'error' else AMBER if kind in ('permission', 'question') else CYAN
        out.append(text(53, 105, {'tool': 'tool', 'subagent': 'agent', 'permission': 'perm', 'question': 'ask', 'error': 'agent'}.get(kind, values[0].split()[0]), color, 12, 700))
        if kind == 'row':
            label = values[0].split()[0]
            content = (values[0][len(label):].strip(), *values[1:])
            content = tuple(value for value in content if value)
        else:
            content = values
        for i, value in enumerate(content[:3]):
            out.append(text(135, 105 + i * 28, value[:61], TEXT if i == 0 else MUTED, 12))
    elif kind == 'usage':
        out += [rect(42, 78, 555, 108, PANEL_2, BORDER, 8), text(57, 102, values[0], CYAN, 13), text(57, 128, values[1], GREEN, 12), rect(203, 116, 320, 13, '#183346', BORDER, 6), rect(204, 117, 270, 11, GREEN, GREEN, 5), text(57, 161, values[2], TEXT, 12)]
    elif kind == 'images':
        out.append(text(45, 92, values[0], CYAN, 13))
        for i, value in enumerate(values[1:3]):
            x = 50 + i * 245
            out += [rect(x, 103, 220, 67, PANEL_2, BORDER, 8), rect(x + 13, 116, 42, 40, '#24465c', CYAN, 5), text(x + 66, 139, value, TEXT, 12)]
    elif kind == 'resource':
        out += [text(45, 93, values[0], CYAN, 13, 700)]
        for i, value in enumerate(values[1:3]):
            out += [rect(45, 104 + i * 35, 548, 29, PANEL_2, BORDER, 5), text(58, 124 + i * 35, value, TEXT, 12)]
    elif kind == 'transcript':
        for i, value in enumerate(values[:3]):
            out += [rect(42, 79 + i * 37, 555, 31, PANEL_2, BORDER, 5), text(55, 99 + i * 37, value, (CYAN, TEXT, GREEN)[i], 12)]
    elif kind == 'lane':
        out += [rect(42, 77, 556, 113, PANEL_2, BORDER, 5), text(57, 103, values[0], CYAN, 13, 700), line(57, 114, 580, 114), text(57, 139, values[1], MUTED, 12), text(57, 166, values[2], TEXT, 12)]
    elif kind == 'rail':
        out += [rect(43, 77, 270, 111, PANEL_2, BORDER, 5)]
        for i, value in enumerate(values[:3]):
            out.append(text(55, 103 + i * 32, value, CYAN if i == 0 else TEXT, 12))
        out += [rect(331, 77, 265, 111, PANEL, BORDER, 5), text(349, 105, 'ACTIVE LANE', MUTED, 11), text(349, 141, 'transcript →', CYAN, 13)]
    elif kind == 'composer':
        out += [rect(42, 86, 555, 91, PANEL_2, CYAN, 0), text(56, 112, values[0], CYAN, 12, 700), text(56, 141, values[1], TEXT, 13), text(56, 165, values[2], MUTED, 11)]
    elif kind == 'voice':
        out += [pill(42, 84, values[0], RED, 248)]
        for i, h in enumerate((19, 29, 15, 35, 24, 39, 16, 27, 18, 33, 14, 25)):
            out.append(rect(45 + i * 43, 149 - h, 13, h, CYAN if i < 8 else BORDER, CYAN if i < 8 else BORDER, 3))
        out.append(text(326, 106, values[1], MUTED, 12))
    elif kind == 'imageviewer':
        out += [rect(43, 76, 553, 113, PANEL_2, BORDER, 5), rect(275, 95, 91, 65, '#1f465e', CYAN, 5), '<path d="M283 150 L307 122 L324 139 L338 117 L357 150 Z" fill="#6dd0ff" opacity=".55"/>', text(56, 102, values[0], CYAN, 12, 700), text(388, 128, values[1], TEXT, 11), text(388, 149, values[2], MUTED, 11)]
    elif kind == 'timeline':
        out += [rect(52, 78, 535, 110, PANEL_2, BORDER, 8), text(68, 104, values[0], CYAN, 14, 700), text(68, 132, values[1], GREEN, 12), pill(68, 149, 'Capture', CYAN, 111), text(196, 167, 'Cancel', MUTED, 12)]
    else:
        raise ValueError(f'unknown kind: {kind}')
    return out


def render(preview: Preview) -> str:
    title = f'{preview.number} {preview.name} component preview'
    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="220" viewBox="0 0 640 220" role="img"',
        f' aria-label="{escape(title, quote=True)}">',
        f'<title>{escape(title)}</title>',
        rect(1, 1, 638, 218, BG, BORDER, 8),
        text(25, 33, f'{preview.number}  {preview.name}', CYAN, 16, 700),
        text(464, 32, 'HARNESS UI  /  DESIGN', MUTED, 10, 600),
        line(25, 52, 615, 52),
    ]
    if preview.live:
        parts += [rect(553, 42, 58, 21, '#153b39', GREEN, 5), text(566, 57, 'LIVE', GREEN, 10, 700)]
    parts.extend(body(preview))
    parts.append('</svg>\n')
    return ''.join(parts)


def main() -> None:
    here = Path(__file__).parent
    names: set[str] = set()
    for preview in PREVIEWS:
        name = filename(preview)
        if name in names:
            raise ValueError(f'duplicate preview: {name}')
        names.add(name)
        (here / name).write_text(render(preview), encoding='utf-8')
    print(f'rendered {len(names)} SVG previews in {here}')


if __name__ == '__main__':
    main()
