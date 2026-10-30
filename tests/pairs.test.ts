import { describe, expect, it } from 'vitest';
import { colorInfo } from '../src/color/format';
import { DEFAULT_SETTINGS } from '../src/model/defaults';
import { aliasCandidates, applyPairEdits, checkPair, colorTokenIds, detectPairs, NO_PAIR_EDITS, over, pairId, realias } from '../src/semantic/pairs';
import { analyze } from '../src/validate';
import { loadText } from './helpers';

const ids = (pairs: { fg: string; bg: string }[]) => pairs.map((p) => `${p.fg} on ${p.bg}`);

describe('pair detection', () => {
  it('pairs foregrounds with the backgrounds that share their modifiers', () => {
    const pairs = detectPairs(['color.bg.default', 'color.bg.danger', 'color.text.default', 'color.text.danger', 'color.icon.danger']);
    expect(ids(pairs)).toEqual([
      'color.text.default on color.bg.default',
      'color.text.danger on color.bg.danger',
      'color.icon.danger on color.bg.danger',
    ]);
    expect(pairs.find((p) => p.fg === 'color.icon.danger')!.kind).toBe('ui');
  });

  it('checks a foreground with no matching background on the default one', () => {
    expect(ids(detectPairs(['bg.default', 'surface', 'text.subtle.hover']))).toEqual(['text.subtle.hover on bg.default', 'text.subtle.hover on surface']);
  });

  it('reads hyphenated and camelCase names', () => {
    expect(ids(detectPairs(['color.bg-warning', 'color.textWarning']))).toEqual(['color.textWarning on color.bg-warning']);
  });

  it('pairs on-X with X, keeping containers apart (Material)', () => {
    const pairs = detectPairs(['sys.primary', 'sys.on-primary', 'sys.primary-container', 'sys.on-primary-container', 'sys.surface', 'sys.on-surface']);
    expect(ids(pairs)).toEqual([
      'sys.on-primary on sys.primary',
      'sys.on-primary-container on sys.primary-container',
      'sys.on-surface on sys.surface',
    ]);
  });

  it('leaves palette steps and unrelated tokens alone', () => {
    expect(detectPairs(['color.gray.100', 'color.blue.500', 'color.accent'])).toEqual([]);
  });

  it('applies user additions, removals and kind changes', () => {
    const detected = detectPairs(['bg.default', 'text.default', 'border.default']);
    const border = pairId('border.default', 'bg.default');
    const added = { id: pairId('text.default', 'bg.raised'), fg: 'text.default', bg: 'bg.raised', kind: 'text' as const, source: 'user' as const };
    const out = applyPairEdits(detected, { added: [added], removed: [pairId('text.default', 'bg.default')], kinds: { [border]: 'text' } });
    expect(out.map((p) => [p.id, p.kind])).toEqual([
      [border, 'text'],
      [added.id, 'text'],
    ]);
    expect(applyPairEdits(detected, NO_PAIR_EDITS)).toEqual(detected);
  });
});

const hex = (h: string) => {
  const n = parseInt(h.slice(1), 16);
  return { colorSpace: 'srgb', components: [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255], hex: h };
};

describe('pair checks', () => {
  const doc = {
    color: {
      $type: 'color',
      gray: {
        0: { $value: hex('#ffffff') },
        500: { $value: hex('#767676') },
        300: { $value: hex('#949494') },
      },
      bg: { default: { $value: '{color.gray.0}' } },
      text: { default: { $value: '{color.gray.500}' } },
      icon: { default: { $value: '{color.gray.300}' } },
    },
  };
  const model = analyze([loadText(JSON.stringify(doc))], DEFAULT_SETTINGS);
  const pairs = detectPairs(colorTokenIds([model]));

  it('holds text to the text level and UI parts to the non-text level', () => {
    const text = checkPair(pairs.find((p) => p.fg === 'color.text.default')!, model, ['wcag-aa'])!;
    expect(text.values.wcag).toBeCloseTo(4.54, 2);
    expect(text.results.map((r) => [r.level.id, r.pass])).toEqual([['aa', true]]);
    const icon = checkPair(pairs.find((p) => p.fg === 'color.icon.default')!, model, ['wcag-aa', 'wcag-aaa'])!;
    expect(icon.results.map((r) => r.level.id)).toEqual(['aa-large']);
    expect(icon.pass).toBe(true);
    expect(checkPair(pairs.find((p) => p.fg === 'color.text.default')!, model, ['wcag-aaa'])!.pass).toBe(false);
  });

  it('is undefined when a token is missing in the theme', () => {
    expect(checkPair({ id: 'x', fg: 'color.text.default', bg: 'color.bg.gone', kind: 'text', source: 'user' }, model, ['wcag-aa'])).toBeUndefined();
  });

  it('blends a translucent foreground over its background', () => {
    const half = colorInfo({ colorSpace: 'srgb', components: [0, 0, 0], alpha: 0.5 })!;
    const white = colorInfo({ colorSpace: 'srgb', components: [1, 1, 1] })!;
    const shown = over(half, white);
    expect(shown.oklch.alpha).toBe(1);
    expect(shown.oklch.l).toBeGreaterThan(0.55);
    expect(shown.oklch.l).toBeLessThan(0.65);
  });

  it('offers base colors as alias targets, grouped by palette', () => {
    expect(aliasCandidates(model)).toEqual([{ label: 'color.gray', tokens: expect.any(Array) }]);
    expect(aliasCandidates(model)[0]!.tokens.map((t) => t.id)).toEqual(['color.gray.0', 'color.gray.300', 'color.gray.500']);
  });

  it('re-points an alias in its own file without writing a value', () => {
    const edit = realias(model, 'color.text.default', 'color.gray.300')!;
    expect(edit).toEqual({ fileId: model.files[0]!.id, path: ['color', 'text', 'default', '$value'], value: '{color.gray.300}' });
    expect(realias(model, 'color.gray.500', 'color.gray.0')).toBeUndefined();
  });
});
