import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isLoadError, parseSource } from '../src/io/load';
import type { SourceFile } from '../src/model/types';

export const fixturePath = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

export const readFixture = (name: string) => readFileSync(fixturePath(name), 'utf8');

export function loadFixture(name: string): SourceFile {
  return loadText(readFixture(name), name.split('/').at(-1)!);
}

export function loadText(text: string, name = 'test.json'): SourceFile {
  const r = parseSource({ name, text, origin: 'file' });
  if (isLoadError(r)) throw new Error(`${r.message} (${r.line}:${r.col})`);
  return r;
}
