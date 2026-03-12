// Ghost-signal sound theme type definitions

/** Metadata for a ghost-signal sound theme */
export interface GhostSignalMeta {
  name: string;
  subtitle: string;
  colors: Record<string, string>;
  placeholder?: string;
  sounds: Record<string, { label: string; meta: string; desc: string }>;
}

/** A ghost-signal compatible sound theme module */
export interface GhostSignalTheme {
  meta: GhostSignalMeta;
  createSounds: (
    ctx: AudioContext,
    noiseBuffer: (duration?: number) => AudioBuffer,
  ) => Record<string, () => void>;
}
