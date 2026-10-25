import { formatColor, lch } from '../color/format';
import type { PaletteContrast } from '../contrast/analyze';
import type { Palette, PaletteSet, Swatch } from '../palette/detect';
import type { ScaleFlag } from '../palette/checks';
import type { Settings } from '../model/types';
import { setPaletteIncluded, store, updateSettings, type AppState } from '../state/app';
import { contrastOf, type ContrastView } from '../state/contrast';
import { palettesOf } from '../state/palettes';
import { displayGamut, paintAll, swatchCanvas } from './canvas';
import { contrastControls, paletteContrast, parityPanel, swatchContrast } from './contrast';
import { h, masked, plural } from './dom';

const DIRECTION = { 'light-to-dark': 'light → dark', 'dark-to-light': 'dark → light', flat: 'no lightness order' } as const;
const FORMATS: { value: Settings['colorFormat']; label: string }[] = [
  { value: 'oklch', label: 'OKLCH' },
  { value: 'hex', label: 'Hex' },
  { value: 'rgb', label: 'RGB' },
];

type View = Pick<AppState, 'model' | 'paletteOverrides' | 'settings' | 'contrastEnds'>;

/** Tier-1 colors as ordered palettes, with scale checks and gamut flags. */
export class TTPalettes extends HTMLElement {
  private unsub?: () => void;
  private resize = new ResizeObserver(() => paintAll(this));

  connectedCallback() {
    this.unsub = store.select(
      (s): View => s,
      (v) => this.render(v),
      (a, b) => a.model === b.model && a.paletteOverrides === b.paletteOverrides && a.settings === b.settings && a.contrastEnds === b.contrastEnds,
    );
    this.resize.observe(this);
  }

  disconnectedCallback() {
    this.unsub?.();
    this.resize.disconnect();
  }

  private render(v: View) {
    const set = palettesOf(store.get());
    const contrast = contrastOf(store.get());
    const { settings } = v;
    const shown = displayGamut(settings.gamut);
    const included = set.palettes.filter((p) => p.included);
    const excluded = set.palettes.filter((p) => !p.included);
    const total = included.reduce((n, p) => n + p.swatches.length, 0) + set.loose.length;

    this.replaceChildren(
      h(
        'div',
        { class: 'palettes-head' },
        h('h2', null, 'Base colors ', h('span', { class: 'n' }, total ? `${plural(included.length, 'palette')} · ${plural(total, 'color')}` : '')),
        h('div', { class: 'controls' }, this.formatToggle(settings.colorFormat), this.gamutSelect(settings.gamut)),
      ),
      total ? contrastControls(settings, set, contrast) : '',
      h(
        'div',
        { class: 'palettes-body' },
        settings.gamut === 'p3' && shown === 'srgb'
          ? h('p', { class: 'note' }, "This screen can't show Display P3, so P3 colors are drawn mapped to sRGB and marked with a corner triangle.")
          : null,
        total === 0 ? h('p', { class: 'empty' }, 'No base colors found. Base colors are color tokens with their own value rather than a reference.') : null,
        included.map((p) => this.palette(p, settings, shown, contrast)),
        parityPanel(contrast, included),
        set.loose.length ? this.loose(set, settings, shown) : null,
        excluded.length ? this.excluded(excluded) : null,
      ),
    );
    requestAnimationFrame(() => paintAll(this));
  }

  private formatToggle(current: Settings['colorFormat']) {
    return h(
      'div',
      { class: 'segmented', role: 'radiogroup', 'aria-label': 'Color format' },
      FORMATS.map((f) =>
        h(
          'button',
          { type: 'button', role: 'radio', 'aria-checked': String(f.value === current), class: f.value === current ? 'on' : undefined, onclick: () => updateSettings({ colorFormat: f.value }) },
          f.label,
        ),
      ),
    );
  }

