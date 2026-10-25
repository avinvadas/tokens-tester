import { inGamut } from 'colorjs.io/fn';
import { describe, expect, it } from 'vitest';
import { colorInfo } from '../src/color/format';
import { resolveEnds } from '../src/contrast/ends';
import { levelsFor } from '../src/contrast/levels';
import { contrast } from '../src/contrast/metrics';
import {
  contrastTargetedL,
  generate,
  generateFor,
  initialState,
  maxChroma,
  presetC,
  presetH,
  presetL,
  setAnchorColor,
  setAnchorStep,
  toEdits,
} from '../src/curves/model';
import { interpolate } from '../src/curves/spline';
import { DEFAULT_SETTINGS } from '../src/model/defaults';
import { detectPalettes } from '../src/palette/detect';
import { analyze } from '../src/validate';
import { loadFixture, loadText } from './helpers';

const palettes = detectPalettes(analyze([loadFixture('palettes.tokens.json')], DEFAULT_SETTINGS), {}, 'srgb');
const pal = (id: string) => palettes.palettes.find((p) => p.id === id)!;
const blue = pal('color.blue');
const red = pal('color.red');
const ls = (g: { info: { oklch: { l: number } } }[]) => g.map((x) => x.info.oklch.l);

describe('interpolation', () => {
  const pts = [
    { t: 0, v: 1 },
    { t: 0.5, v: 0.6 },
    { t: 1, v: 0 },
  ];
  it('passes through every point', () => {
    const f = interpolate(pts, true);
    for (const p of pts) expect(f(p.t)).toBeCloseTo(p.v, 10);
  });
  it('never overshoots a monotone set of points', () => {
    const f = interpolate([...pts, { t: 0.55, v: 0.59 }], true);
    let prev = Infinity;
    for (let t = 0; t <= 1; t += 0.01) {
      expect(f(t)).toBeLessThanOrEqual(prev + 1e-12);
      prev = f(t);
    }
  });
  it('draws straight segments when not smooth', () => {
    expect(interpolate(pts, false)(0.25)).toBeCloseTo(0.8, 10);
  });
});

describe('starting state', () => {
  it('anchors on 500 and reproduces the palette exactly: no edits', () => {
    const s = initialState(blue);
    expect(blue.swatches[s.anchor]!.step).toBe('500');
    expect(toEdits(blue, generate(blue, s, 'srgb'))).toEqual([]);
  });
  it('leaves out-of-gamut steps alone when they are not edited', () => {
    // blue.300 is outside sRGB; regenerating must not map it.
    const g = generate(blue, initialState(blue), 'srgb');
    expect(g.find((x) => x.step === '300')!.mapped).toBe(false);
  });
});

describe('editing', () => {
  it('changing the anchor color changes only the anchor step', () => {
    const s = setAnchorColor(blue, initialState(blue), { l: 0.6 });
    const edits = toEdits(blue, generate(blue, s, 'srgb'));
    expect(edits).toHaveLength(1);
    expect(edits[0]!.path).toEqual(['color', 'blue', '500', '$value']);
  });

  it('moving the anchor keeps the colors until the curves change', () => {
    const s = setAnchorStep(blue, initialState(blue), 2);
    expect(blue.swatches[s.anchor]!.step).toBe('200');
    expect(toEdits(blue, generate(blue, s, 'srgb'))).toEqual([]);
  });

  it('linear lightness keeps the ends and the anchor, and fixes the inversion', () => {
    const s = presetL(blue, initialState(blue), 'linear');
    const g = generate(blue, s, 'srgb');
    const l = ls(g);
    expect(l[0]).toBeCloseTo(blue.swatches[0]!.info.oklch.l, 3);
    expect(l.at(-1)).toBeCloseTo(blue.swatches.at(-1)!.info.oklch.l, 3);
    for (let i = 1; i < l.length; i++) expect(l[i]!).toBeLessThan(l[i - 1]!);
  });

  it('a bell keeps chroma at or under the anchor', () => {
    const s = presetC(blue, initialState(blue), 'bell');
    const g = generate(blue, s, 'p3');
    for (const x of g) expect(x.wanted.c).toBeLessThanOrEqual(s.anchorColor.c + 1e-9);
  });

  it('a hue shift turns the ends in opposite directions around the anchor', () => {
    const s = presetH(blue, initialState(blue), 'shift', 15);
    const g = generate(blue, s, 'p3');
    expect(g[0]!.wanted.h).toBeCloseTo(s.anchorColor.h - 15, 6);
    expect(g.at(-1)!.wanted.h).toBeCloseTo(s.anchorColor.h + 15, 6);
  });

  it('maps edited colors into the target gamut and says so', () => {
    const s = presetC(blue, setAnchorColor(blue, initialState(blue), { c: 0.32 }), 'flat');
    const g = generate(blue, s, 'srgb');
    expect(g.some((x) => x.mapped)).toBe(true);
    for (const x of g) expect(inGamut(x.info.source, 'srgb', { epsilon: 0.001 })).toBe(true);
  });
});

