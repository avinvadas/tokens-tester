import { describe, expect, it } from 'vitest';
import { colorInfo } from '../src/color/format';
import { analyzePalette, boundary, parity, passPoint } from '../src/contrast/analyze';
import { beyondEnds, defaultEnds, endCandidates, resolveEnds, rowEnds, withinEnds } from '../src/contrast/ends';
import { bestLevel, levelsFor } from '../src/contrast/levels';
import { contrast, pairContrast } from '../src/contrast/metrics';
import { DEFAULT_SETTINGS } from '../src/model/defaults';
import { detectPalettes } from '../src/palette/detect';
import { analyze } from '../src/validate';
import { loadText } from './helpers';

const hex = (h: string) => {
  const n = parseInt(h.slice(1), 16);
  return { colorSpace: 'srgb', components: [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255], hex: h };
};
const palette = (steps: Record<string, string>) => Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, { $value: hex(v) }]));

const doc = {
  color: {
    $type: 'color',
    neutral: palette({ 0: '#ffffff', 100: '#e5e5e5', 200: '#949494', 300: '#767676', 400: '#595959', 500: '#000000' }),
    brand: palette({ 0: '#ffffff', 100: '#eeeeee', 200: '#aaaaaa', 300: '#888888', 400: '#666666', 500: '#333333' }),
  },
};
const model = analyze([loadText(JSON.stringify(doc, null, 2))], DEFAULT_SETTINGS);
const set = detectPalettes(model, {}, 'srgb');
const neutral = set.palettes.find((p) => p.id === 'color.neutral')!;
const brand = set.palettes.find((p) => p.id === 'color.brand')!;
const AA = levelsFor(['wcag-aa']);
const ends = resolveEnds(set, {});

describe('metrics', () => {
  const white = colorInfo(hex('#ffffff'))!;
  const black = colorInfo(hex('#000000'))!;
  it('computes WCAG ratios on known anchors', () => {
    expect(contrast(colorInfo(hex('#767676'))!, white, 'wcag')).toBeCloseTo(4.54, 2);
    expect(contrast(colorInfo(hex('#595959'))!, white, 'wcag')).toBeCloseTo(7.0, 1);
    expect(contrast(black, white, 'wcag')).toBeCloseTo(21, 5);
  });
  it('computes APCA as |Lc|, depending on which color is the text', () => {
    expect(contrast(black, white, 'apca')).toBeCloseTo(106, 0);
    expect(contrast(white, black, 'apca')).toBeCloseTo(108, 0);
    expect(pairContrast(black, white, 'apca')).toBeCloseTo(106, 0);
  });
  it('finds the strictest level passed', () => {
    const levels = levelsFor(['wcag-aa', 'wcag-aaa', 'apca']);
    expect(bestLevel(4.6, 'wcag', levels)?.short).toMatch(/^(AA|AAA large)$/);
    expect(bestLevel(7.2, 'wcag', levels)?.short).toBe('AAA');
    expect(bestLevel(3.1, 'wcag', levels)?.short).toBe('AA large');
    expect(bestLevel(2, 'wcag', levels)).toBeUndefined();
    expect(bestLevel(62, 'apca', levels)?.short).toBe('Lc 60');
  });
});

describe('ends', () => {
  it("default to the system's lightest and darkest neutral token", () => {
    expect(defaultEnds(set)).toEqual({ light: 'color.neutral.0', dark: 'color.neutral.500' });
  });
  it('fall back to white and black without neutral tokens', () => {
    expect(defaultEnds({ palettes: [], loose: [] })).toEqual({ light: 'white', dark: 'black' });
  });
  it('take only the picked token’s lightness, without chroma', () => {
    const e = resolveEnds(set, { light: 'color.neutral.100' });
    const step = neutral.swatches.find((s) => s.step === '100')!.info.oklch;
    expect(e.light.name).toBe('color.neutral.100');
    expect(e.light.info.oklch.l).toBeCloseTo(step.l, 4);
    expect(e.light.info.oklch.c).toBeLessThan(1e-4);
  });
  it('fall back to the defaults for a gone token, or ends on the wrong side of each other', () => {
    expect(resolveEnds(set, { light: 'color.gone' }).light.name).toBe('color.neutral.0');
    const crossed = resolveEnds(set, { light: 'color.neutral.400', dark: 'color.neutral.100' });
    expect([crossed.light.name, crossed.dark.name]).toEqual(['color.neutral.0', 'color.neutral.500']);
  });
  it('offer every step of each neutral scale, by name', () => {
    const ids = endCandidates(set).flatMap((g) => g.tokens.map((x) => x.id));
    for (const s of neutral.swatches) expect(ids).toContain(s.token.id);
    expect(ids).not.toContain('white');
  });
});

