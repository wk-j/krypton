export interface TelegramControlCaller {
  updateId: string;
  userId: string;
  displayName: string;
  chatId: string;
  chatKind: string;
}

/** Trusted origin metadata created by Rust after transport authentication. */
export interface ControlCaller {
  source: 'control_api' | 'telegram' | 'live_assist';
  telegram?: TelegramControlCaller;
}
