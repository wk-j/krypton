import { invoke } from '@tauri-apps/api/core';

import { emptyState, validChoice, validRule } from './model';
import { preloadChoice } from './renderer';
import type { BackgroundChoice, BackgroundState, PermissionBackgroundRule } from './types';

/** One authority per compositor; mutations are serialized and revision checked. */
export class BackgroundStore {
  state = emptyState();
  error: string | null = null;
  loaded = false;
  busy = false;
  private listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  subscribe(cb: () => void): () => void { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  private publish(): void { for (const cb of this.listeners) cb(); }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    this.pending++;
    this.busy = true;
    this.publish();
    const next = this.queue.then(operation);
    this.queue = next.catch(() => undefined);
    return next.finally(() => { this.busy = --this.pending > 0; this.publish(); });
  }
  async refresh(): Promise<void> {
    return this.serial(async () => {
      try {
        this.state = await invoke<BackgroundState>('background_list');
        this.error = null;
        this.loaded = true;
      } catch (error) { this.error = String(error); this.loaded = false; throw error; }
      finally { this.publish(); }
    });
  }
  private mutate<T>(command: string, args: Record<string, unknown>, extract: (result: T) => BackgroundState, prepare?: () => Promise<unknown>): Promise<T> {
    return this.serial(async () => {
      if (!this.loaded) throw new Error(this.error ?? 'Refresh the background library before saving');
      await prepare?.();
      // Revision is captured when this operation executes, not when enqueued.
      const result = await invoke<T>(command, { ...args, expectedRevision: this.state.revision });
      this.state = extract(result);
      this.publish();
      return result;
    });
  }
  apply(c: BackgroundChoice): Promise<BackgroundState> {
    const draft = structuredClone(c);
    return this.mutate('background_apply', { choice: draft }, (s: BackgroundState) => s, async () => {
      if (!validChoice(draft, this.state)) throw new Error('Use a valid #RRGGBB colour or library background');
      await preloadChoice(draft, this.state);
    });
  }
  saveRule(rule: PermissionBackgroundRule): Promise<BackgroundState> {
    const draft = structuredClone(rule);
    return this.mutate('background_rule_save', { rule: draft }, (s: BackgroundState) => s, async () => {
      if (!validRule(draft, this.state)) throw new Error('Choose a valid permission background');
      if (draft.target) await preloadChoice(draft.target, this.state);
    });
  }
  reset(): Promise<BackgroundState> {
    return this.mutate('background_reset', {}, (s: BackgroundState) => s);
  }
  remove(assetId: string): Promise<{ state: BackgroundState; cleanupWarning: string | null }> {
    return this.mutate('background_remove', { assetId }, (r: { state: BackgroundState; cleanupWarning: string | null }) => r.state);
  }
  import(file: File): Promise<{ state: BackgroundState; assetId: string }> {
    return this.serial(async () => {
      if (!this.loaded) throw new Error(this.error ?? 'Refresh before importing');
      if (file.size > 10 * 1024 * 1024) throw new Error('Image exceeds 10 MiB; choose a smaller file');
      // Native async base64 encoding avoids a 10 MiB JS byte-to-string loop on
      // the input thread. File MIME/extension remains only a hint; Rust sniffs.
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (): void => {
          if (typeof reader.result !== 'string') { reject(new Error('Cannot read image bytes')); return; }
          resolve(reader.result.slice(reader.result.indexOf(',') + 1));
        };
        reader.onerror = (): void => reject(reader.error ?? new Error('Cannot read image bytes'));
        reader.onabort = (): void => reject(new Error('Image import cancelled'));
        reader.readAsDataURL(file);
      });
      const result = await invoke<{ state: BackgroundState; assetId: string }>('background_import', {
        name: file.name, dataBase64, expectedRevision: this.state.revision,
      });
      this.state = result.state;
      this.publish();
      return result;
    });
  }
}
