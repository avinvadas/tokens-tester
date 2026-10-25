import { colorInfo, formatColor } from '../color/format';
import type { Model, Settings, Token } from '../model/types';
import { store } from '../state/app';
import { h, masked, plural } from './dom';

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
            h('thead', null, h('tr', null, h('th', null, 'Token'), h('th', null, 'Type'), h('th', null, 'Value'), h('th', null, 'Resolved'))),
            this.body,
          ),
        ),
      ),
    );
    this.unsub = store.select(
      (s) => [s.model, s.settings.colorFormat] as const,
      ([m, format]) => {
        this.model = m;
        this.format = format;
        this.renderTypes();
        this.renderRows();
      },
      (a, b) => a[0] === b[0] && a[1] === b[1],
    );
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

  private renderRows() {
    const all = [...(this.model?.tokens.values() ?? [])].sort((a, b) => a.order - b.order);
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
    this.body.replaceChildren(...shown.map((t) => row(t, this.format)));
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
      t.extendedFrom ? h('small', { class: 'tag' }, `from ${t.extendedFrom}`) : null,
      t.deprecated ? h('small', { class: 'tag warn' }, 'deprecated') : null,
    ),
    h('td', { class: 'type' }, t.type ?? h('em', null, 'none')),
    h('td', { class: 'value' }, t.aliasOf ? h('code', { class: 'alias' }, `→ {${t.aliasOf}}`) : h('code', null, formatValue(t.rawValue, format))),
    h('td', { class: 'resolved' }, t.resolution === 'broken' ? h('em', null, 'unresolved') : h('code', null, formatValue(t.value, format))),
  );
}
