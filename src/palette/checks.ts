import { distance, lch, type Gamut } from '../color/format';
import type { Direction, Palette, Swatch } from './detect';

/**
 * Checks on the logic of each scale, in OKLCH: does lightness move one way,
 * are neighbours distinguishable, is the hue stable, are lightness gaps even,
 * do palettes share the same steps, are colors inside the target gamut.
 * These are design observations shown with the palette, not DTCG errors.
 */

export type FlagKind = 'inversion' | 'near-duplicate' | 'hue-drift' | 'uneven-lightness' | 'unordered' | 'missing-steps' | 'outside-gamut' | 'p3';

export interface ScaleFlag {
  kind: FlagKind;
  severity: 'warning' | 'info';
  message: string;
  /** Steps the flag is about, for highlighting. */
  steps: string[];
}

/** Lightness changes smaller than this (0–1 scale) count as flat. */
const L_EPS = 0.005;
/** Neighbours closer than this ΔE (OKLab) are hard to tell apart. */
const NEAR_DUPLICATE = 0.02;
/** Hue spread (degrees) across a scale worth mentioning. */
const HUE_DRIFT = 30;
/** Below this chroma a hue is too unstable to judge drift. */
const CHROMATIC = 0.04;

const pct = (l: number) => (l * 100).toFixed(1);

export function checkPalettes(palettes: Palette[], gamut: Gamut) {
  for (const p of palettes) {
    const placed = p.swatches.filter((s) => !p.flags.some((f) => f.kind === 'unordered' && f.steps.includes(s.step)));
    const ordered = p.order !== 'file';
    p.direction = direction(placed);
    if (ordered) {
      p.flags.push(...inversions(placed, p.direction));
      p.flags.push(...unevenLightness(placed));
    }
    p.flags.push(...nearDuplicates(ordered ? placed : p.swatches));
    if (ordered) p.flags.push(...hueDrift(placed));
    p.flags.push(...gamutFlags(p.swatches, gamut));
  }
  missingSteps(palettes.filter((p) => p.order === 'numeric'));
}

function direction(s: Swatch[]): Direction {
  let down = 0;
  let up = 0;
  for (let i = 1; i < s.length; i++) {
    const d = s[i]!.info.oklch.l - s[i - 1]!.info.oklch.l;
    if (d < -L_EPS) down++;
    else if (d > L_EPS) up++;
  }
  return down > up ? 'light-to-dark' : up > down ? 'dark-to-light' : 'flat';
}

function inversions(s: Swatch[], dir: Direction) {
  if (dir === 'flat') return [];
  const wrongWay = dir === 'light-to-dark' ? (d: number) => d > L_EPS : (d: number) => d < -L_EPS;
  const flags: ScaleFlag[] = [];
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1]!;
    const b = s[i]!;
    if (!wrongWay(b.info.oklch.l - a.info.oklch.l)) continue;
    flags.push({
      kind: 'inversion',
      severity: 'warning',
      message: `Lightness goes the wrong way from ${a.step} to ${b.step} (L ${pct(a.info.oklch.l)} → ${pct(b.info.oklch.l)}); the scale otherwise runs ${dir === 'light-to-dark' ? 'light to dark' : 'dark to light'}.`,
      steps: [a.step, b.step],
    });
  }
  return flags;
}

function nearDuplicates(s: Swatch[]) {
  const flags: ScaleFlag[] = [];
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1]!;
    const b = s[i]!;
    const d = distance(a.info, b.info);
    if (d >= NEAR_DUPLICATE) continue;
    flags.push({
      kind: 'near-duplicate',
      severity: 'warning',
      message: d === 0 ? `${a.step} and ${b.step} are the same color.` : `${a.step} and ${b.step} are nearly identical (ΔE ${d.toFixed(3)}).`,
      steps: [a.step, b.step],
    });
  }
  return flags;
}

