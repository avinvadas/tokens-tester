import { cssToDtcg, toHex, type DtcgColor } from '../color/dtcg';
import { FONT_WEIGHT_NAMES } from './types';

/**
 * Converting individual values between legacy string forms ("16px", "#fff",
 * "Bold") and DTCG objects. Shared by the legacy converter and by the
 * validator's suggested fixes.
 */

export type Note = (message: string) => void;

const NUM = String.raw`-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?`;
const DIM_RE = new RegExp(`^\\s*(${NUM})\\s*(px|rem)?\\s*$`);
const DUR_RE = new RegExp(`^\\s*(${NUM})\\s*(ms|s)?\\s*$`);
const PCT_RE = new RegExp(`^\\s*(${NUM})\\s*%\\s*$`);
const PLAIN_RE = new RegExp(`^\\s*(${NUM})\\s*$`);
const OLD_ALIAS_RE = /^\$([\w-]+(?:\.[\w-]+)*)$/;
const ALIAS_RE = /^\{[^{}]+\}$/;

export const isAlias = (v: unknown): boolean => typeof v === 'string' && ALIAS_RE.test(v);
export const looksLikeHex = (v: unknown) => typeof v === 'string' && /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v.trim());

export interface Dimension {
  value: number;
  unit: 'px' | 'rem';
}

/** "16px", "1.5rem", 16, "16" (unitless means px, as in Tokens Studio). */
export function parseDimension(v: unknown): Dimension | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return { value: v, unit: 'px' };
  if (typeof v !== 'string') return undefined;
  const m = DIM_RE.exec(v);
  return m ? { value: Number(m[1]), unit: (m[2] as Dimension['unit']) ?? 'px' } : undefined;
}

/** "200ms", "0.2s", 200 (milliseconds). */
export function parseDuration(v: unknown): { value: number; unit: 'ms' | 's' } | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return { value: v, unit: 'ms' };
  if (typeof v !== 'string') return undefined;
  const m = DUR_RE.exec(v);
  return m ? { value: Number(m[1]), unit: (m[2] as 'ms' | 's') ?? 'ms' } : undefined;
}

/** 1.5, "1.5", "150%" → 1.5. */
export function parseNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return undefined;
  const pct = PCT_RE.exec(v);
  if (pct) return Number(pct[1]) / 100;
  const m = PLAIN_RE.exec(v);
  return m ? Number(m[1]) : undefined;
}

/** 700, "700", "Bold", "Semi Bold", "SemiBold" → DTCG number or keyword. */
export function parseFontWeight(v: unknown): number | string | undefined {
  if (typeof v === 'number') return v >= 1 && v <= 1000 ? v : undefined;
  if (typeof v !== 'string') return undefined;
  if (PLAIN_RE.test(v)) return parseFontWeight(Number(v));
  const key = v
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
  return key in FONT_WEIGHT_NAMES ? key : undefined;
}

/** "Inter, sans-serif" → ["Inter", "sans-serif"]; a single name stays a string. */
export function parseFontFamily(v: unknown): string | string[] | undefined {
  if (Array.isArray(v)) return v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;
  if (typeof v !== 'string') return undefined;
  const parts = v
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  return parts.length > 1 ? parts : parts[0];
}

export function parseCubicBezier(v: unknown): number[] | undefined {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.replace(/^cubic-bezier\(|\)$/g, '').split(',') : undefined;
  if (!list || list.length !== 4) return undefined;
  const nums = list.map((x) => (typeof x === 'number' ? x : Number(String(x).trim())));
  return nums.every(Number.isFinite) ? nums : undefined;
}

export const parseColor = (v: unknown): DtcgColor | undefined => (typeof v === 'string' ? cssToDtcg(v) : undefined);

// ---------------------------------------------------------------------------
// Legacy → DTCG

/**
 * Legacy alias forms → DTCG: "$color.blue" (old Tokens Studio) and
 * "{color.blue.value}" (Style Dictionary v3) both become "{color.blue}".
 */
export function convertAliasSyntax(v: string): string {
  const m = OLD_ALIAS_RE.exec(v.trim());
  const s = m ? `{${m[1]}}` : v;
  return s.replace(/\{([^{}]+)\.value\}/g, '{$1}');
}

/** DTCG references → Style Dictionary v3 form: "{color.blue}" becomes "{color.blue.value}". */
export function addValueSuffix(v: unknown): unknown {
  if (typeof v === 'string') return v.replace(/\{([^{}]+)\}/g, (all, ref: string) => (ref.endsWith('.value') ? all : `{${ref}.value}`));
  if (Array.isArray(v)) return v.map(addValueSuffix);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, addValueSuffix(x)]));
  return v;
}

/**
 * Convert one legacy value to its DTCG form for `type` (a DTCG type, or the
 * original legacy type when there is no equivalent). Values that can't be
 * converted are returned unchanged with a note.
 */
