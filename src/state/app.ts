import type { EndId } from '../contrast/analyze';
import type { EndChoice } from '../contrast/ends';
import { isLoadError, parseSource } from '../io/load';
import { deleteIn, renameIn, setIn, type JDoc } from '../json/cst';
import { isStudioMetaFile } from '../model/format';
import type { Edit, Fix, Model, Settings, SourceFile } from '../model/types';
import { detectThemes, type Theme } from '../themes/detect';
import { mergeModels, orphanIssues, type ThemeModel } from '../themes/merge';
import { analyze } from '../validate';
import { loadSettings, saveSettings } from './settings';
import { createStore } from './store';

export type { Edit } from '../model/types';

/** A user-visible problem loading a source (parse error, network error). */
export interface LoadError {
  name: string;
  message: string;
  line?: number;
  col?: number;
  /** A few lines of source around the error, for parse errors. */
  excerpt?: string;
}

/** One undoable step: the documents it changed, before and after. */
export interface Command {
  label: string;
  changes: { fileId: string; before: JDoc; after: JDoc }[];
}

export interface AppState {
  settings: Settings;
  /**
   * Palettes the user explicitly included (true) or excluded (false), by group id.
   * Kept in memory only: group names are token data and never go to storage.
   */
  paletteOverrides: Readonly<Record<string, boolean>>;
  /** Chosen light/dark contrast ends (token ids, "white" or "black"). In memory only, like the overrides. */
  contrastEnds: Readonly<EndChoice>;
  files: SourceFile[];
  /**
   * Themes (light/dark, brands…). Detected from the files until the user edits
   * them. Kept in memory only: theme and file names are token data.
   */
  themes: Theme[];
  themesCustomized: boolean;
  /** A theme id, or ALL_THEMES. */
  activeTheme: string;
  /** One model per theme; empty when there are no themes. */
  themeModels: ThemeModel[];
  /** The model for the active theme (all themes merged for ALL_THEMES; the whole file set without themes). */
  model: Model;
  loadErrors: LoadError[];
  busy: boolean;
  past: Command[];
  future: Command[];
}

/** Prepare a file again from its original text under new settings (legacy conversion on or off). */
function reprepare(f: SourceFile, settings: Settings): SourceFile {
  const { name, text, origin, url, handle, blob } = f;
  const r = parseSource({ name, text, origin, ...(url ? { url } : {}), ...(handle ? { handle } : {}), ...(blob ? { blob } : {}) }, settings);
  return isLoadError(r) ? f : { ...r, id: f.id };
}

export const ALL_THEMES = 'all';

const initial = (settings: Settings): AppState => ({
  settings,
  paletteOverrides: {},
  contrastEnds: {},
  files: [],
  themes: [],
  themesCustomized: false,
  activeTheme: ALL_THEMES,
  themeModels: [],
  model: analyze([], settings),
  loadErrors: [],
  busy: false,
  past: [],
  future: [],
});

export const store = createStore<AppState>(initial(loadSettings()));

type Derived = Pick<AppState, 'files' | 'themes' | 'themesCustomized' | 'activeTheme' | 'themeModels' | 'model'>;

/**
 * Recompute themes and models for `files`. Until the user edits themes they
 * are re-detected; edited themes only lose files that are gone.
 */
function derive(s: AppState, files: SourceFile[], settings: Settings, edited?: Theme[]): Derived {
  const customized = edited !== undefined || s.themesCustomized;
  const ids = new Set(files.map((f) => f.id));
  const themes = !customized
    ? detectThemes(files, settings)
    : (edited ?? s.themes).map((t) => ({ ...t, fileIds: t.fileIds.filter((id) => ids.has(id)) }));
  if (themes.length === 0) {
    return { files, themes, themesCustomized: customized, activeTheme: ALL_THEMES, themeModels: [], model: analyze(files, settings) };
  }
  const orphans = files.filter((f) => !isStudioMetaFile(f) && !themes.some((t) => t.fileIds.includes(f.id)));
  const themeModels = themes.map((theme) => {
    const model = analyze(files.filter((f) => theme.fileIds.includes(f.id)), settings, theme.scope);
    model.issues.push(...orphanIssues(orphans));
    return { theme, model };
  });
  const activeTheme = themes.some((t) => t.id === s.activeTheme) ? s.activeTheme : ALL_THEMES;
  return { files, themes, themesCustomized: customized, activeTheme, themeModels, model: activeModel(themeModels, activeTheme) };
}

function activeModel(themeModels: ThemeModel[], active: string): Model {
  return themeModels.find((m) => m.theme.id === active)?.model ?? mergeModels(themeModels);
}

/** Every model in play: one per theme, or the single model without themes. */
export const allModels = (s: AppState): Model[] => (s.themeModels.length ? s.themeModels.map((m) => m.model) : [s.model]);