  private gamutSelect(current: Settings['gamut']) {
    const select = h(
      'select',
      { 'aria-label': 'Target gamut' },
      h('option', { value: 'srgb', selected: current === 'srgb' }, 'Target: sRGB'),
      h('option', { value: 'p3', selected: current === 'p3' }, 'Target: Display P3'),
    );
    select.addEventListener('change', () => updateSettings({ gamut: select.value as Settings['gamut'] }));
    return select;
  }

  private palette(p: Palette, settings: Settings, shown: Settings['gamut'], contrast: ContrastView) {
    const result = contrast.results.get(p.id);
    const flagged = new Map<string, ScaleFlag['severity']>();
    for (const f of p.flags) for (const s of f.steps) if (flagged.get(s) !== 'warning') flagged.set(s, f.severity);
    return h(
      'section',
      { class: 'palette' },
      h(
        'div',
        { class: 'palette-head' },
        masked(h('h3', null, p.name)),
        h('span', { class: 'meta' }, `${plural(p.swatches.length, 'step')} · ${DIRECTION[p.direction]}`),
        h('button', { type: 'button', class: 'ghost small', onclick: () => setPaletteIncluded(p.id, false) }, 'Not a base palette'),
      ),
      p.flags.length ? masked(h('ul', { class: 'flags' }, p.flags.map((f) => h('li', { class: f.severity }, f.message)))) : null,
      this.strip(p.swatches, settings, shown, flagged, result, contrast),
      paletteContrast(p, result, contrast),
    );
  }

  private strip(
    swatches: Swatch[],
    settings: Settings,
    shown: Settings['gamut'],
    flagged = new Map<string, ScaleFlag['severity']>(),
    result?: PaletteContrast,
    contrast?: ContrastView,
  ) {
    return h(
      'div',
      { class: 'swatches', style: `--n: ${swatches.length}` },
      swatches.map((s) => {
        const value = formatColor(s.info, settings.colorFormat);
        const r = lch(s.info);
        const gamutBadge = !s.info.inP3 ? 'out of P3' : !s.info.inSrgb ? 'P3' : '';
        return h(
          'div',
          { class: `swatch${flagged.has(s.step) ? ` flagged ${flagged.get(s.step)}` : ''}` },
          swatchCanvas(s.info, shown),
          masked(
            h(
              'div',
              { class: 'labels' },
              h('span', { class: 'step' }, s.step, gamutBadge ? h('span', { class: `gamut ${gamutBadge === 'P3' ? 'p3' : 'out'}` }, gamutBadge) : null),
              h('code', { class: 'value' }, value.approx ? `≈ ${value.text}` : value.text),
              h('span', { class: 'lch' }, h('span', null, `L ${r.l}`), h('span', null, `C ${r.c}`), h('span', null, `H ${r.h}`)),
              contrast ? swatchContrast(result?.scores[s.step], contrast.levels) : null,
            ),
          ),
        );
      }),
    );
  }

  private loose(set: PaletteSet, settings: Settings, shown: Settings['gamut']) {
    return h(
      'section',
      { class: 'palette loose' },
      h('div', { class: 'palette-head' }, h('h3', null, 'Other base colors'), h('span', { class: 'meta' }, 'Single colors that are not part of a scale')),
      this.strip(
        set.loose.map((s) => ({ ...s, step: s.token.id })),
        settings,
        shown,
      ),
    );
  }

  private excluded(list: Palette[]) {
    return h(
      'details',
      { class: 'excluded' },
      h('summary', null, `${plural(list.length, 'group')} with literal colors not treated as base palettes`),
      masked(
        h(
          'ul',
          null,
          list.map((p) =>
            h(
              'li',
              null,
              h('code', null, p.name),
              h('span', { class: 'meta' }, ` ${plural(p.swatches.length, 'color')}. ${p.excludedReason ?? 'Excluded by you.'} `),
              h('button', { type: 'button', class: 'link', onclick: () => setPaletteIncluded(p.id, true) }, 'Treat as base palette'),
            ),
          ),
        ),
      ),
    );
  }
}
