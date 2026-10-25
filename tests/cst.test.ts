import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deleteIn, getIn, JsonParseError, parseJson, serialize, setIn, toJS } from '../src/json/cst';
import { fixturePath, readFixture } from './helpers';

const roundTrip = (text: string) => serialize(parseJson(text).doc);

function allFixtures(dir = fixturePath('')): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? allFixtures(p) : [p];
  });
}

describe('round-trip', () => {
  const samples: Record<string, string> = {
    'two spaces': '{\n  "a": 1,\n  "b": [1, 2]\n}\n',
    tabs: '{\n\t"a": {\n\t\t"b": true\n\t}\n}',
    compact: '{"a":{"b":[1,2,{"c":null}]}}',
    'odd spacing': '  { "a" :1 , "b":[ ] ,"c" : { } }  \n\n',
    crlf: '{\r\n  "a": "x"\r\n}\r\n',
    'number spellings': '{"a": 1.0, "b": 1e3, "c": -0, "d": 0.50, "e": 1E-7}',
    'string escapes': '{"a": "caf\\u00e9", "b": "\\/path", "\\u0041": "key escape"}',
    bom: '﻿{"a": 1}',
    'top-level array': '[1, "two", {"three": 3}]',
    scalar: '"just a string"',
  };
  for (const [name, text] of Object.entries(samples)) {
    it(`is byte-identical: ${name}`, () => expect(roundTrip(text)).toBe(text));
  }
  for (const file of allFixtures()) {
    it(`is byte-identical: fixture ${file.split('fixtures/')[1]}`, () => {
      const text = readFixture(file.split('fixtures/')[1]!);
      expect(roundTrip(text)).toBe(text);
    });
  }
});

describe('key order', () => {
  it('keeps integer-like keys in source order (JSON.parse would sort them)', () => {
    const { doc } = parseJson('{"900": 1, "50": 2, "base": 3, "100": 4}');
    expect(doc.root.kind === 'object' && doc.root.entries.map((e) => e.key)).toEqual(['900', '50', 'base', '100']);
    expect(Object.keys(JSON.parse('{"900": 1, "50": 2, "base": 3, "100": 4}'))).toEqual(['50', '100', '900', 'base']);
  });
});

describe('parse errors', () => {
  const err = (text: string) => {
    try {
      parseJson(text);
    } catch (e) {
      if (e instanceof JsonParseError) return { message: e.message, line: e.pos.line, col: e.pos.col };
    }
    throw new Error('expected a parse error');
  };
  it('reports line and column', () => {
    expect(err('{\n  "a": 1,\n  "b" 2\n}')).toMatchObject({ line: 3, col: 7, message: expect.stringContaining("':'") });
  });
  it('explains trailing commas', () => {
    expect(err('{"a": 1,}').message).toMatch(/Trailing commas/);
    expect(err('[1,]').message).toMatch(/Trailing commas/);
  });
  it('rejects empty input, comments and junk after the value', () => {
    expect(err('   ').message).toMatch(/empty/);
    expect(err('{"a": 1} // note').message).toMatch(/after the end/);
    expect(err('{"a": 01}').message).toMatch(/Expected ','/);
    expect(err('{"a": "line\nbreak"}').message).toMatch(/line breaks/);
  });
  it('records duplicate keys with their path', () => {
    const { duplicates } = parseJson('{"g": {"x": 1, "x": 2}}');
    expect(duplicates).toEqual([{ path: ['g'], key: 'x', pos: expect.objectContaining({ line: 1, col: 16 }) }]);
  });
});

