import type { EndId, PaletteContrast } from '../contrast/analyze';
import { endCandidates } from '../contrast/ends';
import { TARGETS, type ContrastTarget } from '../contrast/levels';
import type { Settings } from '../model/types';
import type { Palette, PaletteSet } from '../palette/detect';
import { setContrastEnd, updateSettings } from '../state/app';
import type { ContrastView } from '../state/contrast';
import { displayGamut } from './canvas';
import { h, masked } from './dom';
import { swatchSelect } from './swatch-select';
import { TIP } from './tips';

/** UI pieces for contrast: target toggles, end pickers, step distance, parity. */

const END_LABEL: Record<EndId, string> = { light: 'Light end', dark: 'Dark end' };

export function contrastControls(settings: Settings, set: PaletteSet, view: ContrastView) {
  const toggle = (t: ContrastTarget, label: string) => {
    const on = settings.contrast.includes(t);
    return h(
      'button',
      {
        type: 'button',
        class: `chip-toggle${on ? ' on' : ''}`,
        'aria-pressed': String(on),
        'data-tip': TIP.targets[t],
        onclick: () => updateSettings({ contrast: on ? settings.contrast.filter((x) => x !== t) : [...settings.contrast, t] }),
      },
      label,
    );
  };
  const groups = endCandidates(set);
  // Each end is a neutral token, picked by name; only its lightness is used.
  // Tokens that would not stay on their side of the other end are disabled,
  // since every row between them would be empty.
  const picker = (end: EndId) => {
    const current = view.ends[end];
    const other = view.ends[end === 'light' ? 'dark' : 'light'].info.oklch.l;
    const ok = (l: number) => (end === 'light' ? l > other : l < other);
    const pct = (l: number) => `L ${+(l * 100).toFixed(1)}`;
    return h(
      'span',
      { class: 'end-picker' },
      h('span', { 'data-tip': TIP.endPicker }, `${END_LABEL[end]}:`),
      swatchSelect({
        label: END_LABEL[end],
        value: current.name,
        gamut: displayGamut(settings.gamut),
        groups: groups.map((g) => ({
          label: g.label,
          options: g.tokens.map((t) => ({ value: t.id, label: t.id, meta: pct(t.l), info: t.info, disabled: !ok(t.l) && t.id !== current.name })),
        })),
        fallback: { label: `${current.name} (no neutral tokens)`, info: current.info },
        onPick: (id) => setContrastEnd(end, id),
      }),
    );
  };
  return h(
    'div',
    { class: 'contrast-controls' },
    h('span', { class: 'label' }, 'Contrast:'),
    h('div', { class: 'chips', role: 'group', 'aria-label': 'Contrast compliance targets' }, TARGETS.map((t) => toggle(t.id, t.label))),
    settings.contrast.length ? [picker('light'), picker('dark')] : null,
    settings.contrast.length
      ? h('span', { class: 'legend' }, 'Pick a neutral token for each end of the system; only its lightness is used. Each row gets its own ends at that lightness, tinted with its hue, and marks where each level is first reached as text on them.')
      : null,
  );
}

/** The step-distance rule for one palette. Where each step passes is shown in the rails. */
export function paletteContrast(p: Palette, r: PaletteContrast | undefined, view: ContrastView) {
  if (!r || !view.levels.length) return null;

  const distances = r.distances.map((d) =>
    h(
      'li',
      null,
      h('b', null, d.level.label),
      ': ',
      d.distance !== undefined
        ? `any two steps ${d.distance} apart pass (e.g. ${d.example![0]} and ${d.example![1]}).`
        : 'no fixed distance works for every pair in this scale.',
    ),
  );

  return masked(
    h(
      'div',
      { class: 'palette-contrast' },
      h(
        'details',
        { class: 'distance' },
        h('summary', { 'data-tip': TIP.stepDistance }, 'Step distance within this scale'),
        h('ul', null, distances),
        h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'nearest' },
            h('thead', null, h('tr', null, h('th', null, 'Step'), view.levels.map((l) => h('th', { 'data-tip': TIP.nearest }, `Nearest ${l.short}`)))),
            h(
              'tbody',
              null,
              p.swatches.map((s) =>
                h('tr', null, h('td', null, s.step), r.distances.map((d) => h('td', null, d.nearest[s.step] ?? '–'))),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

/** Where palettes with shared step names start passing, and which ones differ. */
export function parityPanel(view: ContrastView, palettes: Palette[]) {
  if (!view.levels.length) return null;
  const numeric = palettes.filter((p) => p.included && p.order === 'numeric');
  if (numeric.length < 2) return null;
  const rows = view.parity;
  return h(
    'section',
    { class: 'parity' },
    h('h3', null, 'Contrast parity across palettes'),
    h(
      'p',
      { class: 'meta' },
      'Palettes that share step names should pass at the same step, so a semantic role can switch palettes (for example danger.600 for info.600) without losing contrast.',
    ),
    rows.length === 0
      ? h('p', { class: 'ok' }, `All ${numeric.length} numbered palettes start passing at the same steps.`)
      : masked(
          h(
            'ul',
            { class: 'flags' },
            rows.map((row) =>
              h(
                'li',
                { class: 'warning', 'data-tip': TIP.parity },
                h('b', null, `On ${view.ends[row.end].name} · ${row.level.short}: `),
                row.majority ? `most palettes pass from ${row.majority}; ` : 'most palettes never pass; ',
                row.outliers.map((o) => `${o.id} ${o.from ? `from ${o.from}` : 'never'}`).join(', '),
                '.',
              ),
            ),
          ),
        ),
  );
}
