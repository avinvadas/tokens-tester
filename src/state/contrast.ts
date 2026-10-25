import { analyzePalette, parity, type End, type EndId, type PaletteContrast, type ParityRow } from '../contrast/analyze';
import { resolveEnds } from '../contrast/ends';
import { levelsFor, type Level } from '../contrast/levels';
import type { AppState } from './app';
import { palettesOf } from './palettes';

export interface ContrastView {
  ends: Record<EndId, End>;
  levels: Level[];
  results: Map<string, PaletteContrast>;
  parity: ParityRow[];
}

let cache: { palettes: unknown; ends: unknown; targets: unknown; result: ContrastView } | undefined;

/** Contrast analysis of the included palettes, recomputed only when palettes, ends or targets change. */
export function contrastOf(s: AppState): ContrastView {
  const set = palettesOf(s);
  if (cache && cache.palettes === set && cache.ends === s.contrastEnds && cache.targets === s.settings.contrast) return cache.result;
  const ends = resolveEnds(set, s.contrastEnds);
  const levels = levelsFor(s.settings.contrast);
  const included = set.palettes.filter((p) => p.included);
  const results = new Map(included.map((p) => [p.id, analyzePalette(p, ends, levels)]));
  const result: ContrastView = { ends, levels, results, parity: parity(included, results, levels) };
  cache = { palettes: set, ends: s.contrastEnds, targets: s.settings.contrast, result };
  return result;
}
