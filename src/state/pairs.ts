import { applyPairEdits, checkPair, colorTokenIds, detectPairs, type Pair, type PairCheck } from '../semantic/pairs';
import { allModels, type AppState } from './app';

export interface PairRow {
  pair: Pair;
  /** One check per theme (or one without themes); undefined where a token is missing. */
  checks: (PairCheck | undefined)[];
  /** False when the pair fails in any theme it exists in. */
  pass: boolean;
}

export interface PairsResult {
  /** Color tokens across every theme, for adding pairs by hand. */
  colorIds: string[];
  rows: PairRow[];
  /** True when the user changed the detected pairs. */
  edited: boolean;
}

let cache: { key: unknown[]; result: PairsResult } | undefined;

/** Pairs for the current state, checked in every theme; recomputed only when their inputs change. */
export function pairsOf(s: AppState): PairsResult {
  const key = [s.model, s.themeModels, s.pairEdits, s.settings.contrast];
  if (cache && cache.key.every((k, i) => k === key[i])) return cache.result;
  const models = allModels(s);
  const colorIds = colorTokenIds(models);
  const pairs = applyPairEdits(detectPairs(colorIds), s.pairEdits);
  const rows = pairs.map((pair) => {
    const checks = models.map((m) => checkPair(pair, m, s.settings.contrast));
    return { pair, checks, pass: checks.every((c) => !c || c.pass) };
  });
  const e = s.pairEdits;
  const result = { colorIds, rows, edited: e.added.length + e.removed.length + Object.keys(e.kinds).length > 0 };
  cache = { key, result };
  return result;
}
