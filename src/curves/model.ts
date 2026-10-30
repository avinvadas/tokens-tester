import { ColorSpace, inGamut, to, toGamut, type PlainColorObject } from 'colorjs.io/fn';
import { fromColorJs } from '../color/dtcg';
import { infoFrom, type ColorInfo, type Gamut } from '../color/format';
import type { End } from '../contrast/analyze';
import type { Level } from '../contrast/levels';
import { contrast } from '../contrast/metrics';
import type { Edit } from '../model/types';
import type { Palette } from '../palette/detect';
import { interpolate, type Point } from './spline';

/**
 * The curve editor's model. A palette's steps sit at positions t = 0…1 in
 * scale order. Lightness, chroma and hue are each a curve through handles;
 * the generated palette is the curves evaluated at every step, mapped into
 * the target gamut. One step is the anchor, the step in focus. A row has at
 * most one pin, on its anchor: a pinned step keeps its color whatever the
 * curves do, and every curve passes through it. Without a pin the curves
 * run freely.
 *
 * Hue is stored unwrapped around the anchor (anchor 350°, a step at 10° is
 * stored as 370°) so curves never jump across 0°.
 */

export type Channel = 'l' | 'c' | 'h';

export interface Curve {
  points: Point[];
  smooth: boolean;
}

export interface Lch {
  l: number;
  c: number;
  h: number;
}

/** The pinned step and the color it is held at. */
export interface Hold {
  index: number;
  color: Lch;
}

export interface CurveState {
  /** Index of the anchor: the step in focus. */
  anchor: number;
  /** The anchor's color: held there when pinned, otherwise what the curves give. */
  anchorColor: Lch;
  /** Whether the anchor is pinned. */
  pinned: boolean;
  curves: Record<Channel, Curve>;
  /** Other palettes the same curves are applied to. */
  batch: string[];
  /** Batch lightness: the same L at the same step (match), or shifted with each palette's anchor (relative). */
  lightness: 'match' | 'relative';
}

export interface GenStep {
  step: string;
  t: number;
  /** What the curves asked for. */
  wanted: Lch;
  /** After gamut mapping. */
  info: ColorInfo;
  /** True when the color had to be mapped into the gamut (chroma reduced). */
  mapped: boolean;
}

const EPS = 1e-6;
export const C_MAX = 0.4;

export const positions = (p: Palette) => p.swatches.map((_, i) => (p.swatches.length > 1 ? i / (p.swatches.length - 1) : 0));

/** "500" when the scale has one, otherwise the most saturated step. */
export function defaultAnchor(p: Palette): number {
  const i500 = p.swatches.findIndex((s) => s.step === '500');
  if (i500 !== -1) return i500;
  let best = 0;
  p.swatches.forEach((s, i) => {
    if (s.info.oklch.c > p.swatches[best]!.info.oklch.c) best = i;
  });
  return best;
}

/** Hue of `h` moved by whole turns to lie within 180° of `base`. NaN (grey) takes the base hue. */
export const unwrap = (h: number, base: number) => (Number.isNaN(h) ? base : base + ((((h - base) % 360) + 540) % 360) - 180);

const baseHue = (p: Palette, anchor: number) => {
  const a = p.swatches[anchor]!.info.oklch.h;
  if (!Number.isNaN(a)) return a;
  return p.swatches.find((s) => !Number.isNaN(s.info.oklch.h))?.info.oklch.h ?? 0;
};

/** Curves through every step's current value: generating from them reproduces the palette. */
export function currentCurves(p: Palette, anchor: number): Record<Channel, Curve> {
  const t = positions(p);
  const base = baseHue(p, anchor);
  return {
    l: { smooth: true, points: p.swatches.map((s, i) => ({ t: t[i]!, v: s.info.oklch.l })) },
    c: { smooth: true, points: p.swatches.map((s, i) => ({ t: t[i]!, v: s.info.oklch.c })) },
    h: { smooth: true, points: p.swatches.map((s, i) => ({ t: t[i]!, v: unwrap(s.info.oklch.h, base) })) },
  };
}

/** The palette as it is, pinned on `pin` (default: the default anchor; null: no pin). */
export function initialState(p: Palette, pin: number | null = defaultAnchor(p)): CurveState {
  const anchor = pin ?? defaultAnchor(p);
  const curves = currentCurves(p, anchor);
  const base = baseHue(p, anchor);
  const colorAt = (i: number): Lch => {
    const o = p.swatches[i]!.info.oklch;
    return { l: o.l, c: o.c, h: unwrap(o.h, base) };
  };
  return {
    anchor,
    anchorColor: colorAt(anchor),
    pinned: pin !== null,
    curves,
    batch: [],
    lightness: 'match',
  };
}

