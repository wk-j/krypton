export type BackgroundSource =
  | { kind: 'desktop' }
  | { kind: 'solid'; color: string }
  | { kind: 'gradient'; from: string; to: string; angle: number }
  | { kind: 'image'; assetId: string };
export type BackgroundFit = 'cover' | 'contain' | 'stretch';
export type BackgroundAnchor = 'top-left' | 'top' | 'top-right' | 'left' | 'center'
  | 'right' | 'bottom-left' | 'bottom' | 'bottom-right';
export interface BackgroundChoice {
  source: BackgroundSource;
  fit: BackgroundFit;
  anchor: BackgroundAnchor;
  opacity: number;
  dimming: number;
}
export interface BackgroundAsset {
  id: string;
  name: string;
  imagePath: string;
  thumbnailPath: string;
  width: number;
  height: number;
  bytes: number;
}
export interface PermissionBackgroundRule { enabled: boolean; target: BackgroundChoice | null }
export interface BackgroundState {
  version: 1;
  revision: string;
  active: BackgroundChoice;
  permissionRule: PermissionBackgroundRule;
  assets: readonly BackgroundAsset[];
}
export interface LibraryItem { id: string; name: string; choice: BackgroundChoice; asset?: BackgroundAsset }
