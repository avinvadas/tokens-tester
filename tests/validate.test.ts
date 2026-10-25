import { beforeEach, describe, expect, it } from 'vitest';
import { isUnchanged } from '../src/io/export';
import type { Fix } from '../src/model/types';
import { addFiles, applyFixes, clearAll, store, undo } from '../src/state/app';
import { DEFAULT_SETTINGS } from '../src/model/defaults';
import { analyze } from '../src/validate';
import { loadFixture, loadText } from './helpers';

const OFF = { ...DEFAULT_SETTINGS, acceptLegacy: false };
const run = (...names: string[]) => analyze(names.map(loadFixture), OFF);
const byTarget = (m: ReturnType<typeof analyze>) => new Map(m.issues.map((i) => [`${i.code} ${i.target}`, i]));

describe('clean files', () => {
  it('report nothing for the clean multi-file set', () => {
    expect(run('dtcg/primitives.tokens.json', 'dtcg/semantic.tokens.json').issues).toEqual([]);
  });
});

describe('rules on the violations fixture', () => {
  const m = run('dtcg-violations.tokens.json');
  const found = byTarget(m);

  it.each([
    ['invalid-name color.with.dot', 'error', 'Rename to “with-dot”'],
    ['unknown-property color.typo.$valeu', 'warning', 'Rename to “$value”'],
    ['legacy-property color.half-legacy.value', 'error', 'Rename to “$value”'],
    ['token-has-children color.legacy-desc.description', 'error', 'Rename to “$description”'],
    ['empty-group misc.empty', 'info', 'Remove the empty group'],
    ['legacy-value color.hex-string', 'warning', 'Convert to the DTCG form'],
    ['invalid-value color.bytes', 'error', 'Fix the value'],
    ['invalid-value color.bad-space', 'error', 'Fix the value'],
    ['inconsistent-value color.stale-hex', 'warning', 'Update hex to #0000ff'],
    ['invalid-value color.oklch-pct', 'error', 'Fix the value'],
    ['legacy-value size.string', 'warning', 'Convert to the DTCG form'],
    ['missing-type misc.untyped', 'error', 'Set “$type” to “duration”'],
    ['unknown-type misc.sizing', 'error', 'Change type to “dimension”'],
    ['legacy-value misc.weight', 'warning', 'Convert to the DTCG form'],
    ['legacy-value misc.shadow', 'warning', 'Convert to the DTCG form'],
    ['invalid-value misc.typography', 'error', 'Fix 1 of 2 problems'],
    ['invalid-description misc.number-desc', 'error', 'Convert to text'],
  ])('%s → %s with fix “%s”', (key, severity, label) => {
    const issue = found.get(key);
    expect(issue, key).toBeDefined();
    expect(issue!.severity).toBe(severity);
    expect(issue!.fix?.label).toBe(label);
  });

  it.each([
    ['invalid-value color.not-a-color', 'error'],
    ['invalid-value size.em', 'error'],
    ['embedded-reference color.embedded', 'warning'],
    ['deprecated-reference color.uses-old', 'info'],
    ['extension-naming misc.ext', 'warning'],
  ])('%s → %s without an automatic fix', (key, severity) => {
    expect(found.get(key)).toMatchObject({ severity });
    expect(found.get(key)!.fix).toBeUndefined();
  });

  it('does not double-report', () => {
    expect(found.has('empty-group color.typo')).toBe(false);
    expect(found.has('invalid-value color.embedded')).toBe(false);
    expect(found.has('invalid-node color.half-legacy.value')).toBe(false);
  });

  it('fills every issue with a category', () => {
    expect(m.issues.every((i) => i.category)).toBe(true);
  });
});

describe('applying fixes', () => {
  beforeEach(() => clearAll());

  it('applying every fix leaves only the issues that have none, and undo restores the file', () => {
    addFiles([loadFixture('dtcg-violations.tokens.json')]);
    const before = store.get().model.issues;
    const fixes = before.map((i) => i.fix).filter((f): f is Fix => !!f);
    applyFixes(fixes);
    const after = store.get().model.issues;
    expect(after.filter((i) => i.fix).map((i) => `${i.code} ${i.target}`)).toEqual([]);
    expect(after.map((i) => `${i.code} ${i.target}`).sort()).toEqual(
      [
        'deprecated-reference color.uses-old',
        'embedded-reference color.embedded',
        'extension-naming misc.ext',
        'invalid-value color.not-a-color',
        'invalid-value misc.typography',
        'invalid-value size.em',
      ].sort(),
    );
    expect(store.get().past).toHaveLength(1);
    undo();
    expect(isUnchanged(store.get().files[0]!)).toBe(true);
  });

  it("applying one category's fixes leaves other categories alone, but includes follow-ups it uncovers", () => {
    addFiles([loadFixture('dtcg-violations.tokens.json')]);
    const issues = store.get().model.issues;
    const structure = issues.filter((i) => i.category === 'structure' && i.fix).map((i) => i.fix!);
    applyFixes(structure, 'structure');
    const after = store.get().model.issues;
    expect(after.filter((i) => i.category === 'structure')).toEqual([]);
    // Untouched categories keep their fixable issues.
    expect(after.some((i) => i.code === 'unknown-type' && i.fix)).toBe(true);
    expect(after.some((i) => i.code === 'invalid-description' && i.fix)).toBe(true);
    expect(after.some((i) => i.code === 'legacy-value' && i.target === 'size.string')).toBe(true);
    // The renamed "value" → "$value" exposed a hex string; that follow-up was converted in the same step.
    expect(after.some((i) => i.target === 'color.half-legacy')).toBe(false);
    expect(store.get().past).toHaveLength(1);
  });

  it('renames a misspelled $value so the token is read', () => {
    addFiles([loadText('{\n  "a": {\n    "$type": "color",\n    "$valeu": { "colorSpace": "srgb", "components": [0, 0, 0] }\n  }\n}\n')]);
    applyFixes([store.get().model.issues.find((i) => i.code === 'unknown-property')!.fix!]);
    expect(store.get().model.tokens.get('a')?.type).toBe('color');
    expect(store.get().model.issues).toEqual([]);
  });

  it('converts a legacy value inline when the token is written on one line', async () => {
    addFiles([loadText('{\n  "c": { "$type": "color", "$value": "#ff0000" }\n}\n')]);
    applyFixes([store.get().model.issues[0]!.fix!]);
    const { exportText } = await import('../src/io/export');
    expect(exportText(store.get().files[0]!)).toBe(
      '{\n  "c": { "$type": "color", "$value": { "colorSpace": "srgb", "components": [1, 0, 0], "hex": "#ff0000" } }\n}\n',
    );
  });

  it('offers a corrected reference for typos and applies it', () => {
    addFiles([loadFixture('dtcg-broken.tokens.json')]);
    const typo = store.get().model.issues.find((i) => i.code === 'unresolved-reference')!;
    expect(typo.fix).toMatchObject({ label: 'Use {color.base}', preview: { before: '{color.bsae}', after: '{color.base}' } });
    applyFixes([typo.fix!]);
    expect(store.get().model.tokens.get('color.typo')!.resolution).toBe('ok');
  });
});
