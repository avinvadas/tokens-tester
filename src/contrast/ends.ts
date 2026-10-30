import { ColorSpace, inGamut, to, toGamut } from 'colorjs.io/fn';
import { infoFrom, type ColorInfo, type Gamut } from '../color/format';
import type { Palette, PaletteSet, Swatch } from '../palette/detect';
import type { End, EndId } from './analyze';

/**
 * The light and dark ends contrast is measured against. Each global end is a
 * neutral token, picked by name: by default the system's lightest and darkest
 * neutral. Only its lightness is used, so the end itself has no chroma. Each
 * palette then gets its own ends at the same lightness, tinted with its hue
 * (see rowEnds). A system without neutral tokens falls back to pure white and
 * black.
 */

/** The token id the user picked for each global end. */
export type EndChoice = Partial<Record<EndId, string>>;

export const WHITE = 'white';
export const BLACK = 'black';

const NEUTRAL = /neutral|gr[ae]y|slate|zinc|stone|sand|mono|ink/i;

/** Chroma below which a loose color is neutral enough to be an end. */
export const NEUTRAL_CHROMA = 0.02;
/** A palette whose most colorful step stays below this is a neutral (gray) palette. */
const NEUTRAL_PALETTE = 0.04;

/** Named gray scales (slate, zinc…) often carry a slight tint, so they get more room. */
const NAMED_NEUTRAL_PALETTE = 0.08;

const isNeutralPalette = (p: Palette) => {
  const c = Math.max(...p.swatches.map((s) => s.info.oklch.c));
  return c < NEUTRAL_PALETTE || (c < NAMED_NEUTRAL_PALETTE && p.id.split('.').some((seg) => NEUTRAL.test(seg)));
};
const neutralPalettes = (set: PaletteSet) => set.palettes.filter((p) => p.included && p.swatches.length && isNeutralPalette(p));
const neutralLoose = (set: PaletteSet) => set.loose.filter((s) => s.info.oklch.c < NEUTRAL_CHROMA);

/** An achromatic color at lightness `l` (0–1). */
export function level(l: number): ColorInfo {
  return infoFrom({ space: ColorSpace.get('oklch'), coords: [l, 0, 0], alpha: 1 });
}

export interface EndCandidate {
  id: string;
  l: number;
  /** The token's own color, for its thumbnail. */
  info: ColorInfo;
}

/** A group of end candidates: one neutral scale, or the loose neutral colors. */
export interface EndGroup {
  label: string;
  tokens: EndCandidate[];
}

/**
 * Tokens that can be a global end, the same for both ends: every step of each
 * neutral scale (in scale order), and loose neutral colors. A pale step of a
 * colored palette (blue 50) is not neutral, however little chroma it has.
 */
export function endCandidates(set: PaletteSet): EndGroup[] {
  const cand = (s: Swatch): EndCandidate => ({ id: s.token.id, l: s.info.oklch.l, info: s.info });
  const loose = neutralLoose(set).map(cand);
  return [
    ...neutralPalettes(set).map((p) => ({ label: p.name, tokens: p.swatches.map(cand) })),
    ...(loose.length ? [{ label: 'Other colors', tokens: loose.sort((a, b) => b.l - a.l) }] : []),
  ];
}

/** The system's lightest and darkest neutral token, otherwise white and black. */
export function defaultEnds(set: PaletteSet): Record<EndId, string> {
  const included = set.palettes.filter((p) => p.included && p.swatches.length >= 5);
  const meanChroma = (sw: Swatch[]) => sw.reduce((n, s) => n + s.info.oklch.c, 0) / sw.length;
  const neutral =
    included.find((p) => p.id.split('.').some((seg) => NEUTRAL.test(seg)) && isNeutralPalette(p)) ??
    included.filter((p) => meanChroma(p.swatches) < 0.03).sort((a, b) => range(b.swatches) - range(a.swatches))[0];
  const pool = neutral ? neutral.swatches.map((s) => ({ id: s.token.id, l: s.info.oklch.l })) : endCandidates(set).flatMap((g) => g.tokens);
  if (pool.length < 2) return { light: WHITE, dark: BLACK };
  const byL = [...pool].sort((a, b) => b.l - a.l);
  return { light: byL[0]!.id, dark: byL.at(-1)!.id };
}

