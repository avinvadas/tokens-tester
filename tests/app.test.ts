import { beforeEach, describe, expect, it } from 'vitest';
import { exportText, isUnchanged } from '../src/io/export';
import { addFiles, applyEdits, clearAll, redo, removeFile, store, undo } from '../src/state/app';
import { loadFixture } from './helpers';

beforeEach(() => clearAll());

describe('export round-trip', () => {
  it('exports every fixture byte-identical when nothing was edited', () => {
    const files = ['dtcg/primitives.tokens.json', 'dtcg/semantic.tokens.json', 'compact.tokens.json', 'dtcg-broken.tokens.json'].map(loadFixture);
    addFiles(files);
    for (const f of store.get().files) {
      expect(isUnchanged(f)).toBe(true);
      expect(exportText(f)).toBe(f.text);
    }
  });
});

describe('edits and history', () => {
  const setup = () => {
    addFiles([loadFixture('dtcg/primitives.tokens.json'), loadFixture('dtcg/semantic.tokens.json')]);
    return store.get().files;
  };

  it('applies an edit, rebuilds the model and resolves aliases to the new value', () => {
    const [prim] = setup();
    const v = { colorSpace: 'srgb', components: [0.5, 0, 0], hex: '#800000' };
    applyEdits('Darken red 700', [{ fileId: prim!.id, path: ['color', 'red', '700', '$value'], value: v }]);
    const s = store.get();
    expect(s.model.tokens.get('color.fg.danger')!.value).toEqual(v);
    expect(isUnchanged(s.files[0]!)).toBe(false);
    expect(s.past.map((c) => c.label)).toEqual(['Darken red 700']);
  });

  it('undoes and redoes, returning to byte-identical output', () => {
    const [prim, sem] = setup();
    applyEdits('Two files', [
      { fileId: prim!.id, path: ['color', 'blue', '50', '$description'], value: 'Lightest' },
      { fileId: sem!.id, path: ['color', 'bg', 'danger'], delete: true },
    ]);
    expect(store.get().model.tokens.has('color.bg.danger')).toBe(false);
    undo();
    expect(store.get().files.every(isUnchanged)).toBe(true);
    expect(store.get().model.tokens.has('color.bg.danger')).toBe(true);
    expect(store.get().future).toHaveLength(1);
    redo();
    expect(store.get().model.tokens.get('color.blue.50')!.description).toBe('Lightest');
    expect(store.get().past).toHaveLength(1);
  });

  it('ignores edits that change nothing and clears redo on a new edit', () => {
    const [prim] = setup();
    applyEdits('noop', []);
    expect(store.get().past).toHaveLength(0);
    applyEdits('a', [{ fileId: prim!.id, path: ['x'], value: 1 }]);
    undo();
    applyEdits('b', [{ fileId: prim!.id, path: ['y'], value: 2 }]);
    expect(store.get().future).toHaveLength(0);
  });

  it('drops history for removed or reloaded files', () => {
    const [prim, sem] = setup();
    applyEdits('a', [{ fileId: prim!.id, path: ['x'], value: 1 }]);
    applyEdits('b', [{ fileId: sem!.id, path: ['x'], value: 1 }]);
    removeFile(prim!.id);
    expect(store.get().past.map((c) => c.label)).toEqual(['b']);
    addFiles([loadFixture('dtcg/semantic.tokens.json')]);
    expect(store.get().past).toHaveLength(0);
    expect(store.get().files).toHaveLength(1);
  });
});