export const evaluate = (curve: Curve) => interpolate(curve.points, curve.smooth);

/** Points with duplicate positions merged (later wins), sorted. */
function normalize(points: Point[]): Point[] {
  const byT = new Map<number, Point>();
  for (const p of points) byT.set(Math.round(p.t * 1e6) / 1e6, { t: p.t, v: p.v });
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

export const anchorT = (p: Palette, s: CurveState) => positions(p)[s.anchor]!;

/** The pinned step with its color, if any. */
export function pins(s: CurveState): Hold[] {
  return s.pinned ? [{ index: s.anchor, color: s.anchorColor }] : [];
}

/** Pin each curve to the pinned step's color at its position. */
export function pinAnchor(p: Palette, s: CurveState): CurveState {
  const t = positions(p);
  const held = pins(s).map((x) => ({ t: t[x.index]!, color: x.color }));
  const pin = (c: Curve, ch: Channel): Curve => ({
    ...c,
    points: normalize([...c.points.filter((q) => held.every((x) => Math.abs(q.t - x.t) > EPS)), ...held.map((x) => ({ t: x.t, v: x.color[ch] }))]),
  });
  return { ...s, curves: { l: pin(s.curves.l, 'l'), c: pin(s.curves.c, 'c'), h: pin(s.curves.h, 'h') } };
}

/**
 * Set the anchor's color and pin it there. A pinned anchor is fixed: it
 * keeps its color until it is unpinned.
 */
export function setAnchorColor(p: Palette, s: CurveState, color: Partial<Lch>): CurveState {
  if (s.pinned) return s;
  const anchorColor = {
    l: clamp(color.l ?? s.anchorColor.l, 0, 1),
    c: clamp(color.c ?? s.anchorColor.c, 0, C_MAX),
    h: color.h !== undefined ? unwrap(color.h, s.anchorColor.h) : s.anchorColor.h,
  };
  return pinAnchor(p, { ...s, anchorColor, pinned: true });
}

const curveColor = (s: CurveState, t: number): Lch => ({ l: evaluate(s.curves.l)(t), c: evaluate(s.curves.c)(t), h: evaluate(s.curves.h)(t) });

/**
 * Move the anchor to another step. A pinned anchor carries its pin along: the
 * step it leaves is free again, the step it reaches is held at the color it
 * has now.
 */
export function setAnchorStep(p: Palette, s: CurveState, index: number): CurveState {
  if (index === s.anchor) return s;
  return pinAnchor(p, { ...s, anchor: index, anchorColor: curveColor(s, positions(p)[index]!) });
}

/**
 * Pin or unpin a step. A row has one pin at most: pinning a step moves the
 * pin there, held at the color the step has now.
 */
export function togglePin(p: Palette, s: CurveState, index: number): CurveState {
  if (index === s.anchor) return pinAnchor(p, { ...s, pinned: !s.pinned, anchorColor: s.pinned ? s.anchorColor : curveColor(s, positions(p)[index]!) });
  return pinAnchor(p, { ...s, anchor: index, pinned: true, anchorColor: curveColor(s, positions(p)[index]!) });
}

// ---------------------------------------------------------------------------
// Presets

export type LPreset = 'current' | 'linear' | 'ease';
export type CPreset = 'current' | 'bell' | 'flat';
export type HPreset = 'current' | 'constant' | 'shift';

/** A curve from `first` to `last` through every pin (a pin on an end wins over it). */
function threePoint(p: Palette, s: CurveState, ch: Channel, first: number, last: number, smooth: boolean): Curve {
  const t = positions(p);
  return { smooth, points: normalize([{ t: 0, v: first }, { t: 1, v: last }, ...pins(s).map((x) => ({ t: t[x.index]!, v: x.color[ch] }))]) };
}

export function presetL(p: Palette, s: CurveState, kind: LPreset): CurveState {
  if (kind === 'current') return pinAnchor(p, { ...s, curves: { ...s.curves, l: currentCurves(p, s.anchor).l } });
  const f = evaluate(s.curves.l);
  return { ...s, curves: { ...s.curves, l: threePoint(p, s, 'l', f(0), f(1), kind === 'ease') } };
}

export function presetC(p: Palette, s: CurveState, kind: CPreset): CurveState {
  if (kind === 'current') return pinAnchor(p, { ...s, curves: { ...s.curves, c: currentCurves(p, s.anchor).c } });
  const cA = s.anchorColor.c;
  // A bell: chroma peaks at the anchor; light tints carry less than deep shades.
  const curve = kind === 'bell' ? threePoint(p, s, 'c', cA * 0.15, cA * 0.45, true) : threePoint(p, s, 'c', cA, cA, false);
  return { ...s, curves: { ...s.curves, c: curve } };
}

/** `shift`: degrees the hue turns from the anchor toward the last step (and the opposite way toward the first). */
export function presetH(p: Palette, s: CurveState, kind: HPreset, shift = 0): CurveState {
  if (kind === 'current') return pinAnchor(p, { ...s, curves: { ...s.curves, h: currentCurves(p, s.anchor).h } });
  const hA = s.anchorColor.h;
  const d = kind === 'shift' ? shift : 0;
  return { ...s, curves: { ...s.curves, h: threePoint(p, s, 'h', hA - d, hA + d, kind === 'shift') } };
}

// ---------------------------------------------------------------------------
// Generation

const OKLCH = () => ColorSpace.get('oklch');

function makeColor(l: number, c: number, h: number, alpha: number): PlainColorObject {
  return { space: OKLCH(), coords: [clamp(l, 0, 1), Math.max(0, c), (((h % 360) + 360) % 360)], alpha };
}

/** The color mapped into the gamut (CSS Color 4 method), and whether that changed it. */
export function fit(color: PlainColorObject, gamut: Gamut): { color: PlainColorObject; mapped: boolean } {
  const space = gamut === 'p3' ? 'p3' : 'srgb';
  if (inGamut(color, space, { epsilon: 0.0005 })) return { color, mapped: false };
  return { color: to(toGamut(to(color, space), { method: 'css' }), 'oklch'), mapped: true };
}

export function generate(p: Palette, s: CurveState, gamut: Gamut): GenStep[] {
  const t = positions(p);
  const [fl, fc, fh] = [evaluate(s.curves.l), evaluate(s.curves.c), evaluate(s.curves.h)];
  return p.swatches.map((sw, i) => step(sw, t[i]!, { l: clamp(fl(t[i]!), 0, 1), c: clamp(fc(t[i]!), 0, C_MAX), h: fh(t[i]!) }, gamut));
}

/**
 * One generated step. A step the curves leave where it is keeps its exact
 * original color: editing other steps never re-maps or rounds it.
 */
function step(sw: Palette['swatches'][number], t: number, wanted: Lch, gamut: Gamut): GenStep {
  const o = sw.info.oklch;
  const dh = Number.isNaN(o.h) ? 0 : Math.abs(((((wanted.h - o.h) % 360) + 540) % 360) - 180);
  if (Math.abs(wanted.l - o.l) < 1e-6 && Math.abs(wanted.c - o.c) < 1e-6 && (dh < 1e-4 || o.c < 0.002)) {
    return { step: sw.step, t, wanted, info: sw.info, mapped: false };
  }
  const { color, mapped } = fit(makeColor(wanted.l, wanted.c, wanted.h, o.alpha), gamut);
  return { step: sw.step, t, wanted, info: infoFrom(color), mapped };
}

/** Largest chroma at lightness `l` and hue `h` that fits the gamut. */
export function maxChroma(l: number, h: number, gamut: Gamut): number {
  const space = gamut === 'p3' ? 'p3' : 'srgb';
  let lo = 0;
  let hi = C_MAX;
  for (let k = 0; k < 18; k++) {
    const mid = (lo + hi) / 2;
    if (inGamut(makeColor(l, mid, h, 1), space, { epsilon: 0.0005 })) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Apply the source palette's curves to another palette. Positions match by
 * step name where the names are shared, by index otherwise. Chroma scales and
 * hue shifts with each palette's own anchor; lightness either matches the
 * source exactly (same contrast at the same step) or shifts with the anchor.
 * The target's own pinned step (`keep`) stays as it is.
 */
export function generateFor(target: Palette, source: Palette, s: CurveState, gamut: Gamut, keep?: string): GenStep[] {
  const srcT = new Map(source.swatches.map((sw, i) => [sw.step, positions(source)[i]!]));
  const tgtPos = positions(target);
  const t = target.swatches.map((sw, i) => srcT.get(sw.step) ?? tgtPos[i]!);
  const tA = anchorT(source, s);
  const own = target.swatches.findIndex((sw) => sw.step === source.swatches[s.anchor]!.step);
  const ownAnchor = own !== -1 ? own : t.reduce((best, x, i) => (Math.abs(x - tA) < Math.abs(t[best]! - tA) ? i : best), 0);
  const a = target.swatches[ownAnchor]!.info.oklch;
  const [fl, fc, fh] = [evaluate(s.curves.l), evaluate(s.curves.c), evaluate(s.curves.h)];
  const chromaScale = s.anchorColor.c > 1e-4 ? a.c / s.anchorColor.c : 1;
  const hueBase = Number.isNaN(a.h) ? s.anchorColor.h : a.h;
  return target.swatches.map((sw, i) => {
    const x = t[i]!;
    if (sw.step === keep) return { step: sw.step, t: x, wanted: { l: sw.info.oklch.l, c: sw.info.oklch.c, h: sw.info.oklch.h }, info: sw.info, mapped: false };
    const l = s.lightness === 'match' ? fl(x) : a.l + fl(x) - fl(tA);
    return step(sw, x, { l: clamp(l, 0, 1), c: clamp(fc(x) * chromaScale, 0, C_MAX), h: hueBase + fh(x) - fh(tA) }, gamut);
  });
}

// ---------------------------------------------------------------------------
// Contrast-targeted lightness

export interface ContrastTarget {
  /** Step index that should just pass. */
  index: number;
  end: End;
}

/**
 * Lightness for a step so it just passes `level` against `end` (as text on
 * it), keeping the curves' chroma and hue there. The light end is passed by
 * going darker, the dark end by going lighter. Undefined when unreachable.
 */
export function solveL(c: number, h: number, alpha: number, end: End, level: Level, gamut: Gamut): number | undefined {
  const target = level.metric === 'wcag' ? level.threshold * 1.01 : level.threshold + 1;
  const passes = (l: number) => contrast(infoFrom(fit(makeColor(l, c, h, alpha), gamut).color), end.info, level.metric) >= target;
  const endL = end.info.oklch.l;
  const darker = end.id === 'light';
  let pass = darker ? 0 : 1;
  let fail = endL;
  if (!passes(pass)) return undefined;
  for (let k = 0; k < 24; k++) {
    const mid = (pass + fail) / 2;
    if (passes(mid)) pass = mid;
    else fail = mid;
  }
  return pass;
}

/** An L curve through the endpoints, the anchor and each target step at its solved lightness. */
export function contrastTargetedL(p: Palette, s: CurveState, targets: ContrastTarget[], level: Level, gamut: Gamut): { state: CurveState; notes: string[] } {
  const t = positions(p);
  const [fl, fc, fh] = [evaluate(s.curves.l), evaluate(s.curves.c), evaluate(s.curves.h)];
  const notes: string[] = [];
  const points: Point[] = [
    { t: 0, v: fl(0) },
    { t: 1, v: fl(1) },
  ];
  for (const target of targets) {
    const x = t[target.index]!;
    const step = p.swatches[target.index]!.step;
    if (pins(s).some((x) => x.index === target.index)) {
      notes.push(`${step} is pinned, so its lightness stays as set.`);
      continue;
    }
    const l = solveL(fc(x), fh(x), p.swatches[target.index]!.info.oklch.alpha, target.end, level, gamut);
    if (l === undefined) {
      notes.push(`${step} can't reach ${level.short} against ${target.end.name} at this chroma and hue.`);
      continue;
    }
    points.push({ t: x, v: l });
  }
  for (const x of pins(s)) points.push({ t: t[x.index]!, v: x.color.l });
  const sorted = normalize(points);
  // Lightness must keep one direction; report a target that breaks it.
  const dir = Math.sign(sorted.at(-1)!.v - sorted[0]!.v);
  for (let i = 1; i < sorted.length; i++) {
    if (dir !== 0 && Math.sign(sorted[i]!.v - sorted[i - 1]!.v) === -dir) {
      notes.push('The targets and the pins ask for lightness to reverse direction; move a pin or a target step.');
      break;
    }
  }
  return { state: { ...s, curves: { ...s.curves, l: { smooth: true, points: sorted } } }, notes };
}

// ---------------------------------------------------------------------------
// Writing back

/** Edits that write generated colors into each step's token, in the color space it already used. */
export function toEdits(p: Palette, gen: GenStep[]): Edit[] {
  const edits: Edit[] = [];
  gen.forEach((g, i) => {
    const sw = p.swatches[i]!;
    if (sw.derived || sameColor(sw.info, g.info)) return;
    const t = sw.token;
    edits.push({ fileId: t.fileId, path: [...t.keyPath, ...t.valuePath], value: fromColorJs(g.info.source, t.rawValue as never) });
  });
  return edits;
}

/** Visually identical: tiny OKLCH differences from round trips don't count as edits. */
export function sameColor(a: ColorInfo, b: ColorInfo): boolean {
  const x = a.oklch;
  const y = b.oklch;
  const dh = Number.isNaN(x.h) || Number.isNaN(y.h) ? 0 : Math.abs(((((x.h - y.h) % 360) + 540) % 360) - 180);
  return Math.abs(x.l - y.l) < 5e-4 && Math.abs(x.c - y.c) < 5e-4 && (dh < 0.05 || Math.min(x.c, y.c) < 0.002) && Math.abs(x.alpha - y.alpha) < 1e-3;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
