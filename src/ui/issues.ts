import type { Category, Fix, Issue, Model, Severity } from '../model/types';
import { applyFixes, store, undo } from '../state/app';
import { h, masked, plural } from './dom';
import { reloadAll } from './loader';

const SEVERITIES: Severity[] = ['error', 'warning', 'info'];
const SEVERITY_LABEL: Record<Severity, string> = { error: 'Error', warning: 'Warning', info: 'Info' };
const CATEGORIES: Category[] = ['format', 'structure', 'references', 'types', 'values', 'metadata'];
const CATEGORY_LABEL: Record<Category, string> = {
  format: 'File format',
  structure: 'Structure',
  references: 'References',
  types: 'Types',
  values: 'Values',
  metadata: 'Metadata',
};

const timeNow = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export class TTIssues extends HTMLElement {
  private unsubs: (() => void)[] = [];
  private status = h('span', { class: 'reload-status', role: 'status' });
  private reload = h(
    'button',
    { type: 'button', class: 'reload', title: 'Read the files again from disk or their URL and re-run the checks' },
    h('span', { 'aria-hidden': 'true' }, '↻ '),
    'Reload files',
  );

  connectedCallback() {
    this.reload.onclick = async () => {
      this.setStatus('');
      const summary = await reloadAll();
      if (summary) this.setStatus(`${summary} · ${timeNow()}`);
    };
    this.unsubs.push(
      store.select((s) => s.model, (m) => this.render(m)),
      store.select((s) => s.busy, (busy) => (this.reload.disabled = busy)),
    );
  }

  disconnectedCallback() {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
  }

  private setStatus(text: string, withUndo = false) {
    this.status.replaceChildren(text);
    if (withUndo) this.status.append(' · ', h('button', { type: 'button', class: 'link', onclick: () => (undo(), this.setStatus('Undone')) }, 'Undo'));
  }

  private apply(fixes: Fix[], label?: string) {
    const edits = fixes.filter((f) => 'edits' in f).length;
    applyFixes(fixes, label);
    this.setStatus(fixes.length === 1 ? `Applied: ${fixes[0]!.label}` : `Applied ${fixes.length} fixes`, edits > 0);
  }

  private render(model: Model) {
    const names = new Map(model.files.map((f) => [f.id, f.name]));
    const count = (s: Severity) => model.issues.filter((i) => i.severity === s).length;
    const where = (i: Issue) => {
      const name = i.fileId ? names.get(i.fileId) : undefined;
      if (!name) return '';
      return i.pos ? `${name}:${i.pos.line}:${i.pos.col}` : name;
    };

    const groups = CATEGORIES.map((c) => ({
      category: c,
      issues: model.issues
        .filter((i) => i.category === c)
        .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || (a.pos?.offset ?? 0) - (b.pos?.offset ?? 0)),
    })).filter((g) => g.issues.length > 0);

    this.replaceChildren(
      h(
        'div',
        { class: 'issues-head' },
        h(
          'h2',
          null,
          'Issues ',
          h('span', { class: 'counts' }, SEVERITIES.filter(count).map((s) => h('span', { class: `chip ${s}` }, plural(count(s), SEVERITY_LABEL[s].toLowerCase())))),
        ),
        h('div', { class: 'reload-wrap' }, this.status, this.reload),
      ),
      groups.length === 0
        ? h('p', { class: 'empty' }, model.files.length ? 'No problems found. The files follow the DTCG format.' : '')
        : h(
            'div',
            { class: 'issue-groups' },
            groups.map(({ category, issues }) => {
              const fixes = issues.map((i) => i.fix).filter((f): f is Fix => !!f);
              return h(
                'section',
                { class: 'issue-group' },
                h(
                  'div',
                  { class: 'group-head' },
                  h('h3', null, CATEGORY_LABEL[category], h('span', { class: 'n' }, String(issues.length))),
                  fixes.length > 1
                    ? h(
                        'button',
                        { type: 'button', class: 'fix-all', onclick: () => this.apply(fixes, `Fix ${fixes.length} ${CATEGORY_LABEL[category].toLowerCase()} issues`) },
                        `Apply ${fixes.length} fixes`,
                      )
                    : null,
                ),
                masked(h('ul', { class: 'issue-list' }, issues.map((i) => this.row(i, where(i))))),
              );
            }),
          ),
    );
  }

  private row(i: Issue, where: string) {
    const fix = i.fix;
    return h(
      'li',
      { class: `issue ${i.severity}` },
      h('span', { class: `sev ${i.severity}` }, SEVERITY_LABEL[i.severity]),
      h(
        'div',
        { class: 'body' },
        h('span', { class: 'msg' }, i.message),
        fix
          ? h(
              'div',
              { class: 'fix' },
              h('button', { type: 'button', class: 'fix-btn', onclick: () => this.apply([fix]) }, fix.label),
              fix.preview
                ? h('span', { class: 'preview' }, h('code', { class: 'before' }, fix.preview.before), h('span', { 'aria-label': 'becomes' }, ' → '), h('code', { class: 'after' }, fix.preview.after))
                : null,
            )
          : null,
      ),
      h('code', { class: 'where' }, where),
    );
  }
}
