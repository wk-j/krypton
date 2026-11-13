import type { BackgroundAnchor, BackgroundChoice, BackgroundSource, BackgroundState, LibraryItem, PermissionBackgroundRule } from './types';

export const ANCHORS: readonly BackgroundAnchor[] = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'];
export function choice(source: BackgroundSource): BackgroundChoice {
  return { source, fit: 'cover', anchor: 'center', opacity: 1, dimming: source.kind === 'image' ? 0.2 : 0 };
}
export const DESKTOP = choice({ kind: 'desktop' });
export const PRESETS: readonly LibraryItem[] = [
  { id: 'desktop', name: 'Desktop / Transparent', choice: DESKTOP },
  ...[['graphite', 'Graphite', '#101218'], ['midnight', 'Midnight', '#060a12'], ['paper', 'Paper', '#e6eff6'], ['custom', 'Custom colour', '#202838']].map(
    ([id, name, color]) => ({ id, name, choice: choice({ kind: 'solid', color }) }),
  ),
  { id: 'dusk', name: 'Dusk', choice: choice({ kind: 'gradient', from: '#101828', to: '#302338', angle: 135 }) },
  { id: 'ocean', name: 'Ocean', choice: choice({ kind: 'gradient', from: '#06131e', to: '#12383b', angle: 135 }) },
];
export function emptyState(): BackgroundState {
  return { version: 1, revision: '', active: structuredClone(DESKTOP), permissionRule: { enabled: false, target: null }, assets: [] };
}
export function library(state: BackgroundState): LibraryItem[] {
  return [...PRESETS, ...state.assets.map((asset) => ({ id: asset.id, name: asset.name, choice: choice({ kind: 'image', assetId: asset.id }), asset }))];
}
export function validChoice(c: BackgroundChoice | null, state: BackgroundState): c is BackgroundChoice {
  if (!c || !['cover', 'contain', 'stretch'].includes(c.fit) || !ANCHORS.includes(c.anchor)
    || !Number.isFinite(c.opacity) || c.opacity < 0 || c.opacity > 1
    || !Number.isFinite(c.dimming) || c.dimming < 0 || c.dimming > 0.9) return false;
  const s = c.source;
  switch (s.kind) {
    case 'desktop': return true;
    case 'solid': return /^#[0-9a-f]{6}$/i.test(s.color);
    case 'gradient': return s.angle === 135 && ((s.from === '#101828' && s.to === '#302338') || (s.from === '#06131e' && s.to === '#12383b'));
    case 'image': return /^[0-9a-f]{64}$/.test(s.assetId) && state.assets.some((a) => a.id === s.assetId);
    default: return false;
  }
}
export function validRule(rule: PermissionBackgroundRule, state: BackgroundState): boolean {
  return (!rule.enabled || rule.target !== null) && (rule.target === null || validChoice(rule.target, state));
}
export function sameChoice(a: BackgroundChoice | null, b: BackgroundChoice | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
export function itemFor(c: BackgroundChoice | null, state: BackgroundState): string | null {
  if (!c) return null;
  if (c.source.kind === 'image') return c.source.assetId;
  return PRESETS.find((p) => sameChoice(choice(p.choice.source), choice(c.source)))?.id ?? 'custom';
}
export function references(c: BackgroundChoice | null, id: string): boolean {
  return c?.source.kind === 'image' && c.source.assetId === id;
}

/** Only validated content becomes CSS; user strings are never style fragments. */
export function backgroundStyles(c: BackgroundChoice, imageUrl?: string): Record<string, string> {
  const s = c.source;
  const backgroundImage = s.kind === 'gradient' ? `linear-gradient(${s.angle}deg, ${s.from}, ${s.to})`
    : s.kind === 'image' && imageUrl ? `url(${JSON.stringify(imageUrl)})` : 'none';
  return {
    backgroundColor: s.kind === 'solid' ? s.color : 'transparent', backgroundImage,
    backgroundSize: c.fit === 'stretch' ? '100% 100%' : c.fit,
    backgroundPosition: c.anchor.replace('-', ' '), backgroundRepeat: 'no-repeat',
  };
}
