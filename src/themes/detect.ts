import { entry, toJS, type JNode } from '../json/cst';
import { buildModel, tokenSets } from '../model/build';
import { isStudioMetaFile } from '../model/format';
import { modeValues } from '../model/modes';
import type { Settings, SourceFile, ThemeScope } from '../model/types';

/**
 * Themes: alternative versions of the token set (light/dark, brands, high
 * contrast) that are checked separately over shared primitives.
 *
 * Detected from, in order of preference:
 *  1. Tokens Studio `$themes` (in a multi-set file, or a separate `$themes.json`);
 *  2. file names: `semantic.light.json` + `semantic.dark.json`, with files
 *     that carry no theme word shared by every theme;
 *  3. per-mode values in `$extensions` (`mode` or `<vendor>.modes`).
 * The user can edit the result; DTCG Resolver documents aren't read yet.
 */

export type ThemeSource = 'tokens-studio' | 'file-names' | 'modes' | 'manual';

export interface Theme {
  id: string;
  name: string;
  source: ThemeSource;
  /** Files the theme reads, in load order. */
  fileIds: string[];
  scope: ThemeScope;
}


const THEME_WORD = /(?:^|[^a-z0-9])(light|dark|dim|night|day|high-?contrast|hc)(?=[^a-z0-9]|$)/i;

const titleCase = (s: string) => s.replace(/(^|-)([a-z])/g, (_, sep: string, c: string) => (sep ? ' ' : '') + c.toUpperCase());
const baseName = (name: string) => name.split('/').at(-1)!.replace(/\.(tokens\.)?json$|\.tokens$/i, '');

export function detectThemes(files: SourceFile[], settings: Settings): Theme[] {
  return fromTokensStudio(files) ?? fromFileNames(files) ?? fromModes(files, settings) ?? [];
}

// ---------------------------------------------------------------------------
// Tokens Studio

interface StudioTheme {
  name: string;
  group?: string;
  sets: string[];
}

function readStudioThemes(node: JNode | undefined): StudioTheme[] {
  if (node?.kind !== 'array') return [];
  const out: StudioTheme[] = [];
  for (const item of node.items) {
    const t = toJS(item.value) as { name?: unknown; group?: unknown; selectedTokenSets?: unknown };
    if (typeof t?.name !== 'string' || !t.selectedTokenSets || typeof t.selectedTokenSets !== 'object') continue;
    // "source" sets are read for references but not exported; both count for checking.
    const sets = Object.entries(t.selectedTokenSets as Record<string, unknown>)
      .filter(([, state]) => state === 'enabled' || state === 'source')
      .map(([set]) => set);
    const theme: StudioTheme = { name: t.name, sets };
    if (typeof t.group === 'string') theme.group = t.group;
    out.push(theme);
  }
  return out;
}

function fromTokensStudio(files: SourceFile[]): Theme[] | undefined {
  // One multi-set file with $themes inside.
  for (const f of files) {
    const root = f.doc.root;
    const defs = root.kind === 'object' ? readStudioThemes(entry(root, '$themes')?.value) : [];
    const sets = tokenSets(root);
    if (defs.length < 2 || !sets) continue;
    const others = files.filter((x) => x !== f && !isStudioMetaFile(x)).map((x) => x.id);
    return defs.map((d, i) => ({
      id: `ts:${i}`,
      name: d.group ? `${d.group} / ${d.name}` : d.name,
      source: 'tokens-studio' as const,
      fileIds: [f.id, ...others],
      scope: { sets: { [f.id]: d.sets.filter((s) => sets.includes(s)) } },
    }));
  }
  // A Tokens Studio folder export: $themes.json plus one file per set.
  const themesFile = files.find((f) => /(^|\/)\$themes\.json$/.test(f.name));
  const defs = themesFile ? readStudioThemes(themesFile.doc.root) : [];
  if (defs.length < 2) return undefined;
  const setOf = (f: SourceFile) => baseName(f.name);
  const allSets = new Set(defs.flatMap((d) => d.sets.map((s) => s.split('/').at(-1)!)));
  const shared = files.filter((f) => !isStudioMetaFile(f) && !allSets.has(setOf(f))).map((f) => f.id);
  return defs.map((d, i) => {
    const wanted = new Set(d.sets.map((s) => s.split('/').at(-1)!));
    return {
      id: `ts:${i}`,
      name: d.group ? `${d.group} / ${d.name}` : d.name,
      source: 'tokens-studio' as const,
      fileIds: files.filter((f) => shared.includes(f.id) || wanted.has(setOf(f))).map((f) => f.id),
      scope: {},
    };
  });
}

// ---------------------------------------------------------------------------
// File names

function fromFileNames(files: SourceFile[]): Theme[] | undefined {
  const word = (f: SourceFile) => {
    const m = THEME_WORD.exec(baseName(f.name));
    return m ? m[1]!.toLowerCase().replace(/^highcontrast$/, 'high-contrast').replace(/^hc$/, 'high-contrast') : undefined;
  };
  const keys = [...new Set(files.map(word).filter((k): k is string => !!k))];
  if (keys.length < 2) return undefined;
  const shared = files.filter((f) => !word(f) && !isStudioMetaFile(f)).map((f) => f.id);
  return keys.map((k) => ({
    id: `file:${k}`,
    name: titleCase(k),
    source: 'file-names' as const,
    fileIds: files.filter((f) => shared.includes(f.id) || word(f) === k).map((f) => f.id),
    scope: {},
  }));
}

// ---------------------------------------------------------------------------
// $extensions modes

function fromModes(files: SourceFile[], settings: Settings): Theme[] | undefined {
  const model = buildModel(files, settings);
  const names: string[] = [];
  for (const t of model.tokens.values()) {
    const modes = modeValues(t.extensions);
    if (modes) for (const m of Object.keys(modes.values)) if (!names.includes(m)) names.push(m);
  }
  if (names.length < 2) return undefined;
  const ids = files.filter((f) => !isStudioMetaFile(f)).map((f) => f.id);
  return names.map((m) => ({ id: `mode:${m}`, name: titleCase(m), source: 'modes' as const, fileIds: ids, scope: { mode: m } }));
}
