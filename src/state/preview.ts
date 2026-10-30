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

const NONE: PreviewState['colors'] = new Map();

export const preview = createStore<PreviewState>({ colors: NONE });

export const setPreview = (colors: ReadonlyMap<string, ReadonlyMap<string, ColorInfo>>) => preview.set({ colors });
export const clearPreview = () => preview.set({ colors: NONE });

/** The colors to show when no edit changes anything, kept identical so the grid does not redraw. */
export const clearPreviewColors = () => preview.get().colors !== NONE && preview.set({ colors: NONE });
