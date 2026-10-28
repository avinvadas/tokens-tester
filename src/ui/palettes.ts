import { formatColor, lch, type ColorInfo } from '../color/format';
import { analyzePalette, passPoint, type EndId, type PaletteContrast } from '../contrast/analyze';
import { formatContrast } from '../contrast/metrics';
import { checkPalettes, type FlagKind, type ScaleFlag } from '../palette/checks';
import { stepGroups, type StepGroup } from '../palette/columns';
import type { Palette, PaletteSet, Swatch } from '../palette/detect';
import type { Settings } from '../model/types';
import { ALL_THEMES, setPaletteIncluded, store, updateSettings, type AppState } from '../state/app';
import { contrastOf, type ContrastView } from '../state/contrast';
import { palettesOf } from '../state/palettes';
import { preview } from '../state/preview';
import { displayGamut, paintAll, swatchCanvas } from './canvas';
import { contrastControls, paletteContrast, parityPanel } from './contrast';
import { openCurveEditor } from './curve-editor';
import { h, masked, plural } from './dom';
import { FLAG_TIP, flagTip, levelTip, TIP } from './tips';

/**
 * Base colors as a system: palettes on the same step scheme share one grid of
 * fixed-size units, so steps line up across palettes and missing steps show
 * as gaps. Each palette row carries its own context underneath: where each
 * contrast level is first reached on each end, and how neighbouring steps
 * relate. A row being edited with curves is drawn from the live preview.
 */

const DIRECTION = { 'light-to-dark': 'light → dark', 'dark-to-light': 'dark → light', flat: 'no lightness order' } as const;

/** Scale checks about two neighbouring steps, shown between their columns. */
const PAIR_KINDS = new Set<FlagKind>(['inversion', 'near-duplicate', 'uneven-lightness']);
/** Checks shown on a unit itself, or by the grid's gaps, rather than as palette notes. */
const PLACED_KINDS = new Set<FlagKind>(['outside-gamut', 'p3', 'missing-steps']);
const PAIR_LABEL: Partial<Record<FlagKind, string>> = { inversion: 'Reversed', 'near-duplicate': 'Too close', 'uneven-lightness': 'Uneven' };

const FORMATS: { value: Settings['colorFormat']; label: string }[] = [
  { value: 'oklch', label: 'OKLCH' },
  { value: 'hex', label: 'Hex' },
  { value: 'rgb', label: 'RGB' },
];

/** Head column, rail-label column, then one column per step. */
const STEP_COL = 3;

type View = Pick<AppState, 'model' | 'paletteOverrides' | 'settings' | 'contrastEnds' | 'themes' | 'activeTheme'>;

/** Place a grid cell explicitly (rows and columns are 1-based). */
function at<T extends HTMLElement>(el: T, row: number, col: number | string, rowSpan = 1): T {
  el.style.gridRow = rowSpan > 1 ? `${row} / span ${rowSpan}` : String(row);
  el.style.gridColumn = String(col);
  return el;
}

/** A palette with preview colors in place of its own, re-checked like the real thing. */
function previewed(p: Palette, colors: readonly ColorInfo[], gamut: Settings['gamut']): Palette {
  const q: Palette = {
    ...p,
    swatches: p.swatches.map((s, i) => ({ ...s, info: colors[i] ?? s.info })),
    flags: p.flags.filter((f) => f.kind === 'unordered' || f.kind === 'missing-steps'),
  };
  checkPalettes([q], gamut);
  return q;
}

export class TTPalettes extends HTMLElement {
  private unsubs: (() => void)[] = [];
  private resize = new ResizeObserver(() => paintAll(this));
  private frame = 0;

  connectedCallback() {
    this.unsubs.push(
      store.select(
        (s): View => s,
        () => this.schedule(),
        (a, b) => a.model === b.model && a.paletteOverrides === b.paletteOverrides && a.settings === b.settings && a.contrastEnds === b.contrastEnds,
      ),
      // Curve drags update the preview many times a second: draw at most once per frame.
      preview.select((s) => s.colors, () => this.schedule()),
    );
    this.resize.observe(this);
  }

