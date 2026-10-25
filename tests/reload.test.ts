import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isLoadError, parseSource, readDropped, reloadSource } from '../src/io/load';
import type { SourceFile } from '../src/model/types';
import { addFiles, applyEdits, clearAll, replaceFiles, store } from '../src/state/app';

const v1 = '{"a": {"$type": "color", "$value": "{b}"}}';
const v2 = '{"a": {"$type": "color", "$value": {"colorSpace": "srgb", "components": [0, 0, 0]}}}';

const load = (text: string, extra: Partial<SourceFile> = {}): SourceFile => {
  const r = parseSource({ name: 'tokens.json', text, origin: 'file' });
  if (isLoadError(r)) throw new Error(r.message);
  return { ...r, ...extra };
};

describe('reloadSource', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the current file through a kept handle', async () => {
    let disk = v1;
    const handle = { name: 'tokens.json', kind: 'file', getFile: async () => new File([disk], 'tokens.json') } as unknown as FileSystemFileHandle;
    const f = load(v1, { handle });
    disk = v2;
    expect(await reloadSource(f)).toMatchObject({ name: 'tokens.json', text: v2, handle });
  });

  it('explains when a handle can no longer be read', async () => {
    const handle = { name: 'tokens.json', getFile: async () => Promise.reject(new DOMException('gone', 'NotFoundError')) } as unknown as FileSystemFileHandle;
    expect(await reloadSource(load(v1, { handle }))).toMatchObject({ message: expect.stringContaining('moved, renamed or deleted') });
  });

  it('falls back to re-reading the File, explaining when the browser refuses', async () => {
    const blob = new File([v1], 'tokens.json');
    expect(await reloadSource(load(v1, { blob }))).toMatchObject({ text: v1 });
    const stale = { name: 'tokens.json', text: () => Promise.reject(new DOMException('changed', 'NotReadableError')) } as unknown as File;
    expect(await reloadSource(load(v1, { blob: stale }))).toMatchObject({ message: expect.stringContaining('Drop or choose the file again') });
  });

  it('fetches URL sources again without cookies or referrer', async () => {
    const fetch = vi.fn(async () => new Response(v2));
    vi.stubGlobal('fetch', fetch);
    const f = load(v1, { origin: 'url', url: 'https://example.com/x/tokens.json', name: 'my tokens.json' });
    expect(await reloadSource(f)).toMatchObject({ name: 'my tokens.json', text: v2, origin: 'url' });
    expect(fetch).toHaveBeenCalledWith(new URL('https://example.com/x/tokens.json'), expect.objectContaining({ credentials: 'omit', referrerPolicy: 'no-referrer' }));
  });
});

describe('replaceFiles', () => {
  beforeEach(() => clearAll());

  it('swaps file contents in place, keeping id and order, and rebuilds the model', () => {
    const a = load(v1);
    const b = load('{"b": {"$type": "color", "$value": {"colorSpace": "srgb", "components": [0, 0, 0]}}}', { name: 'b.json' });
    addFiles([a, b]);
    expect(store.get().model.issues.map((i) => i.code)).toEqual([]);
    replaceFiles([{ ...load(v2), id: a.id }]);
    const s = store.get();
    expect(s.files.map((f) => f.id)).toEqual([a.id, b.id]);
    expect(s.files[0]!.text).toBe(v2);
    expect(s.model.tokens.get('a')!.aliasOf).toBeUndefined();
  });

  it('drops undo history only for replaced files', () => {
    const a = load(v1);
    const b = load('{"b": {"$type": "color", "$value": {"colorSpace": "srgb", "components": [0, 0, 0]}}}', { name: 'b.json' });
    addFiles([a, b]);
    applyEdits('edit a', [{ fileId: a.id, path: ['x'], value: 1 }]);
    applyEdits('edit b', [{ fileId: b.id, path: ['x'], value: 1 }]);
    replaceFiles([{ ...load(v2), id: a.id }]);
    expect(store.get().past.map((c) => c.label)).toEqual(['edit b']);
  });
});

describe('readDropped', () => {
  const unreadable = (name: string) =>
    ({ name, kind: 'file', getFile: () => Promise.reject(new DOMException('no access', 'NotAllowedError')) }) as unknown as FileSystemHandle;
  const brokenFile = (name: string) =>
    ({ name, size: 10, text: () => Promise.reject(new DOMException('cannot read', 'NotReadableError')) }) as unknown as File;
  const drop = (entries: { file: File | null; handle: FileSystemHandle | null }[]) =>
    ({
      items: entries.map((e) => ({ kind: 'file', getAsFile: () => e.file, getAsFileSystemHandle: async () => e.handle })),
      files: entries.map((e) => e.file),
    }) as unknown as DataTransfer;

  it('keeps the handle when reading through it works', async () => {
    const file = new File([v1], 'tokens.json');
    const handle = { name: 'tokens.json', kind: 'file', getFile: async () => file } as unknown as FileSystemHandle;
    const [r] = await readDropped(drop([{ file, handle }]));
    expect(r).toMatchObject({ text: v1, handle });
  });

  it('falls back to the dropped File when the handle cannot be read', async () => {
    const file = new File([v1], 'tokens.json');
    const [r] = await readDropped(drop([{ file, handle: unreadable('tokens.json') }]));
    expect(r).toMatchObject({ name: 'tokens.json', text: v1 });
    expect(r).not.toHaveProperty('handle');
  });

  it('falls back when the handle gives a File that cannot be read', async () => {
    const file = new File([v1], 'tokens.json');
    const handle = { name: 'tokens.json', kind: 'file', getFile: async () => brokenFile('tokens.json') } as unknown as FileSystemHandle;
    expect((await readDropped(drop([{ file, handle }])))[0]).toMatchObject({ text: v1 });
  });

  it("includes the browser's reason when nothing can be read", async () => {
    const [r] = await readDropped(drop([{ file: brokenFile('tokens.json'), handle: unreadable('tokens.json') }]));
    expect(r).toMatchObject({ message: 'The file could not be read. The browser said: NotReadableError: cannot read' });
  });

  it('uses the File when the browser gives no handle', async () => {
    const file = new File([v1], 'tokens.json');
    expect((await readDropped(drop([{ file, handle: null }])))[0]).toMatchObject({ text: v1 });
  });
});
