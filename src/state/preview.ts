import type { ColorInfo } from '../color/format';
import { createStore } from './store';

/**
 * Unapplied colors from an open curve edit, per palette id, in swatch order.
 * The palette grid draws these rows live; nothing reaches the files until
 * the edit is applied.
 */
export interface PreviewState {
  colors: ReadonlyMap<string, readonly ColorInfo[]>;
}

export const preview = createStore<PreviewState>({ colors: new Map() });

export const setPreview = (colors: ReadonlyMap<string, readonly ColorInfo[]>) => preview.set({ colors });
export const clearPreview = () => preview.set({ colors: new Map() });
