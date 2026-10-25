import { beforeEach, describe, expect, it } from 'vitest';
import { exportAs, exportText, isUnchanged } from '../src/io/export';
import { isLoadError, parseSource } from '../src/io/load';
import { parseJson, serialize, toJS } from '../src/json/cst';
import { detectLegacyKind, dtcgToLegacy, legacyToDtcg } from '../src/legacy/convert';
import { addFiles, applyFixes, clearAll, store, updateSettings } from '../src/state/app';
import { DEFAULT_SETTINGS } from '../src/model/defaults';
import { analyze } from '../src/validate';
import { readFixture } from './helpers';

const ON = { ...DEFAULT_SETTINGS, acceptLegacy: true };
const load = (name: string, settings = ON) => {
  const r = parseSource({ name, text: readFixture(name), origin: 'file' }, settings);
  if (isLoadError(r)) throw new Error(r.message);
  return r;
};

describe('detection', () => {
  it('tells Tokens Studio from Style Dictionary', () => {
    expect(detectLegacyKind(parseJson(readFixture('legacy/tokens-studio.json')).doc.root)).toBe('tokens-studio');
    expect(detectLegacyKind(parseJson(readFixture('legacy-tokens-studio.json')).doc.root)).toBe('tokens-studio');
    expect(detectLegacyKind(parseJson(readFixture('legacy/style-dictionary.json')).doc.root)).toBe('style-dictionary');
  });
});

describe('Tokens Studio → DTCG', () => {
  const f = load('legacy/tokens-studio.json');
  const m = analyze([f], ON);
  const v = (id: string) => m.tokens.get(id)?.value;

  it('converts and marks the file', () => {
    expect(f).toMatchObject({ format: 'legacy', legacyKind: 'tokens-studio', converted: true });
    expect(isUnchanged(f)).toBe(true);
  });

  it('reads sets into one namespace, so cross-set references resolve', () => {
    expect(m.tokens.get('bg')).toMatchObject({ keyPath: ['light', 'bg'], aliasOf: 'blue.500', type: 'color', resolution: 'ok' });
    expect(m.tokens.has('global.blue.500')).toBe(false);
  });

  it('converts values to DTCG objects', () => {
    expect(v('blue.500')).toEqual({ colorSpace: 'srgb', components: [0.1451, 0.3882, 0.9216], hex: '#2563eb' });
    expect(v('blue.700')).toMatchObject({ alpha: 0.9, hex: '#1d4ed8' });
    expect(v('space.sm')).toEqual({ value: 4, unit: 'px' });
    expect(v('space.lg')).toEqual({ value: 1.5, unit: 'rem' });
    expect(v('opacity')).toBe(0.5);
    expect(v('weight')).toBe('semi-bold');
    expect(v('family')).toEqual(['Inter', 'sans-serif']);
    expect(v('body')).toEqual({ fontFamily: ['Inter', 'sans-serif'], fontWeight: 'semi-bold', fontSize: { value: 16, unit: 'px' }, lineHeight: 1.5, letterSpacing: { value: 0, unit: 'px' } });
    expect(v('card')).toMatchObject({ offsetX: { value: 0, unit: 'px' }, offsetY: { value: 2, unit: 'px' }, color: { alpha: 0.12 } });
    expect(m.tokens.get('blue.500')!.description).toBe('Brand blue');
  });

  it('reports what has no DTCG equivalent', () => {
    const codes = m.issues.map((i) => `${i.code} ${i.target}`).sort();
    expect(codes).toEqual(['legacy-conversion global.space.md', 'unknown-type case'].sort());
  });

  it('round-trips back to Tokens Studio', () => {
    const back = toJS(dtcgToLegacy(f.doc, 'tokens-studio').doc.root) as Record<string, Record<string, unknown>>;
    const orig = toJS(parseJson(f.text).doc.root) as Record<string, Record<string, unknown>>;
    expect(back.global!.space).toEqual({ sm: { value: '4px', type: 'spacing' }, md: orig.global!.space && (orig.global!.space as Record<string, unknown>).md, lg: { value: '1.5rem', type: 'sizing' } });
    expect(back.global!.radius).toEqual(orig.global!.radius);
    expect(back.global!.case).toEqual(orig.global!.case);
    expect(back.global!.blue).toEqual({ 500: orig.global!.blue && (orig.global!.blue as Record<string, unknown>)[500], 700: { value: '#1d4ed8e6', type: 'color' } });
    expect(back.light).toEqual({ bg: { value: '{blue.500}', type: 'color' } });
    expect(back.$metadata).toEqual(orig.$metadata);
  });
});

