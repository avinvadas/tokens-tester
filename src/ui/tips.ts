import type { Level } from '../contrast/levels';
import type { Category, Severity } from '../model/types';
import type { FlagKind, ScaleFlag } from '../palette/checks';

/**
 * Tooltip wording for every indicator, in one place so the explanations stay
 * consistent. Only fixed text lives here, never token names or values.
 */

export const TIP = {
  // Navigation
  navFiles: 'Load token files and download your changes.',
  navThemes: 'Which files each theme reads, such as light and dark.',
  navIssues: 'Problems with the DTCG format, with suggested fixes. The number counts errors and warnings.',
  navColors: 'Base color palettes: scale checks, gamut and contrast, and the curve editor.',
  navSemantic: 'Coming next: foreground and background pairs checked under color-vision deficiencies, with safer alias suggestions.',
  navTokens: 'Every token with its written and resolved value.',
  themePick: 'The theme that Issues, Base colors and Tokens show. “All themes” combines them: a check fails if it fails in any theme.',

  // Files
  unchanged: 'Exporting now gives back exactly the bytes you loaded.',
  unchangedConverted: 'No edits since the file was converted.',
  edited: 'This file has edits that are not downloaded yet.',
  fileMeta: 'The format this file was read as, and how many tokens it defines.',
  download: 'Save this file, with any fixes and edits applied.',
  downloadDtcg: 'Save this file converted to the DTCG format, with any fixes and edits applied.',
  downloadLegacy: 'Save this file back in its original format. Values that cannot be converted back are listed below the file.',
  remove: 'Stop checking this file. Nothing is deleted from your computer.',
  undoNone: 'Nothing to undo',
  redoNone: 'Nothing to redo',
  downloadAll: 'Save every loaded file in the DTCG format.',
  clearAll: 'Remove every loaded file and start over.',

  // Issues
  reload: 'Read the files again from disk or their URL and re-run the checks.',
  fixAll: 'Apply every suggested fix in this group as one undoable step.',
  fix: 'Apply this suggested fix. You can undo it.',
  fixBefore: 'The value as it is now.',
  fixAfter: 'The value after the fix.',
  where: 'File, line and column where the problem is.',
  themeTag: 'This issue happens only when the file is read in these themes.',
  groupCount: 'Number of issues in this group.',

  // Themes
  themeErrors: 'DTCG errors found when the files are read as this theme. Green means none.',
  themeFile: 'Checked: this theme reads the file. Files every theme reads hold the shared tokens.',
  themeMode: 'The per-mode value in “$extensions” that this theme reads.',
  themeSets: 'Tokens Studio token sets this theme enables in this file.',
  removeTheme: 'Remove this theme. The files stay loaded.',

  // Tokens
  deprecated: 'Marked with “$deprecated”: still valid, but meant to be phased out.',
  extendedFrom: 'Inherited from another group through “$extends”, not written here.',
  noType: 'No “$type” on the token or any parent group, so its value cannot be checked.',
  alias: 'A reference to another token. The Resolved column shows the final value.',
  unresolved: 'The reference points to a token that does not exist, or the references loop.',
  notInTheme: 'This theme does not define this token.',
  colValue: 'The value as written in the file.',
  colResolved: 'The final value after following every reference.',

  // Palettes
  paletteMeta: 'Number of steps, and whether lightness goes from light to dark, dark to light, or has no clear order.',
  editCurves: 'Reshape this whole row with lightness, chroma and hue curves. The row previews live; nothing changes in your files until you apply.',
  notBase: 'Hide this group from the palette checks, for example when it is a set of one-off colors.',
  treatAsBase: 'Show this group as a palette and run the scale and contrast checks on it.',
  formats: {
    oklch: 'Show colors as oklch(lightness chroma hue), the space every check here uses.',
    hex: 'Show colors as hex. Colors outside sRGB are shown approximately (≈).',
    rgb: 'Show colors as rgb(). Colors outside sRGB are shown approximately (≈).',
  },
  gamut: 'The color space your product targets. Colors outside it are flagged and drawn mapped into it.',
  step: 'The step name, taken from the last part of the token path.',
  gamutP3: 'Outside sRGB but inside Display P3: shows correctly only on wide-gamut screens.',
  gamutOut: 'Outside Display P3 too: no common screen can show this color as written.',
  approx: '≈ means the color is outside this format’s range, so the text is the nearest match.',
  value: 'The color value, in the format chosen above.',
  l: 'L: perceived lightness, from 0 (black) to 100 (white).',
  c: 'C: chroma, how colorful it is. 0 is gray; around 0.37 is the most saturated a screen can show.',
  h: 'H: hue angle in degrees (about 30 red, 100 yellow, 145 green, 265 blue).',
  gamutOutSrgb: 'Outside sRGB, the target gamut: it is drawn mapped into sRGB, so screens show something other than the file. Switch the target to Display P3 if that is intended.',
  deltaL: 'Lightness difference between these two neighbouring steps (0–100 scale).',
  scaleRail: 'How each step relates to the next one: the lightness difference, or the problem with that pair.',
  flagWarning: 'Warning: likely a mistake in the scale.',
  flagInfo: 'Note: worth a look, but may be intended.',

  // Contrast
  targets: {
    'wcag-aa': 'WCAG 2.2 AA: ratio of at least 4.5 for text and 3 for large text and UI parts. The usual legal baseline.',
    'wcag-aaa': 'WCAG 2.2 AAA: ratio of at least 7 for text and 4.5 for large text. The enhanced level.',
    apca: 'APCA: the contrast method proposed for WCAG 3. Lc scores depend on which color is the text; higher is easier to read.',
  },
  endPicker: 'The color text is tested on. Defaults to your lightest or darkest neutral, otherwise white or black.',
  endLight: '◻ Contrast as text on the light end.',
  endDark: '◼ Contrast as text on the dark end.',
  wcagValue: 'WCAG contrast ratio, from 1 (none) to 21 (black on white).',
  apcaValue: 'APCA lightness contrast (Lc), from 0 to about 106. Higher is easier to read.',
  noLevel: '– means it passes none of the selected levels.',
  rangeOn: 'Where each selected level is first reached when the steps are used as text on this color.',
  passPoint: 'The heavy edge is the pass point: from here on, steps reach this level as text on this background; on the other side of the edge they do not.',
  missingStep: 'Missing step: other palettes in this system have it, this one does not.',
  previewRow: 'This row shows an unapplied curve edit. Apply or revert it in the curves panel.',
  stepDistance: 'How many steps apart two colors of this scale must be for one to be readable on the other.',
  nearest: 'For each step, the closest step that passes this level against it.',
  parity: 'Steps where this palette starts passing differ from most other palettes.',
} as const;

