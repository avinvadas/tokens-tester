import { detectPalettes, type PaletteSet } from '../palette/detect';
import type { AppState } from './app';

let cache: { model: AppState['model']; overrides: AppState['paletteOverrides']; gamut: AppState['settings']['gamut']; result: PaletteSet } | undefined;

/** Palettes for the current state, recomputed only when the model, overrides or gamut change. */
export function palettesOf(s: AppState): PaletteSet {
  if (cache && cache.model === s.model && cache.overrides === s.paletteOverrides && cache.gamut === s.settings.gamut) return cache.result;
  const result = detectPalettes(s.model, s.paletteOverrides, s.settings.gamut);
  cache = { model: s.model, overrides: s.paletteOverrides, gamut: s.settings.gamut, result };
  return result;
}