/** Add or replace (by name) loaded files. Loading is not an undoable edit. */
export function addFiles(added: SourceFile[], errors: LoadError[] = []) {
  store.set((s) => {
    const names = new Set(added.map((f) => f.name));
    const replaced = new Set(s.files.filter((f) => names.has(f.name)).map((f) => f.id));
    const files = [...s.files.filter((f) => !replaced.has(f.id)), ...added];
    // Edited themes: a reloaded file keeps its place; a new file joins every theme.
    let edited: Theme[] | undefined;
    if (s.themesCustomized) {
      const newId = new Map(added.map((f) => [f.name, f.id]));
      const successor = new Map(s.files.filter((f) => replaced.has(f.id)).map((f) => [f.id, newId.get(f.name)!]));
      const reloaded = new Set(successor.values());
      const fresh = added.filter((f) => !reloaded.has(f.id)).map((f) => f.id);
      edited = s.themes.map((t) => ({ ...t, fileIds: [...t.fileIds.map((id) => successor.get(id) ?? id), ...fresh] }));
    }
    return { ...derive(s, files, s.settings, edited), loadErrors: errors, ...dropHistory(s, replaced) };
  });
}

/** Swap in fresh versions of loaded files (same ids, same order). Their edit history is dropped. */
export function replaceFiles(updated: SourceFile[], errors: LoadError[] = []) {
  store.set((s) => {
    const byId = new Map(updated.map((f) => [f.id, f]));
    const files = s.files.map((f) => byId.get(f.id) ?? f);
    return { ...derive(s, files, s.settings), loadErrors: errors, ...dropHistory(s, new Set(byId.keys())) };
  });
}

export function removeFile(id: string) {
  store.set((s) => ({ ...derive(s, s.files.filter((f) => f.id !== id), s.settings), ...dropHistory(s, new Set([id])) }));
}

export function clearAll() {
  store.set((s) => initial(s.settings));
}

export function setPaletteIncluded(id: string, included: boolean) {
  store.set((s) => ({ paletteOverrides: { ...s.paletteOverrides, [id]: included } }));
}

/** Pick the token a global end takes its lightness from. */
export function setContrastEnd(end: EndId, id: string) {
  store.set((s) => ({ contrastEnds: { ...s.contrastEnds, [end]: id } }));
}

// ---------------------------------------------------------------------------
// Themes

export function setActiveTheme(id: string) {
  store.set((s) => ({ activeTheme: id, model: s.themeModels.length ? activeModel(s.themeModels, id) : s.model }));
}

function editThemes(fn: (themes: Theme[], s: AppState) => Theme[]) {
  store.set((s) => derive(s, s.files, s.settings, fn(s.themes, s)));
}

let manualCount = 0;
const manualTheme = (name: string, fileIds: string[]): Theme => ({ id: `manual:${++manualCount}`, name, source: 'manual', fileIds, scope: {} });

/** Add a theme that reads every file; with no themes yet, start with two to compare. */
export function addTheme() {
  editThemes((themes, s) => {
    const all = s.files.filter((f) => !isStudioMetaFile(f)).map((f) => f.id);
    if (themes.length === 0) return [manualTheme('Theme 1', all), manualTheme('Theme 2', all)];
    return [...themes, manualTheme(`Theme ${themes.length + 1}`, all)];
  });
}

export function renameTheme(id: string, name: string) {
  editThemes((themes) => themes.map((t) => (t.id === id ? { ...t, name: name.trim() || t.name } : t)));
}

export function removeTheme(id: string) {
  editThemes((themes) => themes.filter((t) => t.id !== id));
}

export function setThemeFile(themeId: string, fileId: string, included: boolean) {
  editThemes((themes, s) =>
    themes.map((t) => {
      if (t.id !== themeId) return t;
      const want = new Set(included ? [...t.fileIds, fileId] : t.fileIds.filter((id) => id !== fileId));
      return { ...t, fileIds: s.files.map((f) => f.id).filter((id) => want.has(id)) };
    }),
  );
}

/** Forget edits and detect themes from the files again. */
export function resetThemes() {
  store.set((s) => derive({ ...s, themesCustomized: false }, s.files, s.settings));
}

export function setBusy(busy: boolean) {
  store.set({ busy });
}

export function setLoadErrors(loadErrors: LoadError[]) {
  store.set({ loadErrors });
}

/**
 * Change settings. Turning legacy support on or off re-prepares legacy files
 * from their original text (dropping their edit history).
 */
export function updateSettings(patch: Partial<Settings>) {
  store.set((s) => {
    const settings = { ...s.settings, ...patch };
    saveSettings(settings);
    if (settings.acceptLegacy === s.settings.acceptLegacy) return { settings, ...derive(s, s.files, settings) };
    const legacy = s.files.filter((f) => f.format === 'legacy');
    const fresh = new Map(legacy.map((f) => [f.id, reprepare(f, settings)]));
    const files = s.files.map((f) => fresh.get(f.id) ?? f);
    return { settings, ...derive(s, files, settings), ...dropHistory(s, new Set(fresh.keys())) };
  });
}

