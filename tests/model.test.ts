import { describe, expect, it } from 'vitest';
import { buildModel } from '../src/model/build';
import { loadFixture, loadText } from './helpers';

const codes = (m: ReturnType<typeof buildModel>) => m.issues.map((i) => i.code).sort();

describe('clean multi-file DTCG set', () => {
  const m = buildModel([loadFixture('dtcg/primitives.tokens.json'), loadFixture('dtcg/semantic.tokens.json')]);

  it('has no issues', () => expect(m.issues).toEqual([]));

  it('collects tokens in source order, including integer-like steps', () => {
    const blue = [...m.tokens.values()].filter((t) => t.id.startsWith('color.blue.')).sort((a, b) => a.order - b.order);
    expect(blue.map((t) => t.path.at(-1))).toEqual(['900', '50', '100', '500', '700']);
  });

  it('inherits $type from groups', () => {
    expect(m.tokens.get('color.blue.500')).toMatchObject({ inheritedType: 'color', type: 'color' });
    expect(m.tokens.get('space.md')).toMatchObject({ type: 'dimension', description: 'Café spacing', value: { value: 5, unit: 'px' } });
  });

  it('resolves aliases across files and takes the type from the target', () => {
    const t = m.tokens.get('color.fg.danger')!;
    expect(t).toMatchObject({ aliasOf: 'color.red.700', type: 'color', resolution: 'ok', refs: ['color.red.700'] });
    expect(t.value).toEqual({ colorSpace: 'srgb', components: [0.76, 0, 0.03], hex: '#c10007' });
  });

  it('supports $root tokens and alias chains through them', () => {
    expect(m.tokens.get('color.accent.$root')).toMatchObject({ aliasOf: 'color.blue.500', type: 'color' });
  });

  it('resolves whole-value $ref pointers as aliases', () => {
    const link = m.tokens.get('color.fg.link')!;
    expect(link).toMatchObject({ aliasOf: 'color.accent.$root', type: 'color' });
    expect(link.value).toEqual({ colorSpace: 'oklch', components: [0.62, 0.19, 259.8] });
  });

  it('resolves references nested in composite values, including cross-file pointers', () => {
    const card = m.tokens.get('shadow.card')!;
    expect(card.aliasOf).toBeUndefined();
    expect(card.refs).toEqual(['color.blue.900', 'space.sm', 'space.sm', 'space.md']);
    expect(card.value).toEqual({
      color: { colorSpace: 'oklch', components: [0.32, 0.09, 262] },
      offsetX: { value: 4, unit: 'px' },
      offsetY: { value: 4, unit: 'px' },
      blur: { value: 5, unit: 'px' },
      spread: { value: 0, unit: 'px' },
    });
  });
});

describe('broken references', () => {
  const m = buildModel([loadFixture('dtcg-broken.tokens.json')]);
  const issue = (code: string) => m.issues.filter((i) => i.code === code);

  it('reports each problem once, at its root cause', () => {
    expect(codes(m)).toEqual([
      'alias-type-mismatch',
      'circular-reference',
      'duplicate-key',
      'invalid-node',
      'reference-to-group',
      'unresolved-reference',
      'unresolved-ref',
    ].sort());
  });

  it('suggests the closest token for a typo', () => {
    expect(issue('unresolved-reference')[0]!.message).toContain('Did you mean {color.base}?');
    expect(issue('unresolved-reference')[0]).toMatchObject({ target: 'color.typo', pos: { line: 5 } });
  });

  it('describes the cycle and marks everything downstream broken', () => {
    expect(issue('circular-reference')[0]!.message).toBe('Circular reference: {color.loop-a} → {color.loop-b} → {color.loop-a}.');
    for (const id of ['color.loop-a', 'color.loop-b', 'color.downstream']) {
      expect(m.tokens.get(id)!.resolution).toBe('broken');
      expect(m.tokens.get(id)!.value).toBeUndefined();
    }
  });

  it('flags non-object children, duplicates and type mismatches', () => {
    expect(issue('invalid-node')[0]).toMatchObject({ target: 'color.stray' });
    expect(issue('duplicate-key')[0]).toMatchObject({ target: 'color.dup' });
    expect(m.tokens.get('color.dup')!.rawValue).toEqual({ colorSpace: 'srgb', components: [1, 1, 1] });
    expect(issue('alias-type-mismatch')[0]!.message).toContain('“size.wrong” has type “dimension”');
  });
});

describe('$extends', () => {
  const m = buildModel([loadFixture('extends.tokens.json')]);
  it('copies tokens the extending group does not define', () => {
    expect(m.tokens.get('button-danger.fg')).toMatchObject({ extendedFrom: 'button.fg', type: 'color' });
    expect(m.tokens.get('button-danger.bg')!.extendedFrom).toBeUndefined();
    expect(m.tokens.get('button-danger.bg')!.value).toEqual({ colorSpace: 'srgb', components: [1, 0, 0] });
  });
  it('detects circular extends', () => expect(codes(m)).toEqual(['circular-extends']));
});

describe('files', () => {
  it('warns when two files define the same token', () => {
    const a = loadText('{"x": {"$type": "color", "$value": "{y}"}, "y": {"$type": "color", "$value": "#000"}}', 'a.json');
    const b = loadText('{"x": {"$type": "color", "$value": "{y}"}}', 'b.json');
    const m = buildModel([a, b]);
    expect(m.issues.map((i) => i.code)).toEqual(['duplicate-path']);
    expect(m.tokens.get('x')!.fileId).toBe(b.id);
  });

  it('detects legacy files and does not try to read them as DTCG', () => {
    const f = loadFixture('legacy-tokens-studio.json');
    expect(f.format).toBe('legacy');
    expect(codes(buildModel([f]))).toEqual(['legacy-format']);
  });

  it('rejects non-object roots', () => {
    expect(codes(buildModel([loadText('[1, 2]')]))).toEqual(['root-not-object']);
  });
});