export function convertLegacyValue(type: string | undefined, v: unknown, note: Note): unknown {
  if (typeof v === 'string') {
    const s = convertAliasSyntax(v);
    if (isAlias(s)) return s;
    if (s.includes('{')) {
      note(`“${s}” combines a reference with other text (an expression or modifier). DTCG has no equivalent, so it was left as is.`);
      return s;
    }
    v = s;
  }
  const keep = (what: string) => {
    note(`“${display(v)}” can't be written as a DTCG ${what}, so it was left as is.`);
    return v;
  };
  switch (type) {
    case 'color':
      return parseColor(v) ?? keep('color');
    case 'dimension':
      return parseDimension(v) ?? keep('dimension (only px and rem units exist)');
    case 'duration':
      return parseDuration(v) ?? keep('duration');
    case 'number':
      return parseNumber(v) ?? keep('number');
    case 'fontWeight':
      return parseFontWeight(v) ?? keep('font weight');
    case 'fontFamily':
      return parseFontFamily(v) ?? keep('font family');
    case 'cubicBezier':
      return parseCubicBezier(v) ?? keep('cubic Bézier');
    case 'shadow':
      return Array.isArray(v) ? v.map((x) => convertShadow(x, note)) : convertShadow(v, note);
    case 'typography':
      return convertComposite(v, { fontFamily: 'fontFamily', fontSize: 'dimension', fontWeight: 'fontWeight', letterSpacing: 'letterSpacing', lineHeight: 'number' }, note);
    case 'border':
      return convertComposite(v, { color: 'color', width: 'dimension', style: 'strokeStyle' }, note);
    case 'transition':
      return convertComposite(v, { duration: 'duration', delay: 'duration', timingFunction: 'cubicBezier' }, note);
    case 'gradient':
      return Array.isArray(v) ? v.map((stop) => convertComposite(stop, { color: 'color', position: 'number' }, note)) : v;
    default:
      return v;
  }
}

function convertComposite(v: unknown, fields: Record<string, string>, note: Note): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    const type = fields[k];
    if (type === 'letterSpacing') {
      // Tokens Studio writes "0%" for no letter spacing; DTCG needs a dimension.
      out[k] = typeof x === 'string' && PCT_RE.test(x) && parseNumber(x) === 0 ? { value: 0, unit: 'px' } : convertLegacyValue('dimension', x, note);
    } else {
      out[k] = type ? convertLegacyValue(type, x, note) : typeof x === 'string' ? convertAliasSyntax(x) : x;
    }
  }
  return out;
}

/** Tokens Studio shadow {x, y, blur, spread, color, type} → DTCG {color, offsetX, offsetY, blur, spread, inset}. */
function convertShadow(v: unknown, note: Note): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const s = v as Record<string, unknown>;
  if (!('x' in s) && !('y' in s)) return convertComposite(s, { color: 'color', offsetX: 'dimension', offsetY: 'dimension', blur: 'dimension', spread: 'dimension' }, note);
  const out: Record<string, unknown> = {
    color: convertLegacyValue('color', s.color, note),
    offsetX: convertLegacyValue('dimension', s.x ?? 0, note),
    offsetY: convertLegacyValue('dimension', s.y ?? 0, note),
    blur: convertLegacyValue('dimension', s.blur ?? 0, note),
    spread: convertLegacyValue('dimension', s.spread ?? 0, note),
  };
  if (s.type === 'innerShadow') out.inset = true;
  return out;
}

const display = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

// ---------------------------------------------------------------------------
// DTCG → legacy

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function dimToString(v: unknown): unknown {
  return isObj(v) && typeof v.value === 'number' && typeof v.unit === 'string' ? `${v.value}${v.unit}` : v;
}

function colorToString(v: unknown): unknown {
  if (!isObj(v) || typeof v.colorSpace !== 'string') return v;
  const hex = (typeof v.hex === 'string' && v.colorSpace === 'srgb' ? v.hex : undefined) ?? toHex(v);
  if (!hex) return v;
  const alpha = typeof v.alpha === 'number' && v.alpha < 1 ? Math.round(v.alpha * 255).toString(16).padStart(2, '0') : '';
  return hex + alpha;
}

/** Convert a DTCG value back to the string forms legacy tools expect. */
export function toLegacyValue(type: string | undefined, v: unknown): unknown {
  if (typeof v === 'string') return v;
  switch (type) {
    case 'color':
      return colorToString(v);
    case 'dimension':
    case 'duration':
      return dimToString(v);
    case 'fontFamily':
      return Array.isArray(v) ? v.join(', ') : v;
    case 'shadow': {
      const one = (s: unknown) => {
        if (!isObj(s)) return s;
        const out: Record<string, unknown> = {
          x: dimToString(s.offsetX),
          y: dimToString(s.offsetY),
          blur: dimToString(s.blur),
          spread: dimToString(s.spread),
          color: colorToString(s.color),
          type: s.inset ? 'innerShadow' : 'dropShadow',
        };
        return out;
      };
      return Array.isArray(v) ? v.map(one) : one(v);
    }
    case 'typography':
    case 'border':
    case 'transition': {
      if (!isObj(v)) return v;
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = k === 'color' ? colorToString(x) : dimToString(x);
      return out;
    }
    case 'gradient':
      return Array.isArray(v) ? v.map((s) => (isObj(s) ? { ...s, color: colorToString(s.color) } : s)) : v;
    default:
      return v;
  }
}
