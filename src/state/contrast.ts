import { analyzePalette, parity, type End, type EndId, type PaletteContrast, type ParityRow } from '../contrast/analyze';
import { resolveEnds, rowEnds, withinEnds } from '../contrast/ends';
import { levelsFor, type Level } from '../contrast/levels';
import type { Palette } from '../palette/detect';
import type { AppState } from './app';
import { palettesOf } from './palettes';

export interface ContrastView {
  /** The global, neutral ends. */
  ends: Record<EndId, End>;
  /** Each included palette's own ends: the global ends' lightness, tinted with its hue. Results are measured against these. */
  rowEnds: Map<string, Record<EndId, End>>;
  /** Each included palette within the ends' range (steps past the ends left out). Results are for these. */
  within: Map<string, Palette>;
  levels: Level[];
  results: Map<string, PaletteContrast>;
  parity: ParityRow[];
}

let cache: { palettes: unknown; ends: unknown; targets: unknown; gamut: unknown; result: ContrastView } | undefined;

/** Contrast analysis of the included palettes, recomputed only when palettes, ends or targets change. */
export function contrastOf(s: AppState): ContrastView {
  const set = palettesOf(s);
  if (cache && cache.palettes === set && cache.ends === s.contrastEnds && cache.targets === s.settings.contrast && cache.gamut === s.settings.gamut) return cache.result;
  const ends = resolveEnds(set, s.contrastEnds);
  const levels = levelsFor(s.settings.contrast);
  const included = set.palettes.filter((p) => p.included).map((p) => withinEnds(p, ends));
  const own = new Map(included.map((p) => [p.id, rowEnds(p, ends, s.settings.gamut)]));
  const measured = included.filter((p) => p.swatches.length);
  const results = new Map(measured.map((p) => [p.id, analyzePalette(p, own.get(p.id)!, levels)]));
  const result: ContrastView = { ends, rowEnds: own, within: new Map(included.map((p) => [p.id, p])), levels, results, parity: parity(measured, results, levels) };
  cache = { palettes: set, ends: s.contrastEnds, targets: s.settings.contrast, gamut: s.settings.gamut, result };
  return result;
}
