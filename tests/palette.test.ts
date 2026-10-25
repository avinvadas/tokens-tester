import { describe, expect, it } from 'vitest';
import { colorInfo, formatColor, lch } from '../src/color/format';
import { DEFAULT_SETTINGS } from '../src/model/defaults';
import { detectPalettes, type Palette } from '../src/palette/detect';
import { orderSteps } from '../src/palette/order';
import { analyze } from '../src/validate';
import { loadFixture } from './helpers';

const model = analyze([loadFixture('palettes.tokens.json')], DEFAULT_SETTINGS);
const srgb = detectPalettes(model, {}, 'srgb');
const p3 = detectPalettes(model, {}, 'p3');
const pal = (set: typeof srgb, id: string) => set.palettes.find((p) => p.id === id)!;
const kinds = (p: Palette) => p.flags.map((f) => f.kind);
const steps = (p: Palette) => p.swatches.map((s) => s.step);

describe('step ordering', () => {
  const name = (s: string) => s;
  it('sorts numeric names numerically, with suffixes after their number', () => {
    expect(orderSteps(['900', '50', '100A', '100', '1000'], name)).toMatchObject({ kind: 'numeric', items: ['50', '100', '100A', '900', '1000'] });
  });
  it('orders known word scales and appends names that do not fit', () => {
    expect(orderSteps(['dark', 'light', 'base', 'muted'], name)).toMatchObject({ kind: 'named', items: ['light', 'base', 'dark', 'muted'], unplaced: ['muted'] });
    expect(orderSteps(['xl', 'sm', 'md'], name).items).toEqual(['sm', 'md', 'xl']);
  });
  it('keeps file order when names follow no scale', () => {
    expect(orderSteps(['sky', 'sun', 'leaf'], name)).toMatchObject({ kind: 'file', items: ['sky', 'sun', 'leaf'] });
  });
});

describe('tiers and palettes', () => {
  it('treats only literal color tokens as base colors', () => {
    const all = [...srgb.palettes.flatMap((p) => p.swatches), ...srgb.loose].map((s) => s.token.id);
    expect(all).not.toContain('color.action');
    expect(all).toContain('color.blue.500');
  });

  it('groups by parent and orders by step name, not file order', () => {
    expect(steps(pal(srgb, 'color.blue'))).toEqual(['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950']);
    expect(steps(pal(srgb, 'color.accent'))).toEqual(['light', 'base', 'dark']);
    expect(pal(srgb, 'color.blue')).toMatchObject({ order: 'numeric', direction: 'light-to-dark', included: true });
  });

  it('keeps single colors outside palettes', () => {
    expect(srgb.loose.map((s) => s.token.id)).toEqual(['color.white', 'color.black']);
  });

  it('leaves semantic-looking groups out by default, and honours overrides', () => {
    expect(pal(srgb, 'color.bg')).toMatchObject({ included: false, excludedReason: expect.stringContaining('“bg”') });
    const overridden = detectPalettes(model, { 'color.bg': true, 'color.blue': false }, 'srgb');
    expect(pal(overridden, 'color.bg').included).toBe(true);
    expect(pal(overridden, 'color.blue').included).toBe(false);
  });
});

describe('scale checks', () => {
  it('flags lightness inversions and near-duplicates', () => {
    const blue = pal(srgb, 'color.blue');
    expect(blue.flags.find((f) => f.kind === 'inversion')).toMatchObject({ steps: ['600', '700'], severity: 'warning' });
    expect(blue.flags.find((f) => f.kind === 'near-duplicate')).toMatchObject({ steps: ['800', '900'] });
  });

  it('notes hue drift, uneven lightness and unordered names', () => {
    expect(pal(srgb, 'color.green').flags.find((f) => f.kind === 'hue-drift')?.message).toMatch(/Hue shifts 55°/);
    expect(pal(srgb, 'color.orange').flags.find((f) => f.kind === 'uneven-lightness')).toMatchObject({ steps: ['300', '400'] });
    expect(kinds(pal(srgb, 'brand'))).toEqual(['unordered']);
  });

  it('compares step sets against the full palettes', () => {
    expect(kinds(pal(srgb, 'color.blue'))).not.toContain('missing-steps');
    expect(pal(srgb, 'color.green').flags.find((f) => f.kind === 'missing-steps')?.message).toBe('Missing 50, 200, 400, 600, 800, which the other full palettes have.');
    expect(kinds(pal(srgb, 'color.violet'))).not.toContain('missing-steps');
    expect(kinds(pal(srgb, 'color.accent'))).toEqual([]);
  });

  it('flags gamut by target: outside sRGB is a warning for sRGB, P3 is informational for P3', () => {
    const v = pal(srgb, 'color.violet');
    expect(v.flags.find((f) => f.kind === 'outside-gamut')).toMatchObject({ steps: ['500', '700'], severity: 'warning' });
    const vp3 = pal(p3, 'color.violet');
    expect(vp3.flags.find((f) => f.kind === 'p3')).toMatchObject({ steps: ['500'], severity: 'info' });
    expect(vp3.flags.find((f) => f.kind === 'outside-gamut')).toMatchObject({ steps: ['700'] });
  });

  it('does not check excluded palettes', () => {
    expect(pal(srgb, 'color.bg').flags.map((f) => f.kind)).toEqual(['unordered']);
  });
});

describe('color formatting', () => {
  const red = colorInfo({ colorSpace: 'srgb', components: [1, 0, 0] })!;
  const p3green = colorInfo({ colorSpace: 'display-p3', components: [0, 1, 0] })!;
  it('formats OKLCH, hex and rgb', () => {
    expect(formatColor(red, 'oklch').text).toBe('oklch(62.8% 0.258 29.2)');
    expect(formatColor(red, 'hex')).toEqual({ text: '#ff0000', approx: false });
    expect(formatColor(red, 'rgb')).toEqual({ text: 'rgb(255 0 0)', approx: false });
    expect(lch(red)).toEqual({ l: '62.8', c: '0.258', h: '29.2' });
  });
  it('marks sRGB output of P3 colors as approximate', () => {
    expect(p3green).toMatchObject({ inSrgb: false, inP3: true });
    expect(formatColor(p3green, 'hex').approx).toBe(true);
    expect(formatColor(p3green, 'oklch').approx).toBe(false);
  });
  it('shows no hue for greys and keeps alpha', () => {
    const grey = colorInfo({ colorSpace: 'srgb', components: [0.5, 0.5, 0.5], alpha: 0.5 })!;
    expect(formatColor(grey, 'oklch').text).toBe('oklch(59.8% 0 none / 0.5)');
    expect(formatColor(grey, 'hex').text).toBe('#80808080');
  });
});

describe('gamut mapping', () => {
  it('does not change the analyzed color when mapping it for display', async () => {
    const { mapped } = await import('../src/color/format');
    const info = colorInfo({ colorSpace: 'srgb', components: [1.2, -0.1, 0.5] })!;
    mapped(info, 'srgb');
    expect(info.source.coords).toEqual([1.2, -0.1, 0.5]);
  });
});