describe('pass ranges', () => {
  const r = analyzePalette(neutral, ends, levelsFor(['wcag-aa', 'wcag-aaa']));
  const range = (end: string, id: string) => r.ranges.find((x) => x.end === end && x.level.id === id)!;

  it('finds the passing run on the light end, from the dark side of the scale', () => {
    expect(range('light', 'aa')).toMatchObject({ from: '300', to: '500', stray: [] });
    expect(range('light', 'aa-large')).toMatchObject({ from: '200', to: '500' });
    expect(range('light', 'aaa')).toMatchObject({ from: '400', to: '500' });
  });

  it('finds the passing run on the dark end, from the light side', () => {
    expect(range('dark', 'aa')).toMatchObject({ from: '0', to: '300' });
    expect(range('dark', 'aaa')).toMatchObject({ from: '0', to: '100' });
  });

  it('reports the boundary step where passing begins', () => {
    expect(boundary(neutral, r, 'light', AA[0]!)).toBe('300');
    expect(boundary(neutral, r, 'dark', AA[0]!)).toBe('300');
    expect(passPoint(neutral, r, 'light', AA[0]!)).toEqual({ step: '300', side: 'start' });
    expect(passPoint(neutral, r, 'dark', AA[0]!)).toEqual({ step: '300', side: 'end' });
  });

  it('scores every step against both ends', () => {
    expect(r.scores['300']!.light.wcag).toBeCloseTo(4.54, 2);
    expect(r.scores['300']!.dark.wcag).toBeCloseTo(4.62, 2);
    expect(r.scores['300']!.light.apca).toBeUndefined();
  });
});

describe('step distance', () => {
  const r = analyzePalette(neutral, ends, AA);
  it('finds the smallest gap at which every pair passes', () => {
    const aa = r.distances.find((d) => d.level.id === 'aa')!;
    expect(aa).toMatchObject({ distance: 3, example: ['0', '300'] });
    // 200 & 400 (#949494 / #595959) are only 2.31 apart, so large text needs a gap of 3 too.
    expect(r.distances.find((d) => d.level.id === 'aa-large')!.distance).toBe(3);
  });
  it("gives each step its nearest passing partner", () => {
    const aa = r.distances.find((d) => d.level.id === 'aa')!;
    // 300 & 500 (#767676 on black, 4.62) pass two steps apart, nearer than 0.
    expect(aa.nearest).toMatchObject({ 0: '300', 100: '400', 200: '500', 300: '500', 500: '300' });
  });
});

describe('parity', () => {
  const results = new Map([neutral, brand].map((p) => [p.id, analyzePalette(p, ends, AA)]));
  it('points out palettes that start passing at a different step', () => {
    const rows = parity([neutral, brand], results, AA);
    const lightAA = rows.find((r) => r.end === 'light' && r.level.id === 'aa')!;
    expect(lightAA.outliers).toHaveLength(1);
    expect(new Set([lightAA.majority, lightAA.outliers[0]!.from])).toEqual(new Set(['300', '400']));
  });
  it('reports nothing when all palettes agree', () => {
    const same = new Map([[neutral.id, results.get(neutral.id)!], ['copy', results.get(neutral.id)!]]);
    expect(parity([neutral, { ...neutral, id: 'copy' }], same, AA)).toEqual([]);
  });
});

describe('neutral global ends and per-row ends', () => {
  const tinted = analyze(
    [
      loadText(
        JSON.stringify({
          color: {
            $type: 'color',
            gray: palette({ 50: '#fafafa', 500: '#737373', 900: '#171717' }),
            blue: palette({ 50: '#eff6ff', 500: '#3b82f6', 900: '#1e3a8a' }),
          },
        }),
      ),
    ],
    DEFAULT_SETTINGS,
  );
  const tset = detectPalettes(tinted, {}, 'srgb');
  const blue = tset.palettes.find((p) => p.id === 'color.blue')!;
  const gray = tset.palettes.find((p) => p.id === 'color.gray')!;
  const global = resolveEnds(tset, {});

  it('offers only neutral tokens as global ends, and ignores a colored pick', () => {
    const ids = endCandidates(tset).flatMap((g) => g.tokens.map((x) => x.id));
    expect(ids).toContain('color.gray.50');
    expect(ids).not.toContain('color.blue.50');
    expect(resolveEnds(tset, { light: 'color.blue.50' }).light.name).toBe(global.light.name);
  });

  it('scopes rows to the global ends: steps past them are left out', () => {
    const scoped = resolveEnds(tset, { light: 'color.gray.50', dark: 'color.gray.500' });
    expect(withinEnds(gray, scoped).swatches.map((x) => x.step)).toEqual(['50', '500']);
    expect(beyondEnds(gray, scoped)).toEqual([{ step: '900', end: 'dark' }]);
    expect(beyondEnds(blue, scoped).map((x) => x.step)).toEqual(['900']);
    // Pure white and black bound nothing.
    expect(withinEnds(blue, resolveEnds(tset, { light: 'white', dark: 'black' }))).toBe(blue);
  });

  it('gives a neutral palette the global ends unchanged', () => {
    expect(rowEnds(gray, global, 'srgb')).toEqual(global);
  });

  it('keeps pure white and black ends untinted: at L 100 or 0 there is no room for a hue', () => {
    const own = rowEnds(blue, resolveEnds(tset, { light: 'white', dark: 'black' }), 'srgb');
    expect(own.light.info.oklch.c).toBeLessThan(0.001);
    expect(own.dark.info.oklch.c).toBeLessThan(0.001);
  });

  it('tints a colored palette’s ends with its hue at the global ends’ lightness', () => {
    const global = resolveEnds(tset, { light: 'color.gray.50', dark: 'color.gray.900' });
    const own = rowEnds(blue, global, 'srgb');
    const lightest = blue.swatches[0]!.info.oklch;
    expect(own.light.info.oklch.l).toBeCloseTo(global.light.info.oklch.l, 3);
    expect(own.light.info.oklch.c).toBeGreaterThan(0);
    expect(own.light.info.oklch.c).toBeLessThan(lightest.c);
    expect(Math.abs(own.light.info.oklch.h - lightest.h)).toBeLessThan(1);
    expect(own.dark.info.oklch.l).toBeCloseTo(global.dark.info.oklch.l, 3);
  });
});
