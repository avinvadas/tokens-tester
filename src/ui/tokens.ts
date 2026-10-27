import { colorInfo, formatColor } from '../color/format';
import type { Model, Settings, Token } from '../model/types';
import { ALL_THEMES, store } from '../state/app';
import type { ThemeModel } from '../themes/merge';
import { h, masked, plural } from './dom';
import { TIP } from './tips';

const PAGE = 300;

/** Short, readable text for a token value; colors use the chosen display format. */
export function formatValue(v: unknown, format: Settings['colorFormat'] = 'oklch'): string {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (typeof o.colorSpace === 'string' && Array.isArray(o.components)) {
      const info = colorInfo(o);
      if (info) {
        const f = formatColor(info, format);
        return f.approx ? `≈ ${f.text}` : f.text;
      }
      return `${o.colorSpace}(${o.components.join(' ')})`;
    }
    if (typeof o.value === 'number' && typeof o.unit === 'string' && Object.keys(o).length === 2) return `${o.value}${o.unit}`;
  }
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 90 ? `${s.slice(0, 89)}…` : s;
}

export class TTTokens extends HTMLElement {
  private unsub?: () => void;
  private model?: Model;
  private format: Settings['colorFormat'] = 'oklch';
  private query = '';
  private type = '';
  private limit = PAGE;
  private body = h('tbody');
  private head = h('thead');
  /** In the all-themes view: one model per theme, shown as one column each. */
  private themes: ThemeModel[] = [];
  private summary = h('p', { class: 'summary' });
  private typeSelect = h('select', { 'aria-label': 'Filter by type' });

  connectedCallback() {
    const search = h('input', { type: 'search', placeholder: 'Filter by name or value', 'aria-label': 'Filter tokens' });
    search.addEventListener('input', () => {
      this.query = search.value.trim().toLowerCase();
      this.limit = PAGE;
      this.renderRows();
    });
    this.typeSelect.addEventListener('change', () => {
      this.type = this.typeSelect.value;
      this.limit = PAGE;
      this.renderRows();
    });

    this.replaceChildren(
      h('h2', null, 'Tokens'),
      h('div', { class: 'toolbar' }, masked(search), masked(this.typeSelect)),
      masked(this.summary),
      masked(
        h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'tokens' },
            this.head,
            this.body,
          ),
        ),
      ),
    );
    this.unsub = store.select(
      (s) => [s.model, s.settings.colorFormat, s.themeModels, s.activeTheme] as const,
      ([m, format, themeModels, active]) => {
        this.model = m;
        this.format = format;
        this.themes = active === ALL_THEMES && themeModels.length > 1 ? themeModels : [];
        this.renderHead();
        this.renderTypes();
        this.renderRows();
      },
      (a, b) => a.every((x, i) => x === b[i]),
    );
  }

  private renderHead() {
    const cols = this.themes.length
      ? this.themes.map((t) => h('th', null, t.theme.name))
      : [h('th', { 'data-tip': TIP.colValue }, 'Value'), h('th', { 'data-tip': TIP.colResolved }, 'Resolved')];
    this.head.replaceChildren(h('tr', null, h('th', null, 'Token'), h('th', null, 'Type'), cols));
  }

  disconnectedCallback() {
    this.unsub?.();
  }

  private renderTypes() {
    const types = [...new Set([...(this.model?.tokens.values() ?? [])].map((t) => t.type ?? '(no type)'))].sort();
    if (this.type && !types.includes(this.type)) this.type = '';
    this.typeSelect.replaceChildren(
      h('option', { value: '' }, 'All types'),
      ...types.map((t) => h('option', { value: t, selected: t === this.type }, t)),
    );
  }

  /** Tokens to list: the active model's, or every theme's (each id once, in first-seen order). */
  private tokens(): Token[] {
    if (!this.themes.length) return [...(this.model?.tokens.values() ?? [])].sort((a, b) => a.order - b.order);
    const seen = new Map<string, Token>();
    for (const { model } of this.themes) {
      for (const t of [...model.tokens.values()].sort((a, b) => a.order - b.order)) if (!seen.has(t.id)) seen.set(t.id, t);
    }
    return [...seen.values()];
  }

  private renderRows() {
    const all = this.tokens();
    const q = this.query;
    const rows = all.filter(
      (t) =>
        (!this.type || (t.type ?? '(no type)') === this.type) &&
        (!q || t.id.toLowerCase().includes(q) || formatValue(t.rawValue).toLowerCase().includes(q)),
    );
    const shown = rows.slice(0, this.limit);
    this.summary.replaceChildren(rows.length === all.length ? plural(all.length, 'token') : `${rows.length} of ${plural(all.length, 'token')}`);
    if (rows.length > shown.length) {
      this.summary.append(' · ', h('button', { class: 'link', onclick: () => ((this.limit = Infinity), this.renderRows()) }, `Show all ${rows.length}`));
    }
    this.body.replaceChildren(...shown.map((t) => (this.themes.length ? themedRow(t, this.themes, this.format) : row(t, this.format))));
  }
}

function row(t: Token, format: Settings['colorFormat']) {
  return h(
    'tr',
    { class: t.resolution === 'broken' ? 'broken' : undefined },
    h(
      'td',
      { class: 'name' },
      h('code', null, t.id),
      t.extendedFrom ? h('small', { class: 'tag', 'data-tip': TIP.extendedFrom }, `from ${t.extendedFrom}`) : null,
      t.deprecated ? h('small', { class: 'tag warn', 'data-tip': TIP.deprecated }, 'deprecated') : null,
    ),
    h('td', { class: 'type' }, t.type ?? h('em', { 'data-tip': TIP.noType }, 'none')),
    h('td', { class: 'value' }, t.aliasOf ? h('code', { class: 'alias', 'data-tip': TIP.alias }, `→ {${t.aliasOf}}`) : h('code', null, formatValue(t.rawValue, format))),
    h('td', { class: 'resolved' }, t.resolution === 'broken' ? h('em', { 'data-tip': TIP.unresolved }, 'unresolved') : h('code', null, formatValue(t.value, format))),
  );
}

/** One row in the all-themes view: the token's value and resolution in each theme. */
function themedRow(first: Token, themes: ThemeModel[], format: Settings['colorFormat']) {
  const per = themes.map((m) => m.model.tokens.get(first.id));
  const broken = per.some((t) => t?.resolution === 'broken');
  return h(
    'tr',
    { class: broken ? 'broken' : undefined },
    h('td', { class: 'name' }, h('code', null, first.id)),
    h('td', { class: 'type' }, first.type ?? h('em', { 'data-tip': TIP.noType }, 'none')),
    per.map((t) =>
      h(
        'td',
        { class: 'resolved' },
        !t
          ? h('em', { 'data-tip': TIP.notInTheme }, 'not in this theme')
          : [
              t.aliasOf ? h('code', { class: 'alias', 'data-tip': TIP.alias }, `→ {${t.aliasOf}}`) : null,
              t.aliasOf ? h('br') : null,
              t.resolution === 'broken' ? h('em', { 'data-tip': TIP.unresolved }, 'unresolved') : h('code', null, formatValue(t.value, format)),
            ],
      ),
    ),
  );
}