describe('editing', () => {
  const base = readFixture('dtcg/primitives.tokens.json');
  const diffLines = (a: string, b: string) => {
    const al = a.split('\n');
    const bl = b.split('\n');
    return bl.map((l, i) => [al[i], l] as const).filter(([x, y]) => x !== y);
  };

  it('changes only the edited line, keeping inline arrays inline', () => {
    const { doc } = parseJson(base);
    const path = ['color', 'blue', '500', '$value'];
    const next = setIn(doc, path, { colorSpace: 'oklch', components: [0.6, 0.19, 259.8] });
    const out = serialize(next);
    const changed = diffLines(base, out);
    expect(changed).toHaveLength(1);
    expect(changed[0]![1]).toBe('      "500": { "$value": { "colorSpace": "oklch", "components": [0.6, 0.19, 259.8] } },');
    expect(toJS(getIn(next.root, path)!)).toEqual({ colorSpace: 'oklch', components: [0.6, 0.19, 259.8] });
  });

  it('keeps number spelling for unchanged values', () => {
    const { doc } = parseJson(base);
    const path = ['color', 'blue', '700', '$value'];
    const v = toJS(getIn(doc.root, path)!) as { components: number[] };
    const next = setIn(doc, path, { ...v, components: [0.5, ...v.components.slice(1)] });
    expect(serialize(next)).toContain('"components": [0.5, 0.16, 262], "alpha": 1.0 }');
  });

  it('appends new keys using the surrounding formatting', () => {
    const { doc } = parseJson('{\n  "a": {\n    "x": 1\n  }\n}\n');
    const out = serialize(setIn(doc, ['a', 'y'], { deep: true }));
    expect(out).toBe('{\n  "a": {\n    "x": 1,\n    "y": {\n      "deep": true\n    }\n  }\n}\n');
  });

  it('creates missing parents and fills empty objects', () => {
    const { doc } = parseJson('{\n\t"a": {}\n}');
    expect(serialize(setIn(doc, ['a', 'b', 'c'], 1))).toBe('{\n\t"a": {\n\t\t"b": {\n\t\t\t"c": 1\n\t\t}\n\t}\n}');
  });

  it('stays compact in compact files', () => {
    const { doc } = parseJson('{"a":{"x":1}}');
    expect(serialize(setIn(doc, ['a', 'y'], [1, 2]))).toBe('{"a":{"x":1,"y":[1,2]}}');
  });

  it('deletes entries and repairs the closing whitespace', () => {
    const { doc } = parseJson('{\n  "a": 1,\n  "b": 2\n}');
    expect(serialize(deleteIn(doc, ['b']))).toBe('{\n  "a": 1\n}');
    expect(serialize(deleteIn(doc, ['a']))).toBe('{\n  "b": 2\n}');
    expect(serialize(deleteIn(deleteIn(doc, ['a']), ['b']))).toBe('{}');
    expect(serialize(deleteIn(doc, ['missing']))).toBe('{\n  "a": 1,\n  "b": 2\n}');
  });

  it('does not mutate the original document', () => {
    const { doc } = parseJson(base);
    setIn(doc, ['color', 'blue', '50', '$value'], 'x');
    deleteIn(doc, ['space']);
    expect(serialize(doc)).toBe(base);
  });
});

describe('rename and inline values', () => {
  it('renames a key in place, keeping formatting and order', async () => {
    const { renameIn } = await import('../src/json/cst');
    const { doc } = parseJson('{\n  "a": {\n    "\\u0024valeu": 1,\n    "b": 2\n  }\n}');
    expect(serialize(renameIn(doc, ['a', '$valeu'], '$value'))).toBe('{\n  "a": {\n    "$value": 1,\n    "b": 2\n  }\n}');
  });

  it('writes new objects inline inside single-line objects', () => {
    const { doc } = parseJson('{\n  "t": { "$value": "#fff", "$type": "color" }\n}');
    expect(serialize(setIn(doc, ['t', '$value'], { colorSpace: 'srgb', components: [1, 1, 1] }))).toBe(
      '{\n  "t": { "$value": { "colorSpace": "srgb", "components": [1, 1, 1] }, "$type": "color" }\n}',
    );
    expect(serialize(setIn(doc, ['t', '$description'], 'x'))).toBe('{\n  "t": { "$value": "#fff", "$type": "color", "$description": "x" }\n}');
  });
});
