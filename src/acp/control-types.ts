export interface TelegramControlCaller {
  updateId: string;
  userId: string;
  displayName: string;
  chatId: string;
  chatKind: string;
}

/** Trusted origin metadata. Rust creates `control_api` / `telegram` /
 *  `live_assist` after transport authentication; `prompt_dialog` (spec 372) is
 *  set only by the in-app Smart Prompt Dialog and cannot arrive over the wire;
 *  `commit_browser` (spec 0375) is set only by the in-app Commit Browser for
 *  `lane.learn` and likewise cannot arrive over the wire. */
export interface ControlCaller {
  source: 'control_api' | 'telegram' | 'live_assist' | 'prompt_dialog' | 'commit_browser';
  telegram?: TelegramControlCaller;
}
