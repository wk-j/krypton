// Krypton — daily-note rendering (spec 223).
//
// Pure and deterministic: same digest in, same markdown out. Every line traces
// to a record in the digest. There is no summarising, no ranking, no "looks
// like you were working on X" — that is what `#daily brief` is for, and its
// answer deliberately never reaches this file.
//
// Output conforms to the Obsidian daily-note convention (one `YYYY-MM-DD.md`,
// frontmatter, `[[wikilinks]]`) so it reads correctly in the Vault Viewer
// (spec 59) or in a real vault.

import type { UsageGroup } from './usage-log';
import { formatTokenCount } from './usage-log';
import type { JournalEvent, JournalKind } from './journal';

// --------------------------------------------------------------- digest types

/** Mirrors `journal::CommitEntry` in Rust. */
export interface CommitEntry {
  hash: string;
  at: number;
  subject: string;
  files: number;
  added: number;
  removed: number;
  /** Stems of `docs/<NNN>-<slug>.md` touched, for `[[wikilinks]]`. */
  specs: string[];
}

/** Mirrors `journal::ReviewEntry` in Rust. */
export interface ReviewEntry {
  slug: string;
  path: string;
  at: number;
}

/** Mirrors `journal::ArtifactEntry` in Rust. */
export interface ArtifactEntry {
  id: string;
  title: string;
  lane: string;
  harnessId: string;
  path: string;
  at: number;
}

/** Mirrors `git::WorkingDiffStat` in Rust (spec 220). */
export interface WorkingDiffStat {
  repoRoot: string;
  files: number;
  added: number;
  removed: number;
  truncated: boolean;
}

/** Mirrors `journal::ProjectDigest` in Rust. */
export interface ProjectDigest {
  name: string;
  path: string;
  unavailable?: string;
  turns: number;
  cancelledTurns: number;
  userOriginTurns: number;
  systemOriginTurns: number;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  reportedCost: number;
  firstTurnAt: number | null;
  lastTurnAt: number | null;
  maxContextUsed: number | null;
  byLane: UsageGroup[];
  byModel: UsageGroup[];
  /** `[lane, wallClockMs]`, busiest first. NOT time worked — see the header. */
  laneWallClockMs: [string, number][];
  commits: CommitEntry[];
  uncommitted?: WorkingDiffStat;
  reviews: ReviewEntry[];
  artifacts: ArtifactEntry[];
}

/** Mirrors `journal::DayDigest` in Rust. */
export interface DayDigest {
  date: string;
  tzOffsetMinutes: number;
  project: ProjectDigest;
  extra: ProjectDigest[];
  events: JournalEvent[];
  truncated: boolean;
  generatedAt: number;
}

// ------------------------------------------------------------------ formatting

const THAI_WEEKDAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];

const KIND_LABEL: Record<JournalKind, string> = {
  session: 'session',
  goal: 'goal',
  handoff: 'handoff',
  attention: 'attention',
  review: 'review',
  artifact: 'artifact',
  ticket: 'ticket',
  note: 'note',
};

function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function weekday(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  return THAI_WEEKDAYS[d.getDay()] ?? '';
}

function hours(ms: number): string {
  return `${(ms / 3_600_000).toFixed(2)} h`;
}

/** `+1328 / -27` — the shape the window status bar already uses (spec 220). */
function lineDelta(added: number, removed: number): string {
  return `+${added} / -${removed}`;
}

// -------------------------------------------------------------------- sections

function frontmatter(digest: DayDigest, repos: string[]): string[] {
  const commits = digest.project.commits.length;
  const turns = digest.project.turns + digest.extra.reduce((n, p) => n + p.turns, 0);
  return [
    '---',
    `date: ${digest.date}`,
    'type: daily-note',
    'generated: krypton-journal',
    `repos: [${repos.join(', ')}]`,
    `turns: ${turns}`,
    `commits: ${commits}`,
    'tags: [daily, harness]',
    '---',
    '',
  ];
}

function headline(digest: DayDigest): string {
  const active = [digest.project, ...digest.extra].filter((p) => p.turns > 0 || p.commits.length > 0);
  const first = active.map((p) => p.firstTurnAt).filter((v): v is number => v != null);
  const last = active.map((p) => p.lastTurnAt).filter((v): v is number => v != null);

  const bits: string[] = [];
  if (first.length && last.length) {
    bits.push(`**${clock(Math.min(...first))} → ${clock(Math.max(...last))}**`);
  }
  if (active.length > 1) bits.push(`${active.length} repo`);
  const turns = active.reduce((n, p) => n + p.turns, 0);
  if (turns) bits.push(`${turns} turns`);
  const commits = digest.project.commits.length;
  if (commits) bits.push(`${commits} commits`);
  const pending = digest.project.uncommitted;
  if (pending && pending.files > 0) bits.push(`ค้างใน working tree ${pending.files} ไฟล์`);
  return bits.length ? `> ${bits.join(' · ')}` : '> ไม่มีกิจกรรมที่บันทึกไว้';
}

