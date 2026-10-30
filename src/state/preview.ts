import type { ColorInfo } from '../color/format';
import { createStore } from './store';

/**
 * Unapplied colors from an open curve edit, per palette id, by step name.
 * The palette grid draws these rows live; nothing reaches the files until
 * the edit is applied.
 */
export interface PreviewState {
  colors: ReadonlyMap<string, ReadonlyMap<string, ColorInfo>>;
}

export const preview = createStore<PreviewState>({ colors: new Map() });

export const setPreview = (colors: ReadonlyMap<string, ReadonlyMap<string, ColorInfo>>) => preview.set({ colors });
export const clearPreview = () => preview.set({ colors: new Map() });
