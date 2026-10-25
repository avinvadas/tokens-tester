import {
  A98RGB,
  ColorSpace,
  HSL,
  HWB,
  LCH,
  Lab,
  OKLCH,
  OKLab,
  P3,
  ProPhoto,
  REC_2020,
  XYZ_D50,
  XYZ_D65,
  parse,
  sRGB,
  sRGB_Linear,
  serialize,
  to,
  toGamut,
  type PlainColorObject,
} from 'colorjs.io/fn';

/**
 * Bridges between DTCG color values and Color.js. All color math in the tool
 * goes through Color.js; this module only translates representations.
 */

for (const space of [sRGB, sRGB_Linear, HSL, HWB, Lab, LCH, OKLab, OKLCH, P3, A98RGB, ProPhoto, REC_2020, XYZ_D65, XYZ_D50]) {
  ColorSpace.register(space);
}

/** DTCG `colorSpace` names → Color.js space ids. */
export const DTCG_SPACES: Readonly<Record<string, string>> = {
  srgb: 'srgb',
  'srgb-linear': 'srgb-linear',
  hsl: 'hsl',
  hwb: 'hwb',
  lab: 'lab',
  lch: 'lch',
  oklab: 'oklab',
  oklch: 'oklch',
  'display-p3': 'p3',
  'a98-rgb': 'a98rgb',
  'prophoto-rgb': 'prophoto',
  rec2020: 'rec2020',
  'xyz-d65': 'xyz-d65',
  'xyz-d50': 'xyz-d50',
};

const FROM_COLORJS = Object.fromEntries(Object.entries(DTCG_SPACES).map(([k, v]) => [v, k]));

export type Component = number | 'none';

export interface DtcgColor {
  colorSpace: string;
  components: Component[];
  alpha?: number;
  hex?: string;
}

export const round = (n: number, digits = 4) => {
  const f = 10 ** digits;
  const r = Math.round(n * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

/** Convert a DTCG color value to a Color.js color, or undefined if it isn't a valid one. */
export function toColorJs(v: unknown): PlainColorObject | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const c = v as Partial<DtcgColor>;
  const space = typeof c.colorSpace === 'string' ? DTCG_SPACES[c.colorSpace] : undefined;
  if (!space || !Array.isArray(c.components) || c.components.length !== 3) return undefined;
  if (!c.components.every((x) => x === 'none' || (typeof x === 'number' && Number.isFinite(x)))) return undefined;
  const coords = c.components.map((x) => (x === 'none' ? NaN : x)) as [number, number, number];
  const alpha = typeof c.alpha === 'number' ? c.alpha : 1;
  return { space: ColorSpace.get(space), coords, alpha };
}

/** 6-digit sRGB hex for any DTCG color (gamut-mapped when needed). */
export function toHex(v: unknown): string | undefined {
  const c = toColorJs(v);
  if (!c) return undefined;
  const srgb = toGamut(to(c, 'srgb'));
  return serialize({ ...srgb, alpha: 1 }, { format: 'hex', collapse: false });
}

/**
 * Parse a CSS color string (hex, rgb(), hsl(), oklch(), named…) into a DTCG
 * color object. sRGB inputs stay sRGB; other CSS spaces keep their space and
 * gain a hex fallback.
 */
export function cssToDtcg(css: string, digits = 4): DtcgColor | undefined {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(css.trim());
  } catch {
    return undefined;
  }
  const colorSpace = FROM_COLORJS[parsed.spaceId] ?? 'srgb';
  const plain: PlainColorObject = { space: ColorSpace.get(parsed.spaceId), coords: parsed.coords.map(Number) as [number, number, number], alpha: Number(parsed.alpha ?? 1) };
  const inSpace = colorSpace === FROM_COLORJS[parsed.spaceId] ? plain : to(plain, 'srgb');
  const out: DtcgColor = {
    colorSpace,
    components: inSpace.coords.map((x) => (Number.isNaN(x) ? 'none' : round(Number(x), digits))),
  };
  const alpha = Number(inSpace.alpha ?? 1);
  if (alpha !== 1) out.alpha = round(alpha, digits);
  const hex = toHex(out);
  if (hex) out.hex = hex;
  return out;
}

/** A short CSS-like display string for a DTCG color, without conversion. */
export function describeColor(v: DtcgColor): string {
  const alpha = typeof v.alpha === 'number' && v.alpha !== 1 ? ` / ${v.alpha}` : '';
  return `${v.colorSpace}(${v.components.join(' ')}${alpha})`;
}

/** Spaces whose gamut is sRGB: a color outside sRGB can't be written in them. */
const SRGB_BOUND = new Set(['srgb', 'srgb-linear', 'hsl', 'hwb']);

/**
 * Write a color back as a DTCG value in the space the token already used.
 * A color outside sRGB in an sRGB-bound space moves to display-p3. `hex` is
 * included (recomputed) when the original value had one.
 */
export function fromColorJs(c: PlainColorObject, like: Partial<DtcgColor> | undefined, digits = 4): DtcgColor {
  let space = typeof like?.colorSpace === 'string' && DTCG_SPACES[like.colorSpace] ? like.colorSpace : 'oklch';
  const srgb = to(c, 'srgb');
  const inSrgb = srgb.coords.every((x) => Number.isNaN(x) || (x >= -0.0005 && x <= 1.0005));
  if (SRGB_BOUND.has(space) && !inSrgb) space = 'display-p3';
  const inSpace = to(c, DTCG_SPACES[space]!);
  const out: DtcgColor = {
    colorSpace: space,
    components: inSpace.coords.map((x, i) => {
      if (Number.isNaN(x)) return 'none';
      // Clamp rounding noise at the edges of bounded spaces.
      const v = space === 'srgb' || space === 'display-p3' ? Math.min(1, Math.max(0, x)) : x;
      return round(i === 2 && (space === 'oklch' || space === 'lch' || space === 'hsl' || space === 'hwb') ? ((v % 360) + 360) % 360 : v, digits);
    }),
  };
  const alpha = Number(c.alpha ?? 1);
  if (alpha < 1) out.alpha = round(alpha, digits);
  if (like?.hex !== undefined) {
    const hex = toHex(out);
    if (hex) out.hex = hex;
  }
  return out;
}
