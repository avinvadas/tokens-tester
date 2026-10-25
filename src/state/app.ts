import type { EndId } from '../contrast/analyze';
import type { EndChoice } from '../contrast/ends';
import { isLoadError, parseSource } from '../io/load';
import { deleteIn, renameIn, setIn, type JDoc } from '../json/cst';
import type { Edit, Fix, Model, Settings, SourceFile } from '../model/types';
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

const initial = (settings: Settings): AppState => ({
  settings,
  paletteOverrides: {},
  contrastEnds: {},
  files: [],
  model: analyze([], settings),
  loadErrors: [],
  busy: false,
  past: [],
  future: [],
});

export const store = createStore<AppState>(initial(loadSettings()));

const withFiles = (files: SourceFile[], settings = store.get().settings) => ({ files, model: analyze(files, settings) });

/** Add or replace (by name) loaded files. Loading is not an undoable edit. */
export function addFiles(added: SourceFile[], errors: LoadError[] = []) {
  store.set((s) => {
    const names = new Set(added.map((f) => f.name));
    const replaced = new Set(s.files.filter((f) => names.has(f.name)).map((f) => f.id));
    const files = [...s.files.filter((f) => !replaced.has(f.id)), ...added];
    return { ...withFiles(files, s.settings), loadErrors: errors, ...dropHistory(s, replaced) };
  });
}

/** Swap in fresh versions of loaded files (same ids, same order). Their edit history is dropped. */
export function replaceFiles(updated: SourceFile[], errors: LoadError[] = []) {
  store.set((s) => {
    const byId = new Map(updated.map((f) => [f.id, f]));
    const files = s.files.map((f) => byId.get(f.id) ?? f);
    return { ...withFiles(files, s.settings), loadErrors: errors, ...dropHistory(s, new Set(byId.keys())) };
  });
}

export function removeFile(id: string) {
  store.set((s) => ({ ...withFiles(s.files.filter((f) => f.id !== id), s.settings), ...dropHistory(s, new Set([id])) }));
}

export function clearAll() {
  store.set((s) => initial(s.settings));
}

export function setPaletteIncluded(id: string, included: boolean) {
  store.set((s) => ({ paletteOverrides: { ...s.paletteOverrides, [id]: included } }));
}

export function setContrastEnd(end: EndId, id: string) {
  store.set((s) => ({ contrastEnds: { ...s.contrastEnds, [end]: id } }));
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
    if (settings.acceptLegacy === s.settings.acceptLegacy) return { settings, model: analyze(s.files, settings) };
    const legacy = s.files.filter((f) => f.format === 'legacy');
    const fresh = new Map(legacy.map((f) => [f.id, reprepare(f, settings)]));
    const files = s.files.map((f) => fresh.get(f.id) ?? f);
    return { settings, ...withFiles(files, settings), ...dropHistory(s, new Set(fresh.keys())) };
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
    return { ...withFiles(swapDocs(s.files, changes, 'after'), s.settings), past: [...s.past, { label, changes }], future: [] };
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
    return { ...withFiles(swapDocs(s.files, cmd.changes, 'before'), s.settings), past: s.past.slice(0, -1), future: [cmd, ...s.future] };
  });
}

export function redo() {
  store.set((s) => {
    const cmd = s.future[0];
    if (!cmd) return {};
    return { ...withFiles(swapDocs(s.files, cmd.changes, 'after'), s.settings), past: [...s.past, cmd], future: s.future.slice(1) };
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
