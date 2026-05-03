import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export async function setupListener<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  return listen<T>(event, (e) => handler(e.payload));
}

export class ListenerBag {
  private fns: UnlistenFn[] = [];

  add(fn: UnlistenFn): void {
    this.fns.push(fn);
  }

  async dispose(): Promise<void> {
    const fns = this.fns.splice(0);
    for (const fn of fns) {
      try {
        fn();
      } catch (e) {
        console.warn('[ListenerBag] unlisten failed:', e);
      }
    }
  }
}