function hueDrift(s: Swatch[]) {
  const chromatic = s.filter((x) => x.info.oklch.c >= CHROMATIC && !Number.isNaN(x.info.oklch.h));
  if (chromatic.length < 3) return [];
  // Unwrap hues around the first one so 350° and 10° are 20° apart.
  const ref = chromatic[0]!.info.oklch.h;
  const rel = chromatic.map((x) => ({ x, d: ((((x.info.oklch.h - ref) % 360) + 540) % 360) - 180 }));
  const min = rel.reduce((a, b) => (b.d < a.d ? b : a));
  const max = rel.reduce((a, b) => (b.d > a.d ? b : a));
  const spread = max.d - min.d;
  if (spread <= HUE_DRIFT) return [];
  return [
    {
      kind: 'hue-drift' as const,
      severity: 'info' as const,
      message: `Hue shifts ${spread.toFixed(0)}° across the scale (${lch(min.x.info).h}° at ${min.x.step}, ${lch(max.x.info).h}° at ${max.x.step}). Fine if intended.`,
      steps: [min.x.step, max.x.step],
    },
  ];
}

function unevenLightness(s: Swatch[]) {
  if (s.length < 4) return [];
  const gaps = s.slice(1).map((b, i) => ({ a: s[i]!, b, d: Math.abs(b.info.oklch.l - s[i]!.info.oklch.l) }));
  const sorted = [...gaps].map((g) => g.d).sort((x, y) => x - y);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const widest = gaps.reduce((x, y) => (y.d > x.d ? y : x));
  if (median < L_EPS || widest.d < 2.5 * median || widest.d - median < 0.05) return [];
  return [
    {
      kind: 'uneven-lightness' as const,
      severity: 'info' as const,
      message: `Lightness steps are uneven: ${widest.a.step} → ${widest.b.step} jumps ΔL ${pct(widest.d)}, while a typical step is ΔL ${pct(median)}.`,
      steps: [widest.a.step, widest.b.step],
    },
  ];
}

function gamutFlags(s: Swatch[], gamut: Gamut) {
  const flags: ScaleFlag[] = [];
  const list = (xs: Swatch[]) => xs.map((x) => x.step).join(', ');
  if (gamut === 'srgb') {
    const out = s.filter((x) => !x.info.inSrgb);
    if (out.length) {
      flags.push({
        kind: 'outside-gamut',
        severity: 'warning',
        message: `${out.length === 1 ? `${list(out)} is` : `${list(out)} are`} outside sRGB, so ${out.length === 1 ? 'it is' : 'they are'} shown mapped into sRGB. Switch the target gamut to Display P3 if that's intended.`,
        steps: out.map((x) => x.step),
      });
    }
  } else {
    const beyond = s.filter((x) => !x.info.inP3);
    const p3 = s.filter((x) => x.info.inP3 && !x.info.inSrgb);
    if (beyond.length) {
      flags.push({
        kind: 'outside-gamut',
        severity: 'warning',
        message: `${beyond.length === 1 ? `${list(beyond)} is` : `${list(beyond)} are`} outside even Display P3, so ${beyond.length === 1 ? 'it is' : 'they are'} shown mapped.`,
        steps: beyond.map((x) => x.step),
      });
    }
    if (p3.length) {
      flags.push({
        kind: 'p3',
        severity: 'info',
        message: `${p3.length === 1 ? `${list(p3)} uses` : `${list(p3)} use`} Display P3 colors outside sRGB. Screens without P3 will show ${p3.length === 1 ? 'it' : 'them'} less saturated.`,
        steps: p3.map((x) => x.step),
      });
    }
  }
  return flags;
}

/**
 * Numeric palettes usually share step names. The full-length scales define
 * the standard set; palettes on the same numbering that lack some of those
 * steps are pointed out. Short palettes on another scheme are left alone.
 */
function missingSteps(palettes: Palette[]) {
  const size = (p: Palette) => p.swatches.length;
  const max = Math.max(0, ...palettes.map(size));
  const full = palettes.filter((p) => size(p) >= 0.7 * max);
  if (full.length < 2) return;
  const count = new Map<string, number>();
  for (const p of full) for (const s of new Set(p.swatches.map((x) => x.step))) count.set(s, (count.get(s) ?? 0) + 1);
  const standard = [...count].filter(([, n]) => n > full.length / 2).map(([s]) => s);
  if (standard.length < 3) return;
  const order = new Map(full[0]!.swatches.map((x, i) => [x.step, i]));
  standard.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  for (const p of palettes) {
    const own = new Set(p.swatches.map((x) => x.step));
    if (standard.filter((s) => own.has(s)).length < standard.length / 2) continue;
    const missing = standard.filter((s) => !own.has(s));
    if (!missing.length) continue;
    p.flags.push({ kind: 'missing-steps', severity: 'info', message: `Missing ${missing.join(', ')}, which the other full palettes have.`, steps: [] });
  }
}
