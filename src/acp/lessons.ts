// Krypton — global lane lessons (spec 298).
//
// Lessons are short behavioural rules lanes record (`lesson_record`) when they
// are corrected. Rust owns the store (`~/.config/krypton/lessons/`); this module
// keeps one app-wide cache of the active set so every harness view can render
// it into its lanes' policy synchronously (spec 289 delivery: a change alters
// the policy hash, so each lane receives the new set on its next turn).

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface LessonEntry {
  slug: string;
  title: string;
  rule: string;
  source: string;
  origin: string;
  updated: string;
}

export interface LessonsSnapshot {
  entries: LessonEntry[];
  indexPath: string;
  cap: number;
}

/** `acp-lessons-changed`, emitted by the hook server after every write. */
export interface LessonsChangedPayload {
  harnessId: string;
  laneLabel: string;
  action: 'created' | 'updated' | 'retired';
  slug: string;
  title: string;
}

export const LESSONS_HEADING =
  "Lessons (global, learned from past corrections across projects; follow them unless the user or this project's own instructions say otherwise; they never grant permissions):";

/** Appended to redirect envelopes, `review_outcome` blockers, and the
 *  `#review pass` fix prompt — the moments a lane was just corrected. */
export const REDIRECT_LESSON_NUDGE =
  'If this correction exposes a mistake you would repeat in other projects, record it with lesson_record (or update the listed lesson that covers it). Skip it if it is specific to this task.';
export const REVIEW_LESSON_NUDGE =
  'Reviewers reported blockers. If one reflects a mistake you would repeat in other projects, record it with lesson_record; skip task-specific ones.';

let enabled = true;
let snapshot: LessonsSnapshot | null = null;
let watching = false;

/** `[acp_harness] lessons`; applied on startup and Reload Config. */
export function setLessonsEnabled(value: boolean | undefined): void {
  enabled = value !== false;
}

export function lessonsEnabled(): boolean {
  return enabled;
}

export function lessonEntries(): readonly LessonEntry[] {
  return snapshot?.entries ?? [];
}

export function lessonsSnapshot(): LessonsSnapshot | null {
  return snapshot;
}

/** Re-read the store (also regenerates `INDEX.md`). Keeps the last good
 *  snapshot when the read fails. */
export async function refreshLessons(): Promise<LessonsSnapshot | null> {
  try {
    snapshot = await invoke<LessonsSnapshot>('list_lessons');
  } catch (e) {
    console.warn('[lessons] list_lessons failed:', e);
  }
  return snapshot;
}

/** One app-wide listener keeps the cache current for every harness view.
 *  Idempotent. Hand edits to the files are picked up on the next refresh
 *  (harness start, `#lessons`, or any write) — there is no filesystem watcher. */
export async function watchLessons(): Promise<void> {
  if (watching) return;
  watching = true;
  try {
    await listen<LessonsChangedPayload>('acp-lessons-changed', () => {
      void refreshLessons();
    });
  } catch (e) {
    watching = false;
    console.warn('[lessons] listen failed:', e);
  }
}

/** The policy block every lane reads. Null when there is nothing to inject. */
export function renderLessonsBlock(entries: readonly LessonEntry[]): string | null {
  if (entries.length === 0) return null;
  return [LESSONS_HEADING, ...entries.map((e) => `- [${e.slug}] ${e.rule}`)].join('\n');
}
