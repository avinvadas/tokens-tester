import { ALL_THEMES, setActiveTheme, store, type AppState } from '../state/app';
import { palettesOf } from '../state/palettes';
import { h, masked } from './dom';
import { TIP } from './tips';

/**
 * Sidebar navigation and view switching. One view is shown at a time; the
 * current one is kept in the URL hash (view names only, never token data) so
 * the back button and reloads work.
 */

export type ViewId = 'files' | 'themes' | 'issues' | 'colors' | 'semantic' | 'tokens' | 'privacy';

interface ViewDef {
  id: ViewId;
  label: string;
  needsFiles: boolean;
  /** Planned but not built yet: listed, not selectable. */
  soon?: boolean;
  tip: string;
}

const VIEWS: ViewDef[] = [
  { id: 'files', label: 'Files', needsFiles: false, tip: TIP.navFiles },
  { id: 'themes', label: 'Themes', needsFiles: true, tip: TIP.navThemes },
  { id: 'issues', label: 'Issues', needsFiles: true, tip: TIP.navIssues },
  { id: 'colors', label: 'Base colors', needsFiles: true, tip: TIP.navColors },
  { id: 'semantic', label: 'Semantic & vision', needsFiles: true, soon: true, tip: TIP.navSemantic },
  { id: 'tokens', label: 'Tokens', needsFiles: true, tip: TIP.navTokens },
];

const isView = (v: string): v is ViewId => VIEWS.some((d) => d.id === v) || v === 'privacy';

function requested(): ViewId {
  const id = location.hash.slice(1);
  return isView(id) ? id : 'files';
}

/** The view that can actually be shown for a request, given what is loaded. */
function resolve(id: ViewId, hasFiles: boolean): ViewId {
  const def = VIEWS.find((d) => d.id === id);
  if (def?.soon) return hasFiles ? 'issues' : 'files';
  if (def?.needsFiles && !hasFiles) return 'files';
  return id;
}

export function goTo(id: ViewId) {
  if (location.hash.slice(1) === id) show(resolve(id, store.get().files.length > 0));
  else location.hash = id;
}

function show(id: ViewId) {
  for (const el of document.querySelectorAll<HTMLElement>('.view')) el.hidden = el.dataset.view !== id;
  for (const a of document.querySelectorAll<HTMLElement>('[data-nav]')) {
    if (a.dataset.nav === id) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  document.querySelector('.workspace')?.scrollTo?.(0, 0);
  window.scrollTo(0, 0);
  current = id;
}

let current: ViewId = 'files';

type View = Pick<AppState, 'files' | 'model' | 'themes' | 'activeTheme'>;

export class TTNav extends HTMLElement {
  private unsub?: () => void;
  private onHash = () => show(resolve(requested(), store.get().files.length > 0));

  connectedCallback() {
    window.addEventListener('hashchange', this.onHash);
    let hadFiles = false;
    this.unsub = store.select(
      (s): View => s,
      (v) => {
        const has = v.files.length > 0;
        this.render(v);
        // First files loaded from the Files view: move on to the results.
        if (has && !hadFiles && current === 'files' && requested() === 'files') goTo('issues');
        else show(resolve(requested(), has));
        hadFiles = has;
      },
      (a, b) => a.files === b.files && a.model === b.model && a.themes === b.themes && a.activeTheme === b.activeTheme,
    );
  }

  disconnectedCallback() {
    this.unsub?.();
    window.removeEventListener('hashchange', this.onHash);
  }

  private render(v: View) {
    const has = v.files.length > 0;
    const errors = v.model.issues.filter((i) => i.severity === 'error').length;
    const warnings = v.model.issues.filter((i) => i.severity === 'warning').length;
    const palettes = has ? palettesOf(store.get()).palettes.filter((p) => p.included).length : 0;
    const counts: Partial<Record<ViewId, { n: number; tone?: 'error' | 'warning' }>> = has
      ? {
          files: { n: v.files.length },
          themes: v.themes.length ? { n: v.themes.length } : undefined,
          issues: { n: errors + warnings, tone: errors ? 'error' : warnings ? 'warning' : undefined },
          colors: { n: palettes },
          tokens: { n: v.model.tokens.size },
        }
      : {};

    const items = VIEWS.map((d) => {
      const disabled = d.soon || (d.needsFiles && !has);
      const c = counts[d.id];
      return h(
        'a',
        {
          class: `nav-item${d.soon ? ' soon' : ''}`,
          href: disabled ? undefined : `#${d.id}`,
          'data-nav': d.id,
          'aria-disabled': disabled ? 'true' : undefined,
          'aria-current': d.id === current ? 'page' : undefined,
          'data-tip': d.tip,
        },
        h('span', null, d.label),
        d.soon ? h('span', { class: 'soon-tag' }, 'Soon') : c && c.n > 0 ? h('span', { class: `count${c.tone ? ` ${c.tone}` : ''}` }, String(c.n)) : null,
      );
    });

    this.replaceChildren(h('nav', { class: 'nav', 'aria-label': 'Sections' }, items.slice(0, 2), h('div', { class: 'nav-sep', role: 'separator' }), items.slice(2)), this.themePicker(v));
  }

  /** Active theme, shown wherever results depend on it. Theme names come from the files, so the picker is masked. */
  private themePicker(v: View) {
    if (v.themes.length < 2) return '';
    const select = h(
      'select',
      { id: 'tt-theme-pick', 'data-tip': TIP.themePick },
      h('option', { value: ALL_THEMES, selected: v.activeTheme === ALL_THEMES }, 'All themes'),
      v.themes.map((t) => h('option', { value: t.id, selected: t.id === v.activeTheme }, t.name)),
    );
    select.addEventListener('change', () => setActiveTheme(select.value));
    return h('div', { class: 'theme-pick' }, h('label', { for: 'tt-theme-pick' }, 'Theme'), masked(select));
  }
}
