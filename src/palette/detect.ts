import { colorInfo, type ColorInfo, type Gamut } from '../color/format';
import type { Model, Token } from '../model/types';
import { checkPalettes, type ScaleFlag } from './checks';
import { orderSteps, type OrderKind } from './order';

/**
 * Tier-1 (base) colors and the palettes they form.
 *
 * A base color is a color token with a literal value (not a reference).
 * Base colors are grouped by their parent group: `color.blue.500` belongs to
 * palette `color.blue` as step `500`. Groups that look semantic by name
 * (`bg`, `text`, `theme`…) are left out by default; the user can include or
 * exclude any palette.
 */

export interface Swatch {
  token: Token;
  step: string;
  info: ColorInfo;
  /** A row end derived from the global ends, not a token (curve editor only). Never written back. */
  derived?: 'light' | 'dark';
}

export type Direction = 'light-to-dark' | 'dark-to-light' | 'flat';

export interface Palette {
  /** Group id, e.g. "color.blue". */
  id: string;
  name: string;
  swatches: Swatch[];
  order: OrderKind;
  direction: Direction;
  included: boolean;
  /** Why the palette is excluded by default, when it is. */
  excludedReason?: string;
  flags: ScaleFlag[];
}

export interface PaletteSet {
  palettes: Palette[];
  /** Base colors that don't form a scale (e.g. `color.white`, `brand.primary`). */
  loose: Swatch[];
}

const SEMANTIC_NAMES = /^(semantics?|alias(es)?|themes?|components?|bg|backgrounds?|fg|foregrounds?|text|surfaces?|borders?|status|feedback|intents?|states?)$/i;

/** True for tokens that hold their own color value (tier 1). */
export function isBaseColor(t: Token): boolean {
  return t.type === 'color' && !t.aliasOf && t.refs.length === 0 && t.resolution === 'ok' && !t.extendedFrom;
}

export function detectPalettes(model: Model, overrides: Readonly<Record<string, boolean>>, gamut: Gamut): PaletteSet {
  const groups = new Map<string, Swatch[]>();
  for (const t of [...model.tokens.values()].sort((a, b) => a.order - b.order)) {
    if (!isBaseColor(t)) continue;
    const info = colorInfo(t.value);
    if (!info) continue;
    const parent = t.path.slice(0, -1).join('.');
    const list = groups.get(parent) ?? [];
    list.push({ token: t, step: t.path.at(-1)!, info });
    groups.set(parent, list);
  }

  const palettes: Palette[] = [];
  const loose: Swatch[] = [];
  for (const [id, swatches] of groups) {
    const ordered = orderSteps(swatches, (s) => s.step);
    const isScale = swatches.length >= 3 || (swatches.length >= 2 && ordered.kind !== 'file');
    if (!isScale) {
      loose.push(...swatches);
      continue;
    }
    const semantic = id.split('.').find((seg) => SEMANTIC_NAMES.test(seg));
    const included = overrides[id] ?? !semantic;
    const p: Palette = {
      id,
      name: id || '(root)',
      swatches: ordered.items,
      order: ordered.kind,
      direction: 'flat',
      included,
      flags: [],
    };
    if (semantic) p.excludedReason = `The name “${semantic}” suggests semantic colors rather than a base palette.`;
    palettes.push(p);
    p.flags.push(...orderFlags(ordered.kind, ordered.unplaced.map((s) => s.step)));
  }

  checkPalettes(palettes.filter((p) => p.included), gamut);
  return { palettes, loose };
}

function orderFlags(kind: OrderKind, unplaced: string[]): ScaleFlag[] {
  if (kind === 'file') {
    return [{ kind: 'unordered', severity: 'info', message: "Step names don't follow a known scale, so they're shown in file order.", steps: [] }];
  }
  if (unplaced.length) {
    return [{ kind: 'unordered', severity: 'info', message: `${unplaced.map((s) => `“${s}”`).join(', ')} ${unplaced.length === 1 ? "doesn't" : "don't"} fit the scale and ${unplaced.length === 1 ? 'is' : 'are'} shown at the end.`, steps: unplaced }];
  }
  return [];
}
