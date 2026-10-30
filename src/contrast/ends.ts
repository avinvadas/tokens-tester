import { ColorSpace, inGamut, to, toGamut } from 'colorjs.io/fn';
import { colorInfo, infoFrom, type ColorInfo, type Gamut } from '../color/format';
import type { Palette, PaletteSet, Swatch } from '../palette/detect';
import type { End, EndId } from './analyze';

/**
 * The light and dark ends contrast is measured against. The global ends are
 * neutral: by default the system's own lightest and darkest neutrals (what
 * text usually sits on), falling back to white and black; the user can pick
 * any other neutral. Each palette then gets its own ends at the same
 * lightness, tinted with its hue (see rowEnds).
 */

export const WHITE = 'white';
export const BLACK = 'black';

const white = colorInfo({ colorSpace: 'srgb', components: [1, 1, 1] })!;
const black = colorInfo({ colorSpace: 'srgb', components: [0, 0, 0] })!;

const NEUTRAL = /neutral|gr[ae]y|slate|zinc|stone|sand|mono|ink/i;

/** Chroma below which a color is neutral enough to be a system-wide end. */
export const NEUTRAL_CHROMA = 0.02;
/** A palette whose most colorful step stays below this is a neutral (gray) palette. */
const NEUTRAL_PALETTE = 0.04;

const isNeutralPalette = (p: Palette) => Math.max(...p.swatches.map((s) => s.info.oklch.c)) < NEUTRAL_PALETTE;

/**
 * Colors that can serve as global ends: low-chroma steps of neutral palettes
 * and low-chroma loose colors. A pale step of a colored palette (blue 50) is
 * not neutral, however little chroma it has: it carries that palette's hue.
 */
function neutralSwatches(set: PaletteSet): Swatch[] {
  return [...set.palettes.filter((p) => p.included && isNeutralPalette(p)).flatMap((p) => p.swatches), ...set.loose].filter(
    (s) => s.info.oklch.c < NEUTRAL_CHROMA,
  );
}

export interface EndCandidate {
  id: string;
  info: ColorInfo;
}

export type EndChoice = Partial<Record<EndId, string>>;

function allSwatches(set: PaletteSet): Swatch[] {
  return [...set.palettes.filter((p) => p.included).flatMap((p) => p.swatches), ...set.loose];
}

/** Colors offered as global ends: white/black plus light (L ≥ 0.8) or dark (L ≤ 0.4) neutral base colors. */
export function endCandidates(set: PaletteSet): Record<EndId, EndCandidate[]> {
  const all = neutralSwatches(set).map((s) => ({ id: s.token.id, info: s.info }));
  return {
    light: [{ id: WHITE, info: white }, ...all.filter((c) => c.info.oklch.l >= 0.8).sort((a, b) => b.info.oklch.l - a.info.oklch.l)],
    dark: [{ id: BLACK, info: black }, ...all.filter((c) => c.info.oklch.l <= 0.4).sort((a, b) => a.info.oklch.l - b.info.oklch.l)],
  };
}

/** The system's lightest and darkest neutral, if it has a neutral palette or white/black tokens. */
export function defaultEnds(set: PaletteSet): Record<EndId, string> {
  const included = set.palettes.filter((p) => p.included && p.swatches.length >= 5);
  const meanChroma = (sw: Swatch[]) => sw.reduce((n, s) => n + s.info.oklch.c, 0) / sw.length;
  const neutral =
    included.find((p) => p.id.split('.').some((seg) => NEUTRAL.test(seg))) ??
    included.filter((p) => meanChroma(p.swatches) < 0.03).sort((a, b) => range(b.swatches) - range(a.swatches))[0];
  if (neutral) {
    const byL = [...neutral.swatches].sort((a, b) => b.info.oklch.l - a.info.oklch.l);
    return { light: byL[0]!.token.id, dark: byL.at(-1)!.token.id };
  }
  const loose = [...set.loose].sort((a, b) => b.info.oklch.l - a.info.oklch.l);
  const light = loose.find((s) => s.info.oklch.l >= 0.97 && s.info.oklch.c < 0.02);
  const dark = [...loose].reverse().find((s) => s.info.oklch.l <= 0.2 && s.info.oklch.c < 0.02);
  return { light: light?.token.id ?? WHITE, dark: dark?.token.id ?? BLACK };
}

const range = (sw: Swatch[]) => Math.max(...sw.map((s) => s.info.oklch.l)) - Math.min(...sw.map((s) => s.info.oklch.l));

/** Resolve the user's choice (falling back to defaults when a chosen token is gone or not neutral). */
export function resolveEnds(set: PaletteSet, choice: EndChoice): Record<EndId, End> {
  const defaults = defaultEnds(set);
  const all = new Map(allSwatches(set).map((s) => [s.token.id, s.info]));
  const neutral = new Set(neutralSwatches(set).map((s) => s.token.id));
  const pick = (id: EndId): End => {
    for (const [name, chosen] of [[choice[id], true], [defaults[id], false]] as const) {
      if (name === WHITE) return { id, name, info: white };
      if (name === BLACK) return { id, name, info: black };
      const info = name ? all.get(name) : undefined;
      if (info && (!chosen || neutral.has(name!))) return { id, name: name!, info };
    }
    return { id, name: id === 'light' ? WHITE : BLACK, info: id === 'light' ? white : black };
  };
  return { light: pick('light'), dark: pick('dark') };
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
