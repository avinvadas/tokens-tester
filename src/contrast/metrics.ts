import { contrastAPCA, contrastWCAG21 } from 'colorjs.io/fn';
import { mapped, type ColorInfo } from '../color/format';
import type { Metric } from './levels';

/**
 * Contrast between two colors, measured on the sRGB colors a typical screen
 * shows (out-of-gamut colors are gamut-mapped first, as they would be
 * displayed). WCAG ratio is symmetric; APCA is returned as |Lc| for `text`
 * on `background`.
 */
export function contrast(text: ColorInfo, background: ColorInfo, metric: Metric): number {
  const t = mapped(text, 'srgb');
  const b = mapped(background, 'srgb');
  return metric === 'wcag' ? contrastWCAG21(t, b) : Math.abs(contrastAPCA(b, t));
}

/** Contrast of a pair where either color may be the text: the weaker direction. */
export function pairContrast(a: ColorInfo, b: ColorInfo, metric: Metric): number {
  return metric === 'wcag' ? contrast(a, b, 'wcag') : Math.min(contrast(a, b, 'apca'), contrast(b, a, 'apca'));
}

/** Display text for a contrast value: "4.62" for WCAG, "Lc 72" for APCA. */
export const formatContrast = (value: number, metric: Metric) => (metric === 'wcag' ? value.toFixed(2) : `Lc ${Math.round(value)}`);
