import { colorInfo, type ColorInfo } from '../color/format';
import type { PaletteSet, Swatch } from '../palette/detect';
import type { End, EndId } from './analyze';

/**
 * The light and dark ends contrast is measured against. By default they are
 * the system's own lightest and darkest neutrals (what text usually sits on),
 * falling back to white and black. The user can pick any base color.
 */

export const WHITE = 'white';
export const BLACK = 'black';

const white = colorInfo({ colorSpace: 'srgb', components: [1, 1, 1] })!;
const black = colorInfo({ colorSpace: 'srgb', components: [0, 0, 0] })!;

const NEUTRAL = /neutral|gr[ae]y|slate|zinc|stone|sand|mono|ink/i;

export interface EndCandidate {
  id: string;
  info: ColorInfo;
}

export type EndChoice = Partial<Record<EndId, string>>;

function allSwatches(set: PaletteSet): Swatch[] {
  return [...set.palettes.filter((p) => p.included).flatMap((p) => p.swatches), ...set.loose];
}

/** Colors offered as ends: white/black plus light (L ≥ 0.8) or dark (L ≤ 0.4) base colors. */
export function endCandidates(set: PaletteSet): Record<EndId, EndCandidate[]> {
  const all = allSwatches(set).map((s) => ({ id: s.token.id, info: s.info }));
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

/** Resolve the user's choice (falling back to defaults when a chosen token is gone). */
export function resolveEnds(set: PaletteSet, choice: EndChoice): Record<EndId, End> {
  const defaults = defaultEnds(set);
  const byId = new Map(allSwatches(set).map((s) => [s.token.id, s.info]));
  const pick = (id: EndId): End => {
    for (const name of [choice[id], defaults[id]]) {
      if (name === WHITE) return { id, name, info: white };
      if (name === BLACK) return { id, name, info: black };
      if (name && byId.has(name)) return { id, name, info: byId.get(name)! };
    }
    return { id, name: id === 'light' ? WHITE : BLACK, info: id === 'light' ? white : black };
  };
  return { light: pick('light'), dark: pick('dark') };
}