/** Curve editor controls. */
export const CURVE_TIP = {
  anchor: 'The step every curve passes through. It keeps its color unless you change it.',
  anchorL: 'Anchor lightness, 0 (black) to 100 (white).',
  anchorC: 'Anchor chroma: 0 is gray, higher is more colorful.',
  anchorH: 'Anchor hue angle in degrees.',
  presets: {
    Current: 'Fit the curve to the palette’s current values.',
    Linear: 'Straight lines from each end through the anchor, so lightness changes evenly on each side.',
    Ease: 'A smooth curve from each end through the anchor, without a sharp turn at the anchor.',
    Bell: 'Most colorful at the anchor, fading toward both ends.',
    Flat: 'The same chroma at every step (mapped down where the gamut is smaller).',
    Constant: 'The same hue as the anchor at every step.',
  } as Record<string, string>,
  shift: 'Turn the hue gradually by this many degrees from the anchor toward the last step.',
  contrast: 'Solve lightness so chosen steps just pass a contrast level on the light and dark ends.',
  solve: 'Set those steps’ lightness so they just pass, then smooth the curve through them.',
  revert: 'Close the panel and drop this edit. The rows go back to the values in your files.',
  match: 'Every palette gets this palette’s lightness at each step, so the same step has the same contrast everywhere.',
  relative: 'Each palette keeps its own anchor lightness and follows the curve’s shape from there.',
  reset: 'Go back to the palette’s current values.',
  apply: 'Write the previewed rows to your files as one undoable step.',
} as const;

/** What each scale check looks for. */
export const FLAG_TIP: Record<FlagKind, string> = {
  inversion: 'Lightness should move one way across the scale. Here a step is lighter or darker than its order says.',
  'near-duplicate': 'Neighbouring steps that are almost the same color are hard to tell apart (ΔE under 0.02 in OKLab).',
  'hue-drift': 'The hue turns more than 30° across the scale. Often intended (warmer lights, cooler darks), but check it.',
  'uneven-lightness': 'Lightness gaps between steps vary a lot, so some steps look much closer than others.',
  unordered: 'Step names that are not numbers or a known scale (like lightest…darkest or sm…xl) cannot be put in order.',
  'missing-steps': 'Other palettes have these steps. Matching step sets let a semantic role switch palettes cleanly.',
  'outside-gamut': 'Colors outside the target gamut get clipped by the screen, so what users see differs from the file.',
  p3: 'These colors need a wide-gamut (Display P3) screen to show as written.',
};

export const SEVERITY_TIP: Record<Severity, string> = {
  error: 'Error: breaks the DTCG format. Tools may reject the file or read it wrongly.',
  warning: 'Warning: valid, but likely a mistake or something tools handle inconsistently.',
  info: 'Info: a suggestion for clearer or more portable tokens.',
};

export const CATEGORY_TIP: Record<Category, string> = {
  format: 'Whether the file is DTCG JSON at all.',
  structure: 'Token and group names, and how tokens and groups nest.',
  references: 'Aliases like {color.blue.500}: do they exist, loop, or point to the wrong type.',
  types: 'Each token’s “$type”, written or inherited from its groups.',
  values: 'Whether each value has the shape its type requires.',
  metadata: '“$description”, “$extensions” and “$deprecated”.',
};

/** The level a badge stands for, e.g. "AA L" → "Passes AA large text & UI (3)". */
export const levelTip = (l: Level) => `${l.badge}: passes ${l.label}${l.metric === 'apca' ? ' (APCA Lc)' : ' (WCAG ratio)'}.`;

/** What a scale check looks for, after whether it is a warning or a note. */
export const flagTip = (f: ScaleFlag) => `${f.severity === 'warning' ? TIP.flagWarning : TIP.flagInfo} ${FLAG_TIP[f.kind]}`;
