/**
 * Type vocabularies of legacy formats and their DTCG equivalents.
 * Types with no DTCG equivalent (text, textCase, asset, composition, …) are
 * kept as written so the validator can point them out.
 */

export const LEGACY_TO_DTCG: Readonly<Record<string, string>> = {
  color: 'color',
  dimension: 'dimension',
  sizing: 'dimension',
  spacing: 'dimension',
  size: 'dimension',
  borderRadius: 'dimension',
  borderWidth: 'dimension',
  fontSizes: 'dimension',
  fontSize: 'dimension',
  letterSpacing: 'dimension',
  paragraphSpacing: 'dimension',
  paragraphIndent: 'dimension',
  fontWeights: 'fontWeight',
  fontWeight: 'fontWeight',
  fontFamilies: 'fontFamily',
  fontFamily: 'fontFamily',
  lineHeights: 'number',
  lineHeight: 'number',
  opacity: 'number',
  number: 'number',
  boxShadow: 'shadow',
  shadow: 'shadow',
  typography: 'typography',
  border: 'border',
  duration: 'duration',
  time: 'duration',
  cubicBezier: 'cubicBezier',
  transition: 'transition',
  gradient: 'gradient',
  strokeStyle: 'strokeStyle',
};

/** Types only Tokens Studio uses; their presence identifies a Tokens Studio file. */
export const TOKENS_STUDIO_TYPES = new Set([
  'sizing',
  'spacing',
  'borderRadius',
  'borderWidth',
  'fontFamilies',
  'fontWeights',
  'fontSizes',
  'lineHeights',
  'letterSpacing',
  'paragraphSpacing',
  'paragraphIndent',
  'boxShadow',
  'textCase',
  'textDecoration',
  'composition',
  'asset',
  'other',
]);

/** Extension key holding legacy details that DTCG has no place for, so they survive a round-trip. */
export const LEGACY_EXT = 'com.tokens-tester.legacy';

export const DTCG_TYPES = [
  'color',
  'dimension',
  'fontFamily',
  'fontWeight',
  'duration',
  'cubicBezier',
  'number',
  'strokeStyle',
  'border',
  'transition',
  'shadow',
  'gradient',
  'typography',
] as const;

export const FONT_WEIGHT_NAMES: Readonly<Record<string, number>> = {
  thin: 100,
  hairline: 100,
  'extra-light': 200,
  'ultra-light': 200,
  light: 300,
  normal: 400,
  regular: 400,
  book: 400,
  medium: 500,
  'semi-bold': 600,
  'demi-bold': 600,
  bold: 700,
  'extra-bold': 800,
  'ultra-bold': 800,
  black: 900,
  heavy: 900,
  'extra-black': 950,
  'ultra-black': 950,
};
