import { isUnchanged } from '../io/export';
import { ACCEPT, fetchSource, isLoadError, normalizeUrl, parseSource, pickFiles, readFiles, reloadSource, type RawSource } from '../io/load';
import type { SourceFile } from '../model/types';
import { addFiles, replaceFiles, setBusy, store, type LoadError } from '../state/app';
import { h, masked, plural } from './dom';

/** Parse sources and add them to the store, collecting errors for display. */
export async function ingest(pending: Promise<(RawSource | LoadError)[]>) {
  setBusy(true);
  try {
    const files: SourceFile[] = [];
    const errors: LoadError[] = [];
    for (const r of await pending) {
      const parsed = 'text' in r ? parseSource(r, store.get().settings) : r;
      if (isLoadError(parsed)) errors.push(parsed);
      else files.push(parsed);
    }
    addFiles(files, errors);
  } finally {
    setBusy(false);
  }
}

/**
 * Read every loaded file from its source again (disk or URL) and re-run the
 * checks. Files whose source and content are unchanged keep their undo
 * history. Returns a short summary, or null if the user cancelled.
 */
export async function reloadAll(): Promise<string | null> {
  const files = store.get().files;
  const edited = files.filter((f) => !isUnchanged(f));
  if (edited.length && !confirm(`Reloading replaces your unsaved edits in ${edited.map((f) => f.name).join(', ')}. Continue?`)) return null;
  setBusy(true);
  try {
    const results = await Promise.all(files.map(async (f) => [f, await reloadSource(f)] as const));
    const updated: SourceFile[] = [];
    const errors: LoadError[] = [];
    let changed = 0;
    for (const [old, r] of results) {
      const parsed = 'text' in r ? parseSource(r, store.get().settings) : r;
      if (isLoadError(parsed)) {
        errors.push({ ...parsed, name: old.name });
        continue;
      }
      const textChanged = parsed.text !== old.text;
      if (textChanged) changed++;
      if (textChanged || edited.includes(old)) updated.push({ ...parsed, id: old.id, name: old.name });
    }
    replaceFiles(updated, errors);
    const parts = [changed ? `${plural(changed, 'file')} changed` : 'No changes in the source files'];
    if (errors.length) parts.push(`${plural(errors.length, 'file')} couldn't be reloaded`);
    return parts.join(' · ');
  } finally {
    setBusy(false);
  }
}

export class TTLoader extends HTMLElement {
  private unsubs: (() => void)[] = [];

  connectedCallback() {
    const input = h('input', {
      type: 'file',
      class: 'visually-hidden',
      tabindex: '-1',
      'aria-hidden': 'true',
      multiple: true,
      accept: ACCEPT,
      onchange: () => {
        if (input.files?.length) void ingest(readFiles(input.files));
        input.value = '';
      },
    });

    const zone = h(
      'button',
      {
        type: 'button',
        class: 'dropzone',
        onclick: async () => {
          const picked = await pickFiles(input);
          if (picked) void ingest(Promise.resolve(picked));
        },
      },
      h('strong', null, 'Drop token files here'),
      h('span', null, 'or click to choose files'),
      h('small', null, 'DTCG .json or .tokens files. Load several at once, such as primitives and semantic.'),
    );

    const url = masked(h('input', { type: 'url', id: 'tt-url', placeholder: 'https://…/tokens.json', autocomplete: 'off', spellcheck: 'false', required: true }));
    const hint = h('small', { class: 'hint' }, 'Only the address you enter is requested, without cookies or referrer.');
    url.addEventListener('input', () => {
      let rewritten = false;
      try {
        rewritten = normalizeUrl(url.value).rewritten;
      } catch {
        /* not a URL yet */
      }
      hint.textContent = rewritten
        ? 'GitHub page link detected: the raw file will be loaded instead.'
        : 'Only the address you enter is requested, without cookies or referrer.';
    });
    const submit = h('button', { type: 'submit' }, 'Load');
    const form = h(
      'form',
      {
        class: 'url-form',
        onsubmit: (e: Event) => {
          e.preventDefault();
          if (url.value.trim()) void ingest(fetchSource(url.value).then((r) => [r]));
        },
      },
      h('label', { for: 'tt-url' }, 'Or load from a URL'),
      h('div', { class: 'row' }, url, submit),
      hint,
    );

    const errors = masked(h('div', { class: 'load-errors', role: 'alert' }));

    this.replaceChildren(h('div', { class: 'loader' }, input, zone, form), errors);

    this.unsubs.push(
      store.select(
        (s) => s.busy,
        (busy) => {
          this.toggleAttribute('aria-busy', busy);
          submit.disabled = busy;
          submit.textContent = busy ? 'Loading…' : 'Load';
        },
      ),
      store.select(
        (s) => s.loadErrors,
        (list) =>
          errors.replaceChildren(
            ...list.map((e) =>
              h(
                'div',
                { class: 'load-error' },
                h('strong', null, e.name),
                e.line ? ` (line ${e.line}, column ${e.col})` : '',
                h('p', null, e.message),
                e.excerpt ? h('pre', null, e.excerpt) : null,
              ),
            ),
          ),
      ),
    );
  }

  disconnectedCallback() {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
  }
}
