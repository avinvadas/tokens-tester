import { deltaEOK, inGamut, serialize, to, toGamut, type PlainColorObject } from 'colorjs.io/fn';
import { round, toColorJs } from './dtcg';

/**
 * Display formats and gamut facts for DTCG colors. All math happens in OKLCH
 * through Color.js; sRGB/P3 conversions only happen at the edges (display
 * and hex/rgb output).
 */

export type ColorFormat = 'oklch' | 'hex' | 'rgb';
export type Gamut = 'srgb' | 'p3';

export interface Oklch {
  /** Lightness, 0–1. */
  l: number;
  /** Chroma, 0–~0.4. */
  c: number;
  /** Hue in degrees, NaN for achromatic colors. */
  h: number;
  alpha: number;
}

export interface ColorInfo {
  oklch: Oklch;
  /** The color as a Color.js object in OKLCH. */
  color: PlainColorObject;
  /** The color in the space it was written in; conversions for output start here to avoid round-trip error. */
  source: PlainColorObject;
  inSrgb: boolean;
  inP3: boolean;
}

/** Below this chroma a color is a true grey and has no hue. Tinted near-whites (C ≈ 0.01) keep theirs. */
export const ACHROMATIC = 0.001;

/** Analyze a DTCG color value, or undefined if it isn't a valid one. */
export function colorInfo(v: unknown): ColorInfo | undefined {
  const c = toColorJs(v);
  if (!c) return undefined;
  const ok = to(c, 'oklch');
  const [l, ch, h] = ok.coords.map(Number) as [number, number, number];
  const alpha = Number(ok.alpha ?? 1);
  return {
    oklch: { l: Number.isNaN(l) ? 0 : l, c: Number.isNaN(ch) ? 0 : ch, h: ch < ACHROMATIC ? NaN : h, alpha },
    color: ok,
    source: c,
    // A small epsilon so values written with 4 decimals at the sRGB edge don't count as P3.
    inSrgb: inGamut(c, 'srgb', { epsilon: 0.0005 }),
    inP3: inGamut(c, 'p3', { epsilon: 0.0005 }),
  };
}

export const distance = (a: ColorInfo, b: ColorInfo) => deltaEOK(a.color, b.color);

/** The color mapped into `gamut` (CSS Color 4 method), as a Color.js color in that space. */
export function mapped(info: ColorInfo, gamut: Gamut): PlainColorObject {
  // Color.js returns the same coords array for a same-space conversion, and toGamut mutates; copy first.
  const src = { ...info.source, coords: [...info.source.coords] as [number, number, number] };
  return toGamut(to(src, gamut === 'p3' ? 'p3' : 'srgb'), { method: 'css' });
}

/** CSS color string for painting on a canvas in `gamut`. */
export function paintStyle(info: ColorInfo, gamut: Gamut): string {
  const m = mapped(info, gamut);
  const [r, g, b] = m.coords.map((x) => round(Number.isNaN(x) ? 0 : x, 5));
  const a = Number(m.alpha ?? 1);
  return gamut === 'p3' ? `color(display-p3 ${r} ${g} ${b} / ${a})` : `rgb(${r * 255} ${g * 255} ${b * 255} / ${a})`;
}

export interface Formatted {
  text: string;
  /** True when the shown value is a gamut-mapped approximation (hex/rgb of an out-of-sRGB color). */
  approx: boolean;
}

/** Format a color for display. Hex and rgb() are sRGB; out-of-gamut colors are mapped and marked approximate. */
export function formatColor(info: ColorInfo, format: ColorFormat): Formatted {
  const { l, c, h, alpha } = info.oklch;
  const a = alpha < 1 ? ` / ${round(alpha, 3)}` : '';
  if (format === 'oklch') {
    return { text: `oklch(${round(l * 100, 1)}% ${round(c, 3)} ${Number.isNaN(h) ? 'none' : round(h, 1)}${a})`, approx: false };
  }
  const srgb = mapped(info, 'srgb');
  if (format === 'hex') {
    return { text: serialize({ ...srgb, alpha: alpha < 1 ? alpha : 1 }, { format: 'hex', collapse: false }), approx: !info.inSrgb };
  }
  const [r, g, b] = srgb.coords.map((x) => Math.round(Math.min(1, Math.max(0, Number.isNaN(x) ? 0 : x)) * 255));
  return { text: `rgb(${r} ${g} ${b}${a})`, approx: !info.inSrgb };
}

/** Short L/C/H readout, e.g. "L 62.3  C 0.190  H 259.8". */
export function lch(info: ColorInfo): { l: string; c: string; h: string } {
  const { l, c, h } = info.oklch;
  return { l: round(l * 100, 1).toFixed(1), c: round(c, 3).toFixed(3), h: Number.isNaN(h) ? '—' : round(h, 1).toFixed(1) };
}