/**
 * Attribute each journal event to the commit that closed over it.
 *
 * A commit's window runs from the previous commit to itself, so the events
 * listed under it are the ones that happened while it was being written.
 * Events after the last commit are not attributed at all — they belong to work
 * still in the working tree, and land in `ค้างอยู่` instead.
 */
function attributeEvents(
  commits: CommitEntry[],
  events: JournalEvent[],
): { perCommit: Map<string, JournalEvent[]>; trailing: JournalEvent[] } {
  const perCommit = new Map<string, JournalEvent[]>();
  let lowerBound = -Infinity;
  for (const commit of commits) {
    const window = events.filter((e) => e.at > lowerBound && e.at <= commit.at);
    if (window.length) perCommit.set(commit.hash, window);
    lowerBound = commit.at;
  }
  return { perCommit, trailing: events.filter((e) => e.at > lowerBound) };
}

function eventLine(event: JournalEvent): string {
  const label = KIND_LABEL[event.kind] ?? event.kind;
  return `- \`${clock(event.at)}\` **${event.lane}** · ${label} — ${event.summary}`;
}

function commitSections(digest: DayDigest): string[] {
  const { commits } = digest.project;
  if (!commits.length) return [];
  const { perCommit } = attributeEvents(commits, digest.events);

  const out = ['## ที่ทำวันนี้', ''];
  for (const commit of commits) {
    out.push(`### \`${clock(commit.at)}\` ${commit.subject}`);
    const meta = [`\`${commit.hash}\``, `${commit.files} ไฟล์`, lineDelta(commit.added, commit.removed)];
    if (commit.specs.length) meta.push(commit.specs.map((s) => `[[${s}]]`).join(' · '));
    out.push(meta.join(' · '), '');
    const events = perCommit.get(commit.hash) ?? [];
    if (events.length) {
      out.push(...events.map(eventLine), '');
    }
  }
  return out;
}

/** Attention flags raised today and not resolved today. */
function openAttention(events: JournalEvent[]): JournalEvent[] {
  const resolved = new Set(
    events
      .filter((e) => e.kind === 'attention' && e.meta?.action === 'resolve')
      .map((e) => String(e.meta?.itemId ?? '')),
  );
  return events.filter(
    (e) =>
      e.kind === 'attention' &&
      e.meta?.action !== 'resolve' &&
      !resolved.has(String(e.meta?.itemId ?? '')),
  );
}

function pendingSection(digest: DayDigest): string[] {
  const pending = digest.project.uncommitted;
  const open = openAttention(digest.events);
  const { trailing } = attributeEvents(digest.project.commits, digest.events);
  const trailingNonAttention = trailing.filter((e) => e.kind !== 'attention');
  if (!pending?.files && !open.length && !trailingNonAttention.length) return [];

  const out = ['## ค้างอยู่', ''];
  if (pending && pending.files > 0) {
    const suffix = pending.truncated ? ' (นับได้ไม่ครบ — มีไฟล์ binary หรือใหญ่เกิน)' : '';
    out.push(`- working tree: ${pending.files} ไฟล์ ${lineDelta(pending.added, pending.removed)}${suffix}`, '');
  }
  if (trailingNonAttention.length) {
    out.push('**หลัง commit ล่าสุด**', '', ...trailingNonAttention.map(eventLine), '');
  }
  if (open.length) {
    out.push('**attention ที่ยังไม่ปิด**', '', ...open.map(eventLine), '');
  }
  return out;
}

function laneTable(project: ProjectDigest): string[] {
  if (!project.byLane.length) return [];
  const wallClock = new Map(project.laneWallClockMs);
  const out = [
    '## Lane ที่ลงแรง',
    '',
    '| Lane | Turns | Lane wall-clock | Output | Cached read |',
    '|---|---:|---:|---:|---:|',
  ];
  for (const group of project.byLane) {
    out.push(
      `| ${group.key} | ${group.turns} | ${hours(wallClock.get(group.key) ?? 0)} | ` +
        `${formatTokenCount(group.outputTokens)} | ${formatTokenCount(group.cachedReadTokens)} |`,
    );
  }
  out.push('');

  const facts: string[] = [];
  if (project.userOriginTurns || project.systemOriginTurns) {
    facts.push(
      `turn ที่ user เริ่ม **${project.userOriginTurns}** / ระบบเริ่มเอง **${project.systemOriginTurns}**`,
    );
  }
  if (project.cancelledTurns) facts.push(`cancel **${project.cancelledTurns}** ครั้ง`);
  if (project.maxContextUsed != null) {
    facts.push(`context สูงสุด **${formatTokenCount(project.maxContextUsed)}**`);
  }
  if (project.byModel.length) {
    facts.push(`โมเดล: ${project.byModel.map((m) => `${m.key} (${m.turns})`).join(', ')}`);
  }
  if (facts.length) out.push(...facts.map((f) => `- ${f}`), '');
  out.push(
    '> *Lane wall-clock* นับตั้งแต่ส่ง prompt จนจบ turn จึงรวมเวลาที่ lane รอคนตอบด้วย — ไม่ใช่เวลาที่ทำงานจริง',
    '',
  );
  return out;
}