const range = (sw: Swatch[]) => Math.max(...sw.map((s) => s.info.oklch.l)) - Math.min(...sw.map((s) => s.info.oklch.l));

/**
 * The global ends: the picked tokens, or the defaults when a pick is gone,
 * not neutral, or not on its side of the other end. Only the token's
 * lightness is kept.
 */
export function resolveEnds(set: PaletteSet, choice: EndChoice): Record<EndId, End> {
  const known = new Map(endCandidates(set).flatMap((g) => g.tokens.map((t) => [t.id, t.l] as const)));
  known.set(WHITE, 1).set(BLACK, 0);
  const d = defaultEnds(set);
  const pick = (id: EndId) => (choice[id] !== undefined && known.has(choice[id]!) ? choice[id]! : d[id]);
  let light = pick('light');
  let dark = pick('dark');
  if (known.get(light)! <= known.get(dark)!) [light, dark] = known.get(d.light)! > known.get(d.dark)! ? [d.light, d.dark] : [WHITE, BLACK];
  const end = (id: EndId, name: string): End => ({ id, name, info: level(known.get(name)!) });
  return { light: end('light', light), dark: end('dark', dark) };
}

/**
 * A palette's own ends: the global ends' lightness, tinted with the palette's
 * hue. The tint continues the palette toward white or black: the chroma of
 * its lightest (or darkest) step, scaled by how much of the remaining way to
 * white (or black) the end covers. A neutral palette gets the global ends
 * unchanged.
 */
export function rowEnds(p: Palette, global: Record<EndId, End>, gamut: Gamut): Record<EndId, End> {
  if (!p.swatches.length || isNeutralPalette(p)) return global;
  const byL = [...p.swatches].sort((a, b) => b.info.oklch.l - a.info.oklch.l);
  // The palette's hue where its own outermost step has none (a pure white or black step).
  const vivid = [...p.swatches].sort((a, b) => b.info.oklch.c - a.info.oklch.c)[0]!.info.oklch.h;
  const derive = (id: EndId): End => {
    const g = global[id];
    const near = (id === 'light' ? byL[0] : byL.at(-1))!.info.oklch;
    const hue = Number.isNaN(near.h) ? vivid : near.h;
    const l = g.info.oklch.l;
    const share = id === 'light' ? (1 - l) / Math.max(1e-6, 1 - near.l) : l / Math.max(1e-6, near.l);
    const c = Math.min(1, Math.max(0, share)) * near.c;
    let color = { space: ColorSpace.get('oklch'), coords: [l, c, hue] as [number, number, number], alpha: 1 };
    const space = gamut === 'p3' ? 'p3' : 'srgb';
    if (!inGamut(color, space, { epsilon: 0.0005 })) color = to(toGamut(to(color, space), { method: 'css' }), 'oklch') as typeof color;
    return { id, name: `${id} end`, info: infoFrom(color) };
  };
  return { light: derive('light'), dark: derive('dark') };
}

/**
 * The palette within the system's range: without steps lighter than the
 * light end or darker than the dark end. The ends bound every row, so steps
 * past them are left out of the grid and its checks (they stay in the file).
 * With pure white and black ends nothing is ever past them.
 */
export function withinEnds(p: Palette, ends: Record<EndId, End>): Palette {
  const swatches = p.swatches.filter((s) => !beyond(s, ends));
  return swatches.length === p.swatches.length ? p : { ...p, swatches };
}

/** Steps of `p` past the ends, with the end they are past. */
export function beyondEnds(p: Palette, ends: Record<EndId, End>): { step: string; end: EndId }[] {
  return p.swatches.flatMap((s) => {
    const end = beyond(s, ends);
    return end ? [{ step: s.step, end }] : [];
  });
}

const EPS = 1e-4;
function beyond(s: Swatch, ends: Record<EndId, End>): EndId | undefined {
  const l = s.info.oklch.l;
  if (l > ends.light.info.oklch.l + EPS) return 'light';
  if (l < ends.dark.info.oklch.l - EPS) return 'dark';
  return undefined;
}