/** Apply edits as one undoable command. */
export function applyEdits(label: string, edits: Edit[]) {
  store.set((s) => {
    const docs = new Map(s.files.map((f) => [f.id, f.doc]));
    for (const e of edits) {
      const doc = docs.get(e.fileId);
      if (!doc) throw new Error(`Unknown file ${e.fileId}`);
      docs.set(e.fileId, 'delete' in e ? deleteIn(doc, e.path) : 'rename' in e ? renameIn(doc, e.path, e.rename) : setIn(doc, e.path, e.value));
    }
    const changes = s.files
      .filter((f) => docs.get(f.id) !== f.doc)
      .map((f) => ({ fileId: f.id, before: f.doc, after: docs.get(f.id)! }));
    if (changes.length === 0) return {};
    return { ...derive(s, swapDocs(s.files, changes, 'after'), s.settings), past: [...s.past, { label, changes }], future: [] };
  });
}

/**
 * Apply suggested fixes. Edits from all fixes form one undoable command;
 * setting changes apply directly.
 *
 * A fix can reveal a follow-up on the same token (renaming `value` to `$value`
 * exposes a legacy hex string). When several fixes are applied together,
 * those follow-ups are applied too, in the same command, until none remain.
 */
export function applyFixes(fixes: Fix[], label = fixes.length === 1 ? fixes[0]!.label : `Apply ${fixes.length} fixes`) {
  const settingPatch: Partial<Settings> = {};
  const edits: Edit[] = [];
  for (const f of fixes) {
    if ('setting' in f) Object.assign(settingPatch, f.setting);
    else edits.push(...f.edits);
  }
  if (edits.length) {
    const depth = store.get().past.length;
    // Only problems that appear because of this batch count as follow-ups; others were left alone on purpose.
    const seen = new Set(store.get().model.issues.map(issueKey));
    applyEdits(label, orderEdits(edits));
    if (fixes.length > 1) {
      for (let pass = 0; pass < 3; pass++) {
        const fresh = store.get().model.issues.filter((i) => !seen.has(issueKey(i)));
        fresh.forEach((i) => seen.add(issueKey(i)));
        const follow = fresh.flatMap((i) => (i.fix && 'edits' in i.fix ? i.fix.edits : []));
        if (!follow.length) break;
        applyEdits(label, orderEdits(follow));
      }
      mergeCommandsSince(depth, label);
    }
  }
  if (Object.keys(settingPatch).length) updateSettings(settingPatch);
}

const issueKey = (i: { code: string; fileId?: string; keyPath?: string[]; target?: string }) =>
  [i.code, i.fileId, (i.keyPath ?? []).join('\u0000'), i.target].join('\u0001');

/** Collapse the commands pushed after `depth` into one, so a single undo reverts the whole batch. */
function mergeCommandsSince(depth: number, label: string) {
  store.set((s) => {
    const merged = s.past.slice(depth);
    if (merged.length <= 1) return {};
    const firstBefore = new Map<string, JDoc>();
    for (const c of merged) for (const ch of c.changes) if (!firstBefore.has(ch.fileId)) firstBefore.set(ch.fileId, ch.before);
    const changes = [...firstBefore].map(([fileId, before]) => ({ fileId, before, after: s.files.find((f) => f.id === fileId)!.doc }));
    return { past: [...s.past.slice(0, depth), { label, changes }] };
  });
}

/**
 * Value edits first (deepest paths first), then renames and deletions, so a
 * rename never moves a node another edit in the batch still points at.
 */
function orderEdits(edits: Edit[]): Edit[] {
  const rank = (e: Edit) => ('value' in e ? 0 : 1);
  return [...edits].sort((a, b) => rank(a) - rank(b) || b.path.length - a.path.length);
}

export function undo() {
  store.set((s) => {
    const cmd = s.past.at(-1);
    if (!cmd) return {};
    return { ...derive(s, swapDocs(s.files, cmd.changes, 'before'), s.settings), past: s.past.slice(0, -1), future: [cmd, ...s.future] };
  });
}

export function redo() {
  store.set((s) => {
    const cmd = s.future[0];
    if (!cmd) return {};
    return { ...derive(s, swapDocs(s.files, cmd.changes, 'after'), s.settings), past: [...s.past, cmd], future: s.future.slice(1) };
  });
}

function swapDocs(files: SourceFile[], changes: Command['changes'], side: 'before' | 'after'): SourceFile[] {
  const byId = new Map(changes.map((c) => [c.fileId, c[side]]));
  return files.map((f) => (byId.has(f.id) ? { ...f, doc: byId.get(f.id)! } : f));
}

/** Forget changes to files that were removed or replaced; drop commands left empty. */
function dropHistory(s: AppState, ids: Set<string>): Pick<AppState, 'past' | 'future'> {
  const prune = (list: Command[]) =>
    list
      .map((c) => ({ ...c, changes: c.changes.filter((ch) => !ids.has(ch.fileId)) }))
      .filter((c) => c.changes.length > 0);
  return { past: prune(s.past), future: prune(s.future) };
}
