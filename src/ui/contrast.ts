import type { EndId, PaletteContrast, Scores } from '../contrast/analyze';
import { endCandidates, type EndCandidate } from '../contrast/ends';
import { bestLevel, metricsFor, TARGETS, type ContrastTarget, type Level } from '../contrast/levels';
import { formatContrast } from '../contrast/metrics';
import type { Settings } from '../model/types';
import type { Palette, PaletteSet } from '../palette/detect';
import { setContrastEnd, updateSettings } from '../state/app';
import type { ContrastView } from '../state/contrast';
import { h, masked } from './dom';
import { levelTip, TIP } from './tips';

/** UI pieces for contrast: target toggles, end pickers, per-swatch scores, pass ranges, step distance, parity. */

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
  const candidates = endCandidates(set);
  const picker = (end: EndId, list: EndCandidate[]) => {
    const select = h(
      'select',
      { 'aria-label': END_LABEL[end] },
      list.map((c) => h('option', { value: c.id, selected: c.id === view.ends[end].name }, c.id)),
    );
    select.addEventListener('change', () => setContrastEnd(end, select.value));
    return h('label', { class: 'end-picker', 'data-tip': TIP.endPicker }, h('span', null, `${END_LABEL[end]}:`), masked(select));
  };
  return h(
    'div',
    { class: 'contrast-controls' },
    h('span', { class: 'label' }, 'Contrast:'),
    h('div', { class: 'chips', role: 'group', 'aria-label': 'Contrast compliance targets' }, TARGETS.map((t) => toggle(t.id, t.label))),
    settings.contrast.length ? [picker('light', candidates.light), picker('dark', candidates.dark)] : null,
    settings.contrast.length
      ? h('span', { class: 'legend' }, 'Each swatch shows its contrast as text on ◻ the light end and ◼ the dark end, with the strictest level it passes.')
      : null,
  );
}

/** Contrast of one swatch against both ends, with the strictest level it passes. */
export function swatchContrast(scores: Scores | undefined, levels: Level[]) {
  if (!scores || !levels.length) return null;
  const metrics = metricsFor(levels);
  return h(
    'div',
    { class: 'contrast-cell' },
    (['light', 'dark'] as const).flatMap((end) =>
      metrics.map((m) => {
        const v = scores[end][m] ?? 0;
        const best = bestLevel(v, m, levels);
        const tip = [end === 'light' ? TIP.endLight : TIP.endDark, m === 'wcag' ? TIP.wcagValue : TIP.apcaValue, best ? levelTip(best) : TIP.noLevel].join(' ');
        return h(
          'span',
          { class: `score ${best ? 'pass' : 'fail'}`, 'data-tip': tip },
          h('span', { class: 'end', 'aria-label': end === 'light' ? 'on the light end' : 'on the dark end' }, end === 'light' ? '◻' : '◼'),
          h('span', { class: 'v' }, formatContrast(v, m)),
          h('span', { class: 'lvl' }, best?.badge ?? '–'),
        );
      }),
    ),
  );
}

/** Pass ranges per end and level, plus the step-distance rule, for one palette. */
export function paletteContrast(p: Palette, r: PaletteContrast | undefined, view: ContrastView) {
  if (!r || !view.levels.length) return null;
  const rangeText = (end: EndId) =>
    view.levels.map((level) => {
      const range = r.ranges.find((x) => x.end === end && x.level.id === level.id)!;
      const text = range.from ? (range.from === range.to ? range.from : `${range.from}–${range.to}`) : 'none';
      const stray = range.stray.length ? ` (also ${range.stray.join(', ')})` : '';
      return h('span', { class: `range ${range.from ? 'pass' : 'fail'}`, 'data-tip': `${levelTip(level)} ${TIP.range}` }, h('b', null, level.short), ` ${text}${stray}`);
    });

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
      (['light', 'dark'] as const).map((end) =>
        h('p', { class: 'ranges' }, h('span', { class: 'on', 'data-tip': TIP.rangeOn }, `On ${view.ends[end].name}:`), rangeText(end)),
      ),
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
