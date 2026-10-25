import { download, exportAs, isUnchanged, type ExportFormat } from '../io/export';
import { isStudioMetaFile } from '../model/format';
import type { SourceFile } from '../model/types';
import { allModels, clearAll, redo, removeFile, store, undo, type AppState } from '../state/app';
import { h, masked, plural } from './dom';

const LEGACY_LABEL = { 'tokens-studio': 'Tokens Studio', 'style-dictionary': 'Style Dictionary' } as const;

function formatLabel(f: SourceFile): string {
  if (isStudioMetaFile(f)) return 'Tokens Studio project metadata';
  if (f.format === 'dtcg') return 'DTCG';
  if (f.format === 'unknown') return 'No tokens found';
  const kind = f.legacyKind ? LEGACY_LABEL[f.legacyKind] : 'Legacy format';
  return f.converted ? `${kind}, converted to DTCG` : `${kind} (not read)`;
}

export class TTFiles extends HTMLElement {
  private unsub?: () => void;
  /** What couldn't be converted back on the last legacy export, per file. */
  private exportNotes = new Map<string, string[]>();

  private save(f: SourceFile, format: ExportFormat) {
    const { text, notes } = exportAs(f, format);
    download(f.name, text);
    if (notes.length) this.exportNotes.set(f.id, notes);
    else this.exportNotes.delete(f.id);
    this.render(store.get());
  }

  connectedCallback() {
    this.unsub = store.select(
      (s): Pick<AppState, 'files' | 'model' | 'themeModels' | 'past' | 'future'> => s,
      (s) => this.render(s),
      (a, b) => a.files === b.files && a.themeModels === b.themeModels && a.past === b.past && a.future === b.future,
    );
  }

  disconnectedCallback() {
    this.unsub?.();
  }

  private render(state: Pick<AppState, 'files' | 'model' | 'themeModels' | 'past' | 'future'>) {
    const { files, past, future } = state;
    // A file read by several themes has the same tokens in each; count it once.
    const counts = new Map<string, number>();
    for (const model of allModels(state as AppState)) {
      const per = new Map<string, number>();
      for (const t of model.tokens.values()) if (!t.extendedFrom) per.set(t.fileId, (per.get(t.fileId) ?? 0) + 1);
      for (const [id, n] of per) counts.set(id, Math.max(counts.get(id) ?? 0, n));
    }

    const rows = files.map((f) => {
      const same = isUnchanged(f);
      const kind = f.legacyKind ? LEGACY_LABEL[f.legacyKind] : '';
      const notes = this.exportNotes.get(f.id);
      return h(
        'li',
        { class: 'file' },
        masked(h('span', { class: 'file-name' }, f.name)),
        h('span', { class: 'meta' }, `${formatLabel(f)} · ${plural(counts.get(f.id) ?? 0, 'token')}${f.origin === 'url' ? ' · from URL' : ''}`),
        h(
          'span',
          {
            class: `badge ${same ? 'ok' : 'changed'}`,
            title: same ? (f.converted ? 'No edits since the file was converted.' : 'Exporting now gives back exactly the bytes you loaded.') : 'This file has edits that are not downloaded yet.',
          },
          same ? 'Unchanged' : 'Edited',
        ),
        f.converted
          ? [
              h('button', { class: 'ghost', onclick: () => this.save(f, 'dtcg') }, 'Download DTCG'),
              h('button', { class: 'ghost', onclick: () => this.save(f, 'original') }, `Download as ${kind}`),
            ]
          : h('button', { class: 'ghost', onclick: () => this.save(f, 'dtcg') }, 'Download'),
        h('button', { class: 'ghost danger', onclick: () => removeFile(f.id), 'aria-label': 'Remove file' }, 'Remove'),
        notes
          ? masked(
              h(
                'div',
                { class: 'export-notes' },
                h('strong', null, `${plural(notes.length, 'value')} couldn't be converted back to ${kind}:`),
                h('ul', null, notes.map((n) => h('li', null, n))),
              ),
            )
          : null,
      );
    });

    const lastUndo = past.at(-1)?.label;
    const nextRedo = future[0]?.label;
    this.replaceChildren(
      h('h2', null, 'Files'),
      h('ul', { class: 'file-list' }, rows),
      h(
        'div',
        { class: 'toolbar' },
        h('button', { disabled: !lastUndo, onclick: undo, title: lastUndo ? `Undo: ${lastUndo}` : 'Nothing to undo' }, 'Undo'),
        h('button', { disabled: !nextRedo, onclick: redo, title: nextRedo ? `Redo: ${nextRedo}` : 'Nothing to redo' }, 'Redo'),
        h('span', { class: 'spacer' }),
        files.length > 1 ? h('button', { onclick: () => files.forEach((f) => download(f.name, exportAs(f).text)) }, 'Download all (DTCG)') : null,
        h('button', { class: 'ghost danger', onclick: clearAll }, 'Clear all'),
      ),
    );
  }
}
