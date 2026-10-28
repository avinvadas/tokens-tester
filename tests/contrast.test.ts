import { describe, expect, it } from 'vitest';
import { colorInfo } from '../src/color/format';
import { analyzePalette, boundary, parity, passPoint } from '../src/contrast/analyze';
import { defaultEnds, endCandidates, resolveEnds } from '../src/contrast/ends';
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
  it("default to the system's lightest and darkest neutral", () => {
    expect(defaultEnds(set)).toEqual({ light: 'color.neutral.0', dark: 'color.neutral.500' });
  });
  it('fall back to white and black without a neutral palette', () => {
    expect(defaultEnds({ palettes: [], loose: [] })).toEqual({ light: 'white', dark: 'black' });
  });
  it('honour a choice, and fall back when the chosen token is gone', () => {
    expect(resolveEnds(set, { light: 'color.neutral.100' }).light.name).toBe('color.neutral.100');
    expect(resolveEnds(set, { light: 'color.gone' }).light.name).toBe('color.neutral.0');
    expect(resolveEnds(set, { dark: 'black' }).dark.name).toBe('black');
  });
  it('offer light and dark candidates', () => {
    const c = endCandidates(set);
    expect(c.light[0]!.id).toBe('white');
    expect(c.light.map((x) => x.id)).toContain('color.neutral.100');
    expect(c.dark.map((x) => x.id)).toContain('color.brand.500');
    expect(c.dark.map((x) => x.id)).not.toContain('color.neutral.100');
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
