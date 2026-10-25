import { isStudioMetaFile } from '../model/format';
import type { ThemeSource } from '../themes/detect';
import {
  addTheme,
  ALL_THEMES,
  removeTheme,
  renameTheme,
  resetThemes,
  setActiveTheme,
  setThemeFile,
  store,
  type AppState,
} from '../state/app';
import { h, masked } from './dom';

const SOURCE: Record<ThemeSource, string> = {
  'tokens-studio': 'Read from the Tokens Studio themes in your files.',
  'file-names': 'Detected from file names. Files without a theme word are shared by every theme.',
  modes: 'Read from per-mode values in “$extensions”.',
  manual: 'Set up by you.',
};

type View = Pick<AppState, 'files' | 'themes' | 'themesCustomized' | 'activeTheme' | 'themeModels'>;

/** Themes: a switcher for the active theme and a files × themes matrix to edit what each theme reads. */
export class TTThemes extends HTMLElement {
  private unsub?: () => void;

  connectedCallback() {
    this.unsub = store.select(
      (s): View => s,
      (v) => this.render(v),
      (a, b) => a.files === b.files && a.themes === b.themes && a.activeTheme === b.activeTheme && a.themeModels === b.themeModels,
    );
  }

  disconnectedCallback() {
    this.unsub?.();
  }

  private render(v: View) {
    const files = v.files.filter((f) => !isStudioMetaFile(f));
    if (v.themes.length === 0) {
      // Say why there's no switcher, rather than hiding the panel.
      this.replaceChildren(
        h('h2', null, 'Themes'),
        h(
          'p',
          { class: 'meta' },
          files.length < 2 ? 'No themes found: this file describes a single theme. ' : 'No themes found: all files are read together as one set. ',
          'Themes are read from Tokens Studio “$themes”, from file names such as semantic.light.json and semantic.dark.json, or from per-mode values in “$extensions”.',
        ),
        h(
          'div',
          null,
          files.length >= 2
            ? [
                h('p', { class: 'meta' }, 'If some of these files are alternatives of each other, add themes so each one is checked on its own over the shared files.'),
                h('button', { type: 'button', onclick: addTheme }, 'Add themes'),
              ]
            : null,
        ),
      );
      return;
    }

    const source = v.themesCustomized ? 'manual' : v.themes[0]!.source;
    const counts = new Map(v.themeModels.map((m) => [m.theme.id, m.model.issues.filter((i) => i.severity === 'error').length]));

    this.replaceChildren(
      h('div', { class: 'themes-head' }, h('h2', null, 'Themes'), this.switcher(v)),
      h(
        'p',
        { class: 'meta' },
        SOURCE[source],
        v.themesCustomized ? h('button', { type: 'button', class: 'link', onclick: resetThemes }, ' Detect again') : null,
      ),
      masked(
        h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'theme-matrix' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', null, 'File'),
                v.themes.map((t) => {
                  const name = h('input', { type: 'text', value: t.name, 'aria-label': 'Theme name', size: Math.max(6, t.name.length) });
                  name.addEventListener('change', () => renameTheme(t.id, name.value));
                  return h(
                    'th',
                    null,
                    h(
                      'div',
                      { class: 'theme-name' },
                      name,
                      h('button', { type: 'button', class: 'ghost small danger', 'aria-label': 'Remove theme', onclick: () => removeTheme(t.id) }, '×'),
                    ),
                    t.scope.mode !== undefined ? h('small', null, `mode “${t.scope.mode}”`) : null,
                  );
                }),
              ),
            ),
            h(
              'tbody',
              null,
              files.map((f) =>
                h(
                  'tr',
                  null,
                  h('td', { class: 'file-name' }, f.name),
                  v.themes.map((t) => {
                    const box = h('input', { type: 'checkbox', checked: t.fileIds.includes(f.id), 'aria-label': 'Read this file in this theme' });
                    box.addEventListener('change', () => setThemeFile(t.id, f.id, box.checked));
                    const sets = t.scope.sets?.[f.id];
                    return h('td', null, box, sets ? h('small', null, ` sets: ${sets.join(', ') || 'none'}`) : null);
                  }),
                ),
              ),
            ),
            h(
              'tfoot',
              null,
              h(
                'tr',
                null,
                h('td', null, 'Errors'),
                v.themes.map((t) => h('td', { class: counts.get(t.id) ? 'bad' : 'good' }, String(counts.get(t.id) ?? 0))),
              ),
            ),
          ),
        ),
      ),
      h('button', { type: 'button', class: 'add-theme', onclick: addTheme }, 'Add theme'),
    );
  }

  private switcher(v: View) {
    const options = [{ id: ALL_THEMES, name: 'All themes' }, ...v.themes];
    return masked(
      h(
        'div',
        { class: 'segmented', role: 'radiogroup', 'aria-label': 'Active theme' },
        options.map((o) =>
          h(
            'button',
            {
              type: 'button',
              role: 'radio',
              'aria-checked': String(o.id === v.activeTheme),
              class: o.id === v.activeTheme ? 'on' : undefined,
              onclick: () => setActiveTheme(o.id),
            },
            o.name,
          ),
        ),
      ),
    );
  }
}