describe('gamut limits', () => {
  it('finds the largest chroma that fits', () => {
    const c = maxChroma(0.6, 260, 'srgb');
    expect(inGamut({ ...colorInfo({ colorSpace: 'oklch', components: [0.6, c, 260] })!.source }, 'srgb', { epsilon: 0.001 })).toBe(true);
    expect(inGamut(colorInfo({ colorSpace: 'oklch', components: [0.6, c + 0.01, 260] })!.source, 'srgb')).toBe(false);
    expect(maxChroma(0.6, 260, 'p3')).toBeGreaterThan(c);
  });
});

describe('contrast-targeted lightness', () => {
  const doc = {
    gray: {
      $type: 'color',
      ...Object.fromEntries(
        [0, 100, 200, 300, 400, 500, 600, 700].map((n, i) => [n, { $value: { colorSpace: 'oklch', components: [1 - i * 0.12, 0.01, 250] } }]),
      ),
    },
  };
  const set = detectPalettes(analyze([loadText(JSON.stringify(doc))], DEFAULT_SETTINGS), {}, 'srgb');
  const gray = set.palettes[0]!;
  const ends = resolveEnds({ palettes: [], loose: [] }, {});
  const aa = levelsFor(['wcag-aa'])[0]!;

  it('puts a target step just past the threshold on the light end', () => {
    const s0 = setAnchorStep(gray, initialState(gray), 0);
    const { state, notes } = contrastTargetedL(gray, s0, [{ index: 3, end: ends.light }], aa, 'srgb');
    expect(notes).toEqual([]);
    const ratio = contrast(generate(gray, state, 'srgb')[3]!.info, ends.light.info, 'wcag');
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    expect(ratio).toBeLessThan(4.7);
  });

  it('and on the dark end, by going lighter', () => {
    const s0 = setAnchorStep(gray, initialState(gray), 7);
    const { state, notes } = contrastTargetedL(gray, s0, [{ index: 3, end: ends.dark }], aa, 'srgb');
    expect(notes).toEqual([]);
    const ratio = contrast(generate(gray, state, 'srgb')[3]!.info, ends.dark.info, 'wcag');
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    expect(ratio).toBeLessThan(4.7);
  });

  it('reports targets that would reverse the lightness direction', () => {
    // A dark anchor near the light end, then a target further along that must be lighter.
    const s0 = setAnchorColor(gray, setAnchorStep(gray, initialState(gray), 1), { l: 0.3 });
    const { notes } = contrastTargetedL(gray, s0, [{ index: 5, end: ends.light }], aa, 'srgb');
    expect(notes.join(' ')).toMatch(/reverse direction/);
  });

  it('reports a step that is the anchor or cannot reach the level', () => {
    const s0 = setAnchorStep(gray, initialState(gray), 3);
    expect(contrastTargetedL(gray, s0, [{ index: 3, end: ends.light }], aa, 'srgb').notes.join(' ')).toMatch(/anchor/);
    const lightEnd = { ...ends.light, info: colorInfo({ colorSpace: 'srgb', components: [0.3, 0.3, 0.3] })! };
    const aaa = levelsFor(['wcag-aaa'])[0]!;
    expect(contrastTargetedL(gray, s0, [{ index: 6, end: lightEnd }], aaa, 'srgb').notes.join(' ')).toMatch(/can't reach/);
  });
});

describe('batch', () => {
  it('match: other palettes get the same lightness at the same step names', () => {
    const s = presetL(blue, initialState(blue), 'linear');
    const src = generate(blue, s, 'p3');
    const g = generateFor(red, blue, s, 'p3');
    for (const x of g) {
      const same = src.find((y) => y.step === x.step)!;
      expect(x.wanted.l).toBeCloseTo(same.wanted.l, 6);
    }
  });
  it('relative: lightness moves with each anchor; hue stays the palette’s own', () => {
    const s = { ...presetL(blue, initialState(blue), 'linear'), lightness: 'relative' as const };
    const g = generateFor(red, blue, s, 'p3');
    const red500 = red.swatches.find((x) => x.step === '500')!.info.oklch;
    const at500 = g.find((x) => x.step === '500')!;
    expect(at500.wanted.l).toBeCloseTo(red500.l, 6);
    expect(at500.wanted.h).toBeCloseTo(red500.h, 6);
  });
});

describe('writing back', () => {
  it('keeps each token’s color space and hex', async () => {
    const { fromColorJs } = await import('../src/color/dtcg');
    const c = colorInfo({ colorSpace: 'oklch', components: [0.6, 0.1, 30] })!.source;
    expect(fromColorJs(c, { colorSpace: 'oklch', components: [0, 0, 0] })).toEqual({ colorSpace: 'oklch', components: [0.6, 0.1, 30] });
    const srgb = fromColorJs(c, { colorSpace: 'srgb', components: [0, 0, 0], hex: '#000000' });
    expect(srgb.colorSpace).toBe('srgb');
    expect(srgb.hex).toMatch(/^#[0-9a-f]{6}$/);
  });
  it('moves an sRGB token to display-p3 when the new color is outside sRGB', async () => {
    const { fromColorJs } = await import('../src/color/dtcg');
    const p3 = colorInfo({ colorSpace: 'display-p3', components: [0, 1, 0] })!.source;
    expect(fromColorJs(p3, { colorSpace: 'srgb', components: [0, 0, 0] }).colorSpace).toBe('display-p3');
  });
});
