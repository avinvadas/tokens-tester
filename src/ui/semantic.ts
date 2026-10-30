import { formatContrast } from '../contrast/metrics';
import type { Model } from '../model/types';
import { aliasCandidates, checkColors, realias, type PairCheck, type PairKind } from '../semantic/pairs';
import { addPair, allModels, applyEdits, removePair, resetPairs, setPairKind, store, type AppState } from '../state/app';
import { pairsOf, type PairRow } from '../state/pairs';
import { displayGamut, paintAll, pairCanvas } from './canvas';
import { targetToggles } from './contrast';
import { swatchSelect } from './swatch-select';
import { h, icon, masked, plural, severityIcon } from './dom';
import { TIP } from './tips';

const KINDS: { id: PairKind; label: string }[] = [
  { id: 'text', label: 'Text' },
  { id: 'ui', label: 'UI part' },
];

type View = Pick<AppState, 'model' | 'themeModels' | 'themes' | 'pairEdits' | 'settings'>;

/** How a failing pair is marked: text that can't be read is an error, a faint UI part a warning. */
const failTone = (kind: PairKind) => (kind === 'text' ? 'error' : 'warning');

/**
 * Semantic: foreground/background pairs found by name, each checked for
 * contrast in every theme. Pairs can be removed, re-kinded or added by hand.
 */
export class TTSemantic extends HTMLElement {
  private unsub?: () => void;
  private onlyFailing = false;
  /** Pairs whose re-alias panel is open. */
  private open = new Set<string>();
  // Canvases painted while the view is hidden have no size: paint again once it shows.
  private resize = new ResizeObserver(() => paintAll(this));

  connectedCallback() {
    this.resize.observe(this);
    this.unsub = store.select(
      (s): View => s,
      () => this.render(store.get()),
      (a, b) => a.model === b.model && a.themeModels === b.themeModels && a.pairEdits === b.pairEdits && a.settings === b.settings,
    );
  }

  disconnectedCallback() {
    this.unsub?.();
    this.resize.disconnect();
  }

  private render(v: View) {
    const { rows, colorIds, edited } = pairsOf(store.get());
    const failing = rows.filter((r) => !r.pass);
    const failText = failing.filter((r) => r.pair.kind === 'text').length;
    const failUi = failing.length - failText;
    const shown = this.onlyFailing ? failing : rows;
    const targets = v.settings.contrast;
    const themeNames = v.themeModels.length ? v.themeModels.map((m) => m.theme.name) : [null];

    this.replaceChildren(
      h(
        'div',
        { class: 'semantic-head' },
        h(
          'h2',
          null,
          'Semantic pairs ',
          h(
            'span',
            { class: 'counts' },
            h('span', { class: 'n' }, plural(rows.length, 'pair')),
            failText ? h('span', { class: 'chip error', 'data-tip': TIP.pairFailText }, severityIcon('error'), `${failText} text failing`) : null,
            failUi ? h('span', { class: 'chip warning', 'data-tip': TIP.pairFailUi }, severityIcon('warning'), `${failUi} UI failing`) : null,
            rows.length && !failing.length && targets.length ? h('span', { class: 'badge ok' }, icon('check'), ' All pass') : null,
          ),
        ),
      ),
      h('div', { class: 'contrast-controls' }, h('span', { class: 'label' }, 'Contrast:'), targetToggles(v.settings)),
      h(
        'p',
        { class: 'meta' },
        'Pairs are found from token names: a foreground (text, fg, icon, border, on-…) is checked on the background (bg, surface, container…) that shares its other words, such as “danger” or “subtle hover”, or else on the default background. ',
        'Text must reach the text level; icons and borders the level for UI parts.',
        themeNames.length > 1 ? ' Each pair is checked in every theme and fails if it fails in any.' : '',
      ),
      targets.length === 0 ? h('p', { class: 'note' }, 'Pick a contrast target above to check the pairs.') : '',
      rows.length
        ? h(
            'div',
            { class: 'toolbar' },
            h(
              'div',
              { class: 'segmented', role: 'radiogroup', 'aria-label': 'Pairs shown' },
              [
                [false, 'All'],
                [true, `Failing (${failing.length})`],
              ].map(([value, label]) =>
                h(
                  'button',
                  {
                    type: 'button',
                    role: 'radio',
                    class: this.onlyFailing === value ? 'on' : '',
                    'aria-checked': String(this.onlyFailing === value),
                    onclick: () => {
                      this.onlyFailing = value as boolean;
                      this.render(store.get());
                    },
                  },
                  label as string,
                ),
              ),
            ),
            h('span', { class: 'spacer' }),
            edited ? h('button', { type: 'button', class: 'link', 'data-tip': TIP.pairsReset, onclick: resetPairs }, 'Reset to the pairs found by name') : null,
          )
        : h('p', { class: 'empty' }, 'No pairs found by name. Add pairs below to check them, or name semantic tokens with words such as bg, surface, text, icon or on-….'),
      shown.length ? this.table(shown, themeNames, v) : rows.length ? h('p', { class: 'empty' }, 'Every pair passes.') : '',
      colorIds.length ? this.addForm(colorIds) : '',
    );
    requestAnimationFrame(() => paintAll(this));
  }