function outputsSection(project: ProjectDigest): string[] {
  if (!project.reviews.length && !project.artifacts.length) return [];
  const out = ['## Review & artifacts', ''];
  for (const review of project.reviews) {
    out.push(`- \`${clock(review.at)}\` review — [${review.slug}](${review.path}/review.md)`);
  }
  for (const artifact of project.artifacts) {
    out.push(
      `- \`${clock(artifact.at)}\` artifact — [${artifact.title}](${artifact.path}) · ${artifact.lane}`,
    );
  }
  out.push('');
  return out;
}

function extraSection(extra: ProjectDigest[]): string[] {
  if (!extra.length) return [];
  const out = ['## งานนอก repo', ''];
  for (const project of extra) {
    if (project.unavailable) {
      out.push(`- **${project.name}** — อ่านไม่ได้ (${project.unavailable})`);
      continue;
    }
    if (!project.turns && !project.commits.length) {
      out.push(`- **${project.name}** — ไม่มีกิจกรรม`);
      continue;
    }
    const bits: string[] = [];
    if (project.firstTurnAt != null && project.lastTurnAt != null) {
      bits.push(`${clock(project.firstTurnAt)}–${clock(project.lastTurnAt)}`);
    }
    if (project.turns) bits.push(`${project.turns} turns`);
    if (project.commits.length) bits.push(`${project.commits.length} commits`);
    if (project.byLane.length) {
      bits.push(project.byLane.map((l) => `${l.key} (${l.turns})`).join(', '));
    }
    out.push(`- **${project.name}** — ${bits.join(' · ')}`);
  }
  out.push('');
  return out;
}

function sourceSection(digest: DayDigest): string[] {
  const rows: [string, string][] = [
    ['ช่วงเวลา, turns, lane, model, token, context, cancel', '`.krypton/usage/<date>.jsonl` (spec 214)'],
    ['commit, diffstat, spec wikilink', '`git log --since/--until --numstat` (กรองด้วย `user.email`)'],
    ['ไฟล์ที่ค้าง', '`git diff --numstat` vs `HEAD` (spec 220)'],
    ['บรรทัดใต้แต่ละ commit, attention ที่ยังไม่ปิด', '`.krypton/journal/<date>.jsonl` (spec 223)'],
    ['review bundle', '`.krypton/reviews/<slug>/` (spec 217)'],
    ['artifact', '`.krypton/artifacts/<harness>/<lane>/*.html`'],
  ];
  const out = [
    '---',
    '',
    '<details>',
    '<summary>ที่มาของข้อมูล</summary>',
    '',
    '| ส่วนของ note | มาจาก |',
    '|---|---|',
    ...rows.map(([what, from]) => `| ${what} | ${from} |`),
    '',
    'ทุกบรรทัดในไฟล์นี้ดึงมาจากข้อมูลที่บันทึกไว้ ไม่มีส่วนไหนถูกเดาหรือสรุปโดย LLM —',
    'ถ้าต้องการให้ช่วยเล่าเรื่องหรือชี้จุดที่ควรดู ใช้ `#daily brief` ซึ่งจะไม่เขียนกลับลงไฟล์นี้',
  ];
  if (digest.truncated) {
    out.push('', `บางหมวดถูกตัดที่ 50 รายการ — ไฟล์ jsonl ต้นทางยังครบ`);
  }
  out.push('', `สร้างเมื่อ ${clock(digest.generatedAt)}`, '', '</details>', '');
  return out;
}

// --------------------------------------------------------------------- render

/**
 * Render one day's digest as an Obsidian-compatible daily note.
 *
 * Deterministic: identical input yields byte-identical output, which is what
 * makes regenerating a note safe and makes the file diffable across a day.
 */
export function renderDailyNote(digest: DayDigest): string {
  const repos = [digest.project, ...digest.extra]
    .filter((p) => !p.unavailable)
    .map((p) => p.name);

  const day = weekday(digest.date);
  const lines: string[] = [
    ...frontmatter(digest, repos),
    `# ${digest.date}${day ? ` (${day})` : ''}`,
    '',
    headline(digest),
    '',
  ];

  const body = [
    ...commitSections(digest),
    ...pendingSection(digest),
    ...laneTable(digest.project),
    ...outputsSection(digest.project),
    ...extraSection(digest.extra),
  ];

  if (!body.length) {
    lines.push(
      'ไม่มีกิจกรรมที่บันทึกไว้สำหรับวันนี้ — ไม่มี turn, commit, review หรือ artifact',
      '',
    );
  } else {
    lines.push(...body);
  }

  lines.push(...sourceSection(digest));
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