describe('Style Dictionary v3 → DTCG', () => {
  const f = load('legacy/style-dictionary.json');
  const m = analyze([f], ON);

  it('types untyped hex colors, keeps comments and extra attributes, and drops the .value reference suffix', () => {
    expect(m.tokens.get('color.base.red')).toMatchObject({ type: 'color', description: 'Pure red' });
    expect(m.tokens.get('color.base.gray')!.extensions).toEqual({ 'com.tokens-tester.legacy': { attributes: { category: 'color' } } });
    expect(m.tokens.get('color.font')).toMatchObject({ aliasOf: 'color.base.red', type: 'color', resolution: 'ok' });
  });

  it('notes units DTCG lacks', () => {
    expect(m.issues.map((i) => `${i.code} ${i.target}`).sort()).toEqual(['invalid-value size.relative', 'legacy-conversion size.relative']);
  });

  it('exports back to Style Dictionary with the .value suffix restored', () => {
    const { text, notes } = exportAs(f, 'original');
    expect(notes).toEqual([]);
    const back = JSON.parse(text);
    expect(back.color.font).toEqual({ value: '{color.base.red.value}' });
    expect(back.color.base.red).toEqual({ value: '#ff0000', comment: 'Pure red', type: 'color' });
    expect(back.color.base.gray).toEqual({ value: '#777777', type: 'color', attributes: { category: 'color' } });
    expect(back.size.padding).toEqual({ value: '16px', type: 'size' });
  });
});

describe('formatting', () => {
  it('keeps the original layout, inline tokens stay inline', () => {
    const { doc } = legacyToDtcg(parseJson('{\n  "a": { "value": "#000000", "type": "color" }\n}\n').doc);
    expect(serialize(doc)).toBe('{\n  "a": { "$value": { "colorSpace": "srgb", "components": [0, 0, 0], "hex": "#000000" }, "$type": "color" }\n}\n');
  });
});

describe('the legacy setting', () => {
  beforeEach(() => {
    clearAll();
    updateSettings({ acceptLegacy: false });
  });

  it('when off, reports the file with a fix that turns support on and converts it', () => {
    addFiles([load('legacy/style-dictionary.json', { ...DEFAULT_SETTINGS, acceptLegacy: false })]);
    const issue = store.get().model.issues.find((i) => i.code === 'legacy-format')!;
    expect(issue.fix).toMatchObject({ label: 'Turn on legacy support', setting: { acceptLegacy: true } });
    expect(store.get().model.tokens.size).toBe(0);
    applyFixes([issue.fix!]);
    expect(store.get().settings.acceptLegacy).toBe(true);
    expect(store.get().files[0]!.converted).toBe(true);
    expect(store.get().model.tokens.size).toBe(5);
  });

  it('turning it off again restores the original, unconverted file', () => {
    updateSettings({ acceptLegacy: true });
    addFiles([load('legacy/style-dictionary.json')]);
    const id = store.get().files[0]!.id;
    updateSettings({ acceptLegacy: false });
    const f = store.get().files[0]!;
    expect(f.id).toBe(id);
    expect(f.converted).toBeUndefined();
    expect(exportText(f)).toBe(f.text);
  });
});
