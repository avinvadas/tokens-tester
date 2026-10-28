import type { ColorInfo } from '../color/format';
import type { Palette } from '../palette/detect';
import { metricsFor, type Level, type Metric } from './levels';
import { contrast, pairContrast } from './metrics';

/**
 * Contrast analysis for base palettes:
 *  - every step against a light end and a dark end (step as text on it);
 *  - pass ranges: the run of steps, from the far end of the scale, that pass
 *    each level ("on white, AA: 600–950");
 *  - step distance: how many steps apart two colors of one scale must be to
 *    pass a level, and each step's nearest passing partner;
 *  - parity: whether pass ranges start at the same step name across palettes.
 */

export type EndId = 'light' | 'dark';

export interface End {
  id: EndId;
  /** "white", "black", or the token id used as the end. */
  name: string;
  info: ColorInfo;
}

export type Scores = Record<EndId, Partial<Record<Metric, number>>>;

export interface PassRange {
  end: EndId;
  level: Level;
  /** First and last step of the passing run, in palette order; undefined when no step passes. */
  from?: string;
  to?: string;
  /** Steps outside the run that also pass (the scale isn't monotonic there). */
  stray: string[];
}

export interface StepDistance {
  level: Level;
  /** Smallest gap (in steps) at which every pair that far apart passes; undefined if none does. */
  distance?: number;
  /** An example pair at that distance. */
  example?: [string, string];
  /** For each step, the nearest step that passes with it. */
  nearest: Record<string, string | undefined>;
}

export interface PaletteContrast {
  scores: Record<string, Scores>;
  ranges: PassRange[];
  distances: StepDistance[];
}

export function analyzePalette(p: Palette, ends: Record<EndId, End>, levels: readonly Level[]): PaletteContrast {
  const metrics = metricsFor(levels);
  const scores: Record<string, Scores> = {};
  for (const s of p.swatches) {
    const sc: Scores = { light: {}, dark: {} };
    for (const m of metrics) {
      sc.light[m] = contrast(s.info, ends.light.info, m);
      sc.dark[m] = contrast(s.info, ends.dark.info, m);
    }
    scores[s.step] = sc;
  }

  // Which side of the palette is dark: the run that passes on the light end starts there.
  const first = p.swatches[0]!.info.oklch.l;
  const last = p.swatches.at(-1)!.info.oklch.l;
  const darkAtEnd = last <= first;

  const ranges: PassRange[] = [];
  for (const end of ['light', 'dark'] as const) {
    // On the light end, darker steps pass: count the run from the dark side.
    const fromEnd = end === 'light' ? darkAtEnd : !darkAtEnd;
    for (const level of levels) {
      const passes = p.swatches.map((s) => (scores[s.step]![end][level.metric] ?? 0) >= level.threshold);
      ranges.push(passRange(p, passes, fromEnd, end, level));
    }
  }

  return { scores, ranges, distances: levels.map((l) => stepDistance(p, l)) };
}

function passRange(p: Palette, passes: boolean[], fromEnd: boolean, end: EndId, level: Level): PassRange {
  const n = passes.length;
  const idx = (k: number) => (fromEnd ? n - 1 - k : k);
  let run = 0;
  while (run < n && passes[idx(run)]) run++;
  const range: PassRange = { end, level, stray: [] };
  if (run > 0) {
    const a = idx(run - 1);
    const b = idx(0);
    range.from = p.swatches[Math.min(a, b)]!.step;
    range.to = p.swatches[Math.max(a, b)]!.step;
  }
  for (let k = run; k < n; k++) if (passes[idx(k)]) range.stray.push(p.swatches[idx(k)]!.step);
  return range;
}

function stepDistance(p: Palette, level: Level): StepDistance {
  const s = p.swatches;
  const n = s.length;
  const memo = new Map<string, number>();
  const pass = (i: number, j: number) => {
    const key = i < j ? `${i},${j}` : `${j},${i}`;
    let v = memo.get(key);
    if (v === undefined) {
      v = pairContrast(s[i]!.info, s[j]!.info, level.metric);
      memo.set(key, v);
    }
    return v >= level.threshold;
  };

  const nearest: Record<string, string | undefined> = {};
  for (let i = 0; i < n; i++) {
    for (let d = 1; d < n; d++) {
      // The closest partner; on a tie, the one earlier in the scale.
      const cands = [i - d, i + d].filter((j) => j >= 0 && j < n && pass(i, j));
      if (cands.length) {
        nearest[s[i]!.step] = s[cands[0]!]!.step;
        break;
      }
    }
  }

  const result: StepDistance = { level, nearest };
  for (let d = 1; d < n; d++) {
    let all = true;
    for (let i = 0; i + d < n && all; i++) all = pass(i, i + d);
    if (all) {
      result.distance = d;
      result.example = [s[0]!.step, s[d]!.step];
      break;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Parity across palettes

export interface ParityRow {
  end: EndId;
  level: Level;
  /** Where most palettes start passing (undefined: most never pass). */
  majority?: string;
  /** Palettes that start somewhere else, with where they start. */
  outliers: { id: string; from?: string }[];
}

/**
 * Numeric palettes that share step names should pass at the same step, so
 * semantic roles can swap palettes (danger.600 for info.600) safely.
 */
export function parity(palettes: readonly Palette[], results: ReadonlyMap<string, PaletteContrast>, levels: readonly Level[]): ParityRow[] {
  const numeric = palettes.filter((p) => p.order === 'numeric' && results.has(p.id));
  if (numeric.length < 2) return [];
  const rows: ParityRow[] = [];
  for (const end of ['light', 'dark'] as const) {
    for (const level of levels) {
      const starts = numeric.map((p) => ({ id: p.id, from: boundary(p, results.get(p.id)!, end, level) }));
      const count = new Map<string | undefined, number>();
      for (const s of starts) count.set(s.from, (count.get(s.from) ?? 0) + 1);
      const [majority, n] = [...count].sort((a, b) => b[1] - a[1])[0]!;
      if (n === starts.length) continue;
      const outliers = starts.filter((s) => s.from !== majority);
      const row: ParityRow = { end, level, outliers };
      if (majority !== undefined) row.majority = majority;
      rows.push(row);
    }
  }
  return rows;
}

/** The step where passing begins, seen from the failing side. */
export function boundary(p: Palette, r: PaletteContrast, end: EndId, level: Level): string | undefined {
  return passPoint(p, r, end, level)?.step;
}

/**
 * The boundary step and the side of it the failing steps lie on: `start` when
 * the passing run reaches the last step (failures are before it), `end` when
 * it starts at the first step.
 */
export function passPoint(p: Palette, r: PaletteContrast, end: EndId, level: Level): { step: string; side: 'start' | 'end' } | undefined {
  const range = r.ranges.find((x) => x.end === end && x.level.id === level.id);
  if (!range?.from) return undefined;
  const first = p.swatches[0]!.info.oklch.l;
  const last = p.swatches.at(-1)!.info.oklch.l;
  const darkAtEnd = last <= first;
  const runAtEnd = end === 'light' ? darkAtEnd : !darkAtEnd;
  return runAtEnd ? { step: range.from, side: 'start' } : { step: range.to!, side: 'end' };
}