  private table(rows: PairRow[], themeNames: (string | null)[], v: View) {
    return masked(
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'pairs' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', null, 'Foreground'),
              h('th', null, 'Background'),
              h('th', { 'data-tip': TIP.pairKind }, 'Kind'),
              themeNames.map((n) => h('th', null, n ?? 'Contrast')),
              h('th', null, h('span', { class: 'visually-hidden' }, 'Actions')),
            ),
          ),
          h(
            'tbody',
            null,
            rows.flatMap((r) => {
              const open = this.open.has(r.pair.id);
              const row = h(
                'tr',
                { class: [r.pass ? '' : `fail ${failTone(r.pair.kind)}`, open ? 'open' : ''].join(' ').trim() },
                h('td', { class: 'token-id' }, r.pair.fg),
                h('td', { class: 'token-id' }, r.pair.bg, r.pair.source === 'user' ? h('small', { class: 'added', 'data-tip': TIP.pairAdded }, ' added') : null),
                h('td', null, this.kindSelect(r)),
                r.checks.map((c) => h('td', null, this.result(c, r.pair.kind, v))),
                h(
                  'td',
                  { class: 'pair-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      class: `ghost small${open ? ' on' : ''}`,
                      'aria-expanded': String(open),
                      'aria-label': 'Change aliases',
                      'data-tip': TIP.pairRealias,
                      onclick: () => {
                        if (open) this.open.delete(r.pair.id);
                        else this.open.add(r.pair.id);
                        this.render(store.get());
                      },
                    },
                    icon('arrows-exchange'),
                  ),
                  h('button', { type: 'button', class: 'ghost small danger', 'aria-label': 'Remove pair', 'data-tip': TIP.pairRemove, onclick: () => removePair(r.pair.id) }, '×'),
                ),
              );
              return open ? [row, this.realiasRow(r, themeNames, v)] : [row];
            }),
          ),
        ),
      ),
    );
  }

  /**
   * Point the pair's tokens at other existing tokens, theme by theme. Each
   * option shows the contrast it would give against the other side as it is now.
   */
  private realiasRow(r: PairRow, themeNames: (string | null)[], v: View) {
    const models = allModels(store.get());
    const files = new Map(store.get().files.map((f) => [f.id, f.name]));
    const gamut = displayGamut(v.settings.gamut);
    const theme = (model: Model, i: number) => {
      const c = r.checks[i];
      const side = (role: 'fg' | 'bg') => {
        const id = r.pair[role];
        const t = model.tokens.get(id);
        const label = role === 'fg' ? 'Foreground' : 'Background';
        if (!t) return h('div', { class: 'alias-side' }, h('span', { class: 'label' }, label), h('span', { class: 'muted' }, 'Not in this theme'));
        if (!t.aliasOf || !c) return h('div', { class: 'alias-side' }, h('span', { class: 'label' }, label), h('span', { class: 'muted', 'data-tip': TIP.pairOwnValue }, 'Has its own value, not a reference'));
        const groups = aliasCandidates(model).map((g) => ({
          label: g.label,
          options: g.tokens.map((cand) => {
            const check = role === 'fg' ? checkColors(cand.info, c.bg, r.pair.kind, v.settings.contrast) : checkColors(c.fg, cand.info, r.pair.kind, v.settings.contrast);
            const first = check.results[0];
            return { value: cand.id, label: cand.id, meta: first ? `${formatContrast(first.value, first.level.metric)} ${check.pass ? '✓' : '✗'}` : undefined, info: cand.info };
          }),
        }));
        return h(
          'div',
          { class: 'alias-side' },
          h('span', { class: 'label' }, label),
          swatchSelect({
            label: `${themeNames[i] ?? ''} ${label.toLowerCase()} reference of ${id}`.trim(),
            groups,
            value: t.aliasOf,
            gamut,
            fallback: { label: t.aliasOf, info: role === 'fg' ? c.fg : c.bg },
            onPick: (target) => {
              const edit = realias(model, id, target);
              if (edit) applyEdits(`Point ${id} at ${target}${themeNames[i] ? ` in ${themeNames[i]}` : ''}`, [edit]);
            },
          }),
          h('small', { class: 'muted', 'data-tip': TIP.pairRealiasFile }, `in ${files.get(t.fileId) ?? 'its file'}`),
        );
      };
      return h('div', { class: 'alias-theme' }, themeNames[i] ? h('strong', null, themeNames[i]) : null, side('fg'), side('bg'));
    };
    return h(
      'tr',
      { class: 'pair-detail' },
      h('td', { colspan: 4 + themeNames.length }, h('div', { class: 'alias-themes' }, models.map(theme)), h('p', { class: 'hint' }, 'Only the reference changes; no color values are written. Undo with ⌘Z.')),
    );
  }

  private kindSelect(r: PairRow) {
    const select = h(
      'select',
      { 'aria-label': 'Kind', 'data-tip': TIP.pairKind },
      KINDS.map((k) => h('option', { value: k.id, selected: k.id === r.pair.kind }, k.label)),
    );
    select.addEventListener('change', () => setPairKind(r.pair.id, select.value as PairKind));
    return select;
  }

  private result(c: PairCheck | undefined, kind: PairKind, v: View) {
    if (!c) return h('span', { class: 'muted', 'data-tip': TIP.pairMissing }, '—');
    return h(
      'div',
      { class: `pair-result${c.pass ? '' : ' fail'}` },
      pairCanvas(c.shown, c.bg, kind, displayGamut(v.settings.gamut)),
      h(
        'div',
        { class: 'pair-values' },
        c.results.map((x) =>
          h(
            'span',
            { class: x.pass ? 'pass' : `miss ${failTone(kind)}`, 'data-tip': `${x.level.label}: ${x.pass ? 'passes' : 'fails'}` },
            x.pass ? icon('check') : severityIcon(failTone(kind)),
            ` ${formatContrast(x.value, x.level.metric)} `,
            h('small', null, x.level.short),
          ),
        ),
      ),
    );
  }

  private addForm(colorIds: string[]) {
    const list = masked(h('datalist', { id: 'tt-color-ids' }, colorIds.map((id) => h('option', { value: id }))));
    const field = (label: string, id: string) =>
      h('label', { class: 'field' }, h('span', null, label), masked(h('input', { type: 'text', id, list: 'tt-color-ids', autocomplete: 'off', spellcheck: 'false', placeholder: 'color token' })));
    const fg = field('Foreground', 'tt-pair-fg');
    const bg = field('Background', 'tt-pair-bg');
    const kind = h('select', { 'aria-label': 'Kind' }, KINDS.map((k) => h('option', { value: k.id }, k.label)));
    const message = h('small', { class: 'hint', role: 'status' });
    const known = new Set(colorIds);
    return h(
      'form',
      {
        class: 'add-pair',
        onsubmit: (e: Event) => {
          e.preventDefault();
          const f = fg.querySelector('input')!.value.trim();
          const b = bg.querySelector('input')!.value.trim();
          const unknown = [f, b].find((id) => !known.has(id));
          if (unknown !== undefined) {
            message.textContent = unknown ? 'Pick color tokens from the list.' : 'Enter both tokens.';
            return;
          }
          if (f === b) {
            message.textContent = 'Pick two different tokens.';
            return;
          }
          addPair(f, b, kind.value as PairKind);
        },
      },
      h('strong', null, 'Add a pair'),
      h('div', { class: 'row' }, fg, bg, kind, h('button', { type: 'submit' }, 'Add')),
      message,
      list,
    );
  }
}