  disconnectedCallback() {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.resize.disconnect();
    cancelAnimationFrame(this.frame);
  }

  private schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render(store.get());
    });
  }

  private render(v: View) {
    const set = palettesOf(store.get());
    const contrast = contrastOf(store.get());
    const { settings } = v;
    const shown = displayGamut(settings.gamut);
    const included = set.palettes.filter((p) => p.included);
    const excluded = set.palettes.filter((p) => !p.included);
    const total = included.reduce((n, p) => n + p.swatches.length, 0) + set.loose.length;
    const scroll = [...this.querySelectorAll('.sys-scroll')].map((el) => el.scrollLeft);

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
        v.themes.length > 1 && v.activeTheme === ALL_THEMES
          ? h('p', { class: 'note' }, 'Base colors are shown for the first theme, ', masked(h('b', null, v.themes[0]!.name)), '. Pick a theme in the sidebar to see its own.')
          : null,
        settings.gamut === 'p3' && shown === 'srgb' ? h('p', { class: 'note' }, "This screen can't show Display P3, so colors marked P3 are drawn mapped to sRGB.") : null,
        total === 0 ? h('p', { class: 'empty' }, 'No base colors found. Base colors are color tokens with their own value rather than a reference.') : null,
        stepGroups(included).map((g) => this.system(g, settings, shown, contrast)),
        parityPanel(contrast, included),
        set.loose.length ? this.loose(set, settings, shown) : null,
        excluded.length ? this.excluded(excluded) : null,
      ),
    );
    // Keep each grid's horizontal position across re-renders (curve drags re-render often).
    this.querySelectorAll('.sys-scroll').forEach((el, i) => (el.scrollLeft = scroll[i] ?? 0));
    requestAnimationFrame(() => paintAll(this));
  }

  private formatToggle(current: Settings['colorFormat']) {
    return h(
      'div',
      { class: 'segmented', role: 'radiogroup', 'aria-label': 'Color format' },
      FORMATS.map((f) =>
        h(
          'button',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(f.value === current),
            class: f.value === current ? 'on' : undefined,
            'data-tip': TIP.formats[f.value],
            onclick: () => updateSettings({ colorFormat: f.value }),
          },
          f.label,
        ),
      ),
    );
  }

  private gamutSelect(current: Settings['gamut']) {
    const select = h(
      'select',
      { 'aria-label': 'Target gamut', 'data-tip': TIP.gamut },
      h('option', { value: 'srgb', selected: current === 'srgb' }, 'Target: sRGB'),
      h('option', { value: 'p3', selected: current === 'p3' }, 'Target: Display P3'),
    );
    select.addEventListener('change', () => updateSettings({ gamut: select.value as Settings['gamut'] }));
    return select;
  }

  /** One step scheme: column headers, then each palette as a block of rows. */
  private system(g: StepGroup, settings: Settings, shown: Settings['gamut'], contrast: ContrastView) {
    const cells: HTMLElement[] = [];
    cells.push(at(h('span', { class: 'col-corner' }), 1, '1 / span 2'));
    g.columns.forEach((c, i) => cells.push(at(h('span', { class: 'col-head', 'data-tip': TIP.step }, c), 1, STEP_COL + i)));
    let row = 2;
    const editing = preview.get().colors;
    for (const original of g.palettes) {
      const live = editing.get(original.id);
      const p = live ? previewed(original, live, settings.gamut) : original;
      const result = live && contrast.levels.length ? analyzePalette(p, contrast.ends, contrast.levels) : contrast.results.get(p.id);
      row = this.paletteRows(cells, row, g.columns, p, !!live, settings, shown, contrast, result);
    }
    return masked(h('div', { class: 'sys-scroll' }, h('div', { class: 'sys-grid', style: `--cols: ${g.columns.length}` }, cells)));
  }

  /** A palette's rows: units, a contrast row per end, the scale row, then notes. Returns the next free row. */
  private paletteRows(
    cells: HTMLElement[],
    row: number,
    columns: string[],
    p: Palette,
    live: boolean,
    settings: Settings,
    shown: Settings['gamut'],
    contrast: ContrastView,
    result: PaletteContrast | undefined,
  ): number {
    const col = new Map(columns.map((c, i) => [c, STEP_COL + i]));
    const byStep = new Map(p.swatches.map((s) => [s.step, s]));
    const offScale = new Map(p.flags.filter((f) => f.kind === 'unordered').flatMap((f) => f.steps.map((step) => [step, f] as const)));
    const ends: EndId[] = result && contrast.levels.length ? ['light', 'dark'] : [];
    const notes = p.flags.filter((f) => !PAIR_KINDS.has(f.kind) && !PLACED_KINDS.has(f.kind) && !(f.kind === 'unordered' && f.steps.length));
    const details = paletteContrast(p, result, contrast);
    const lines = 1 + ends.length + 1;

    cells.push(at(this.head(p, live), row, 1, lines));

    // Units, with gaps where this palette lacks a step the others have.
    columns.forEach((c, i) => {
      const s = byStep.get(c);
      cells.push(at(s ? this.unit(s, settings, shown, offScale.get(c)) : h('div', { class: 'unit-gap', 'data-tip': TIP.missingStep }), row, STEP_COL + i));
    });
    row++;

    // Contrast: only where each level is first reached, as a heavy edge facing the failing steps.
    for (const end of ends) {
      const marks = new Map<number, { side: 'start' | 'end'; badges: HTMLElement[] }>();
      for (const level of contrast.levels) {
        const pp = passPoint(p, result!, end, level);
        if (!pp) continue;
        const c = col.get(pp.step)!;
        const score = result!.scores[pp.step]?.[end][level.metric] ?? 0;
        const m = marks.get(c) ?? { side: pp.side, badges: [] };
        m.badges.push(h('span', { class: 'lvl', 'data-tip': `${levelTip(level)} First reached at ${pp.step}: ${formatContrast(score, level.metric)}. ${TIP.passPoint}` }, level.badge));
        marks.set(c, m);
      }
      cells.push(
        at(
          h('span', { class: 'rail-label', 'data-tip': TIP.rangeOn }, h('span', { 'aria-hidden': 'true' }, end === 'light' ? '◻ ' : '◼ '), `On ${contrast.ends[end].name}`),
          row,
          2,
        ),
      );
      columns.forEach((_, i) => {
        const m = marks.get(STEP_COL + i);
        cells.push(at(h('span', { class: `rail-cell${m ? ` mark ${m.side === 'start' ? 'pp-l' : 'pp-r'}` : ''}` }, m?.badges ?? null), row, STEP_COL + i));
      });
      row++;
    }

    // Scale: ΔL on the boundary between neighbouring steps, or the check that names the pair.
    const pairs = p.flags.filter((f) => PAIR_KINDS.has(f.kind));
    cells.push(at(h('span', { class: 'rail-label', 'data-tip': TIP.scaleRail }, 'Scale'), row, 2));
    const present = new Set(p.swatches.map((s) => s.step));
    columns.forEach((c, i) => cells.push(at(h('span', { class: `rail-cell${present.has(c) ? '' : ' empty'}` }), row, STEP_COL + i)));
    p.swatches.forEach((s, i) => {
      const a = p.swatches[i - 1];
      if (!a) return;
      const hits = pairs.filter((f) => f.steps.includes(a.step) && f.steps.includes(s.step));
      const dl = Math.abs(s.info.oklch.l - a.info.oklch.l) * 100;
      cells.push(
        at(
          h(
            'span',
            { class: 'gap-item' },
            hits.length
              ? hits.map((f) => h('span', { class: 'punch', 'data-tip': `${f.message} ${FLAG_TIP[f.kind]}` }, PAIR_LABEL[f.kind] ?? f.kind))
              : h('span', { class: 'dl', 'data-tip': TIP.deltaL }, `ΔL ${dl.toFixed(1)}`),
          ),
          row,
          col.get(s.step)!,
        ),
      );
    });
    row++;

    if (notes.length || details) {
      cells.push(
        at(
          h(
            'div',
            { class: 'row-notes' },
            h(
              'div',
              { class: 'row-notes-inner' },
              notes.length ? h('ul', { class: 'flags' }, notes.map((f) => h('li', { class: f.severity, 'data-tip': flagTip(f) }, f.message))) : null,
              details,
            ),
          ),
          row,
          '1 / -1',
        ),
      );
      row++;
    }
    cells.push(at(h('span', { class: 'row-sep' }), row, '1 / -1'));
    return row + 1;
  }

  /** Row head: the palette's identity and the actions that work on the whole row. */
  private head(p: Palette, live: boolean) {
    return h(
      'div',
      { class: `row-head${live ? ' live' : ''}`, 'data-palette': p.id },
      h('h3', null, p.name),
      h('span', { class: 'meta', 'data-tip': TIP.paletteMeta }, `${plural(p.swatches.length, 'step')} · ${DIRECTION[p.direction]}`),
      live ? h('span', { class: 'outl', 'data-tip': TIP.previewRow }, 'Preview') : null,
      h(
        'div',
        { class: 'row-actions' },
        h('button', { type: 'button', class: 'small', 'data-tip': TIP.editCurves, onclick: () => openCurveEditor(p.id) }, 'Curves'),
        h('button', { type: 'button', class: 'ghost small', 'data-tip': TIP.notBase, onclick: () => setPaletteIncluded(p.id, false) }, 'Exclude'),
      ),
    );
  }

  /** One token as a fixed-size unit: its color, and the checks about its value alone. */
  private unit(s: Swatch, settings: Settings, shown: Settings['gamut'], offScale?: ScaleFlag) {
    const value = formatColor(s.info, settings.colorFormat);
    const r = lch(s.info);
    const gamut = !s.info.inP3
      ? { cls: 'punch', text: 'Out of P3', tip: TIP.gamutOut }
      : !s.info.inSrgb
        ? settings.gamut === 'srgb'
          ? { cls: 'punch', text: 'Out of sRGB', tip: TIP.gamutOutSrgb }
          : { cls: 'outl', text: 'P3', tip: TIP.gamutP3 }
        : undefined;
    return h(
      'div',
      { class: 'unit' },
      h(
        'div',
        { class: 'unit-fill' },
        swatchCanvas(s.info, shown, false),
        offScale ? h('span', { class: 'punch id-chip', 'data-tip': `${offScale.message} ${FLAG_TIP.unordered}` }, 'Off-scale') : null,
        gamut ? h('span', { class: `${gamut.cls} value-chip`, 'data-tip': gamut.tip }, gamut.text) : null,
      ),
      h(
        'div',
        { class: 'unit-val' },
        h('code', { class: 'value', 'data-tip': TIP.value }, value.approx ? h('span', { class: 'outl', 'data-tip': TIP.approx }, '≈') : null, value.text),
        h('span', { class: 'lch' }, h('span', { 'data-tip': TIP.l }, r.l), h('span', { 'data-tip': TIP.c }, r.c), h('span', { 'data-tip': TIP.h }, r.h)),
      ),
    );
  }

  private loose(set: PaletteSet, settings: Settings, shown: Settings['gamut']) {
    return h(
      'section',
      { class: 'loose' },
      h('div', { class: 'palette-head' }, h('h3', null, 'Other base colors'), h('span', { class: 'meta' }, 'Single colors that are not part of a scale')),
      masked(
        h(
          'div',
          { class: 'unit-row' },
          set.loose.map((s) => h('div', { class: 'unit-named' }, h('code', { class: 'col-head' }, s.token.id), this.unit(s, settings, shown))),
        ),
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
              h('button', { type: 'button', class: 'link', 'data-tip': TIP.treatAsBase, onclick: () => setPaletteIncluded(p.id, true) }, 'Treat as base palette'),
            ),
          ),
        ),
      ),
    );
  }
}
