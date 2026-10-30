import { formatColor, lch, type ColorInfo } from '../color/format';
import { analyzePalette, passPoint, type End, type EndId, type PaletteContrast } from '../contrast/analyze';
import { beyondEnds, rowEnds, withinEnds } from '../contrast/ends';
import { formatContrast } from '../contrast/metrics';
import { checkPalettes, type FlagKind, type ScaleFlag } from '../palette/checks';
import { stacks, type Stack } from '../palette/columns';
import type { Palette, PaletteSet, Swatch } from '../palette/detect';
import type { Settings } from '../model/types';
import { ALL_THEMES, setPaletteIncluded, store, updateSettings, type AppState } from '../state/app';
import { contrastOf, type ContrastView } from '../state/contrast';
import { palettesOf } from '../state/palettes';
import { preview } from '../state/preview';
import { displayGamut, paintAll, swatchCanvas } from './canvas';
import { contrastControls, paletteContrast, parityPanel } from './contrast';
import { openCurveEditor } from './curve-editor';
import { h, icon, masked, plural } from './dom';
import { FLAG_TIP, flagTip, levelTip, TIP } from './tips';

/**
 * Base colors as a system: palettes on the same step scheme share one grid of
 * fixed-size units, so steps line up across palettes and missing steps show
 * as gaps. Each palette is a heading, its units, and its context underneath:
 * where each contrast level is first reached on each end, then one row per
 * OKLCH channel (ΔL, ΔC, ΔH) with the change between neighbouring steps and
 * that channel's curve control on the right. A row being edited with curves
 * is drawn from the live preview.
 */

const DIRECTION = { 'light-to-dark': 'light → dark', 'dark-to-light': 'dark → light', flat: 'no lightness order' } as const;

/** Scale checks about two neighbouring steps, shown between their columns in the ΔL row. */
const PAIR_KINDS = new Set<FlagKind>(['inversion', 'near-duplicate', 'uneven-lightness']);
type Channel = 'l' | 'c' | 'h';
const CHANNELS: Channel[] = ['l', 'c', 'h'];
const CHANNEL_NAME: Record<Channel, string> = { l: 'lightness', c: 'chroma', h: 'hue' };
/** Below this chroma a hue is too unstable to compare. */
const CHROMATIC = 0.04;
/** Checks shown on a unit itself, or by the grid's gaps, rather than as palette notes. */
const PLACED_KINDS = new Set<FlagKind>(['outside-gamut', 'p3', 'missing-steps']);
const PAIR_LABEL: Partial<Record<FlagKind, string>> = { inversion: 'Reversed', 'near-duplicate': 'Too close', 'uneven-lightness': 'Uneven' };

const FORMATS: { value: Settings['colorFormat']; label: string }[] = [
  { value: 'oklch', label: 'OKLCH' },
  { value: 'hex', label: 'Hex' },
  { value: 'rgb', label: 'RGB' },
];

/**
 * Columns: row labels | light end | one per step | dark end | row actions.
 * The end columns bracket every row with that palette's own ends.
 */
const LIGHT_COL = 1;
const STEP_COL = 2;
const darkCol = (steps: number) => STEP_COL + steps;
const actionCol = (steps: number) => STEP_COL + steps + 1;

type View = Pick<AppState, 'model' | 'paletteOverrides' | 'settings' | 'contrastEnds' | 'themes' | 'activeTheme'>;

/** Place a grid cell explicitly (rows and columns are 1-based). */
function at<T extends HTMLElement>(el: T, row: number, col: number | string, rowSpan = 1): T {
  el.style.gridRow = rowSpan > 1 ? `${row} / span ${rowSpan}` : String(row);
  el.style.gridColumn = String(col);
  return el;
}

/** A palette with preview colors in place of its own, re-checked like the real thing. */
function previewed(p: Palette, colors: ReadonlyMap<string, ColorInfo>, gamut: Settings['gamut']): Palette {
  const q: Palette = {
    ...p,
    swatches: p.swatches.map((s) => ({ ...s, info: colors.get(s.step) ?? s.info })),
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
        this.systems(set.palettes, settings, shown, contrast),
        parityPanel(contrast, included),
        set.loose.length ? this.loose(set, settings, shown) : null,
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
  /** Every palette in file order: shown ones in their step grid, hidden ones collapsed in place. */
  private systems(all: Palette[], settings: Settings, shown: Settings['gamut'], contrast: ContrastView) {
    // The global ends scope every row: columns come from the steps within them.
    const whole = new Map(all.map((p) => [p.id, p]));
    const { stacks: list, orphans } = stacks(all.map((p) => (p.included ? (contrast.within.get(p.id) ?? p) : p)));
    return [
      ...list.map((g) => this.system(g, settings, shown, contrast, whole)),
      orphans.length ? this.system({ columns: [], palettes: [], members: orphans }, settings, shown, contrast, whole) : null,
    ];
  }

  private system(g: Stack, settings: Settings, shown: Settings['gamut'], contrast: ContrastView, whole: Map<string, Palette>) {
    const cells: HTMLElement[] = [];
    if (g.columns.length) {
      g.columns.forEach((c, i) => cells.push(at(h('span', { class: 'col-head', 'data-tip': TIP.step }, c), 1, STEP_COL + i)));
      cells.push(at(h('span', { class: 'col-head end-head', 'data-tip': TIP.lightEnd }, '◻ Light end'), 1, LIGHT_COL));
      cells.push(at(h('span', { class: 'col-head end-head', 'data-tip': TIP.darkEnd }, '◼ Dark end'), 1, darkCol(g.columns.length)));
      cells.push(at(h('span', { class: 'col-corner col-end' }), 1, actionCol(g.columns.length)));
    }
    let row = 2;
    const editing = preview.get().colors;
    for (const original of g.members) {
      if (!original.included) {
        row = this.hiddenRow(cells, row, g.columns.length, original);
        continue;
      }
      const live = editing.get(original.id);
      // Preview colors follow the whole palette's steps; trim to the ends after applying them.
      const full = live ? previewed(whole.get(original.id)!, live, settings.gamut) : whole.get(original.id)!;
      const p = live ? withinEnds(full, contrast.ends) : original;
      const past = beyondEnds(full, contrast.ends);
      // A row's own ends follow its colors, so a previewed row gets them re-derived.
      const ends = live ? rowEnds(p, contrast.ends, settings.gamut) : (contrast.rowEnds.get(p.id) ?? contrast.ends);
      const result = live && contrast.levels.length ? analyzePalette(p, ends, contrast.levels) : contrast.results.get(p.id);
      row = this.paletteRows(cells, row, g.columns, p, !!live, settings, shown, contrast, result, ends, past);
    }
    // A grid of hidden palettes only (nothing shown) has no step columns: just names and eyes.
    const style = g.columns.length ? `--cols: ${g.columns.length}` : 'grid-template-columns: minmax(240px, max-content) 0 0 var(--action-w)';
    return masked(h('div', { class: 'sys-scroll' }, h('div', { class: 'sys-grid', style }, cells)));
  }

  /** A palette's rows: heading, units, a contrast row per end, ΔL/ΔC/ΔH, then notes. Returns the next free row. */
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
    ends: Record<EndId, End>,
    past: { step: string; end: EndId }[],
  ): number {
    const col = new Map(columns.map((c, i) => [c, STEP_COL + i]));
    const actions = actionCol(columns.length);
    const dark = darkCol(columns.length);
    const byStep = new Map(p.swatches.map((s) => [s.step, s]));
    const offScale = new Map(p.flags.filter((f) => f.kind === 'unordered').flatMap((f) => f.steps.map((step) => [step, f] as const)));
    const endIds: EndId[] = result && contrast.levels.length ? ['light', 'dark'] : [];
    const notes = p.flags.filter((f) => !PAIR_KINDS.has(f.kind) && !PLACED_KINDS.has(f.kind) && !(f.kind === 'unordered' && f.steps.length));
    const details = paletteContrast(p, result, contrast);

    cells.push(at(this.heading(p, live, past), row, `1 / ${actions}`));
    cells.push(
      at(
        h('span', { class: 'row-end heading-end' }, h('button', { type: 'button', class: 'icon-btn eye', 'aria-label': 'Hide palette', 'aria-pressed': 'true', 'data-tip': TIP.notBase, onclick: () => setPaletteIncluded(p.id, false) }, icon('eye'))),
        row,
        actions,
      ),
    );
    row++;

    // Units between the row's own ends. Every column is a step some row in the system
    // has, so a step this row lacks is a gap, wherever it falls.
    cells.push(at(this.endUnit(ends.light, 'light', settings), row, LIGHT_COL));
    cells.push(at(this.endUnit(ends.dark, 'dark', settings), row, dark));
    columns.forEach((c, i) => {
      const s = byStep.get(c);
      cells.push(at(s ? this.unit(s, settings, shown, offScale.get(c)) : h('div', { class: 'unit-gap', 'data-tip': TIP.missingStep }), row, STEP_COL + i));
    });
    row++;

    // Contrast: only where each level is first reached, as a heavy edge facing the failing steps.
    for (const end of endIds) {
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
          h('span', { class: 'rail-label', 'data-tip': TIP.rangeOn }, h('span', { 'aria-hidden': 'true' }, end === 'light' ? '◻ ' : '◼ '), `On ${end} end`),
          row,
          LIGHT_COL,
        ),
      );
      columns.forEach((_, i) => {
        const m = marks.get(STEP_COL + i);
        cells.push(at(h('span', { class: `rail-cell${m ? ` mark ${m.side === 'start' ? 'pp-l' : 'pp-r'}` : ''}` }, m?.badges ?? null), row, STEP_COL + i));
      });
      cells.push(at(h('span', { class: 'rail-cell' }), row, LIGHT_COL), at(h('span', { class: 'rail-cell' }), row, dark));
      cells.push(at(h('span', { class: 'row-end' }), row, actions));
      row++;
    }

    // ΔL, ΔC, ΔH: the change between neighbouring steps, on the boundary between their columns.
    const pairs = p.flags.filter((f) => PAIR_KINDS.has(f.kind));
    for (const ch of CHANNELS) {
      cells.push(at(h('span', { class: 'rail-label delta', 'data-tip': TIP.delta[ch] }, `Δ${ch.toUpperCase()}`), row, LIGHT_COL));
      columns.forEach((_, i) => cells.push(at(h('span', { class: 'rail-cell' }), row, STEP_COL + i)));
      cells.push(at(h('span', { class: 'rail-cell' }), row, LIGHT_COL), at(h('span', { class: 'rail-cell' }), row, dark));
      // The row from its light end to its dark end. Each gap sits on the left edge of
      // the right-hand unit; the gap to the dark end sits just after the last step.
      const seq = [
        { info: ends.light.info, step: '', at: LIGHT_COL },
        ...p.swatches.map((s) => ({ info: s.info, step: s.step, at: col.get(s.step)! })),
        { info: ends.dark.info, step: '', at: dark },
      ];
      seq.forEach((s, i) => {
        const a = seq[i - 1];
        if (!a) return;
        const place = i === seq.length - 1 ? a.at + 1 : s.at;
        const hits = ch === 'l' && a.step && s.step ? pairs.filter((f) => f.steps.includes(a.step) && f.steps.includes(s.step)) : [];
        cells.push(
          at(
            h(
              'span',
              { class: 'gap-item' },
              hits.length
                ? hits.map((f) => h('span', { class: 'punch', 'data-tip': `${f.message} ${FLAG_TIP[f.kind]}` }, PAIR_LABEL[f.kind] ?? f.kind))
                : h('span', { class: 'dl', 'data-tip': TIP.delta[ch] }, delta(ch, a.info, s.info)),
            ),
            row,
            place,
          ),
        );
      });
      cells.push(
        at(
          h(
            'span',
            { class: 'row-end' },
            h(
              'button',
              { type: 'button', class: 'icon-btn curve-btn', 'aria-label': `Edit ${CHANNEL_NAME[ch]} curve`, 'data-tip': TIP.curveFor[ch], 'data-curve': `${p.id}:${ch}`, onclick: () => openCurveEditor(p.id, ch) },
              icon('curve'),
            ),
          ),
          row,
          actions,
        ),
      );
      row++;
    }

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

  /** Heading above a palette's units: its identity, and the eye that hides it from the system. */
  private heading(p: Palette, live: boolean, past: { step: string; end: EndId }[]) {
    const pastTip = (['light', 'dark'] as const)
      .map((end) => {
        const steps = past.filter((x) => x.end === end).map((x) => x.step);
        return steps.length ? `${steps.join(', ')} ${steps.length === 1 ? 'is' : 'are'} ${end === 'light' ? 'lighter than the light' : 'darker than the dark'} end.` : '';
      })
      .filter(Boolean)
      .join(' ');
    return h(
      'div',
      { class: `row-heading${live ? ' live' : ''}`, 'data-palette': p.id },
      h(
        'div',
        { class: 'row-heading-inner' },
        h('h3', null, p.name),
        h('span', { class: 'meta', 'data-tip': TIP.paletteMeta }, `${plural(p.swatches.length, 'step')} · ${DIRECTION[p.direction]}`),
        past.length ? h('span', { class: 'outl', 'data-tip': `${pastTip} ${TIP.pastEnds}` }, `${past.length} past the ends`) : null,
        live ? h('span', { class: 'outl', 'data-tip': TIP.previewRow }, 'Preview') : null,
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

  /** A row's own end: derived, not a token, so drawn as a quieter unit with its value. */
  private endUnit(end: End, which: EndId, settings: Settings) {
    const value = formatColor(end.info, settings.colorFormat);
    const r = lch(end.info);
    return h(
      'div',
      { class: 'unit end-unit', 'data-tip': which === 'light' ? TIP.lightEnd : TIP.darkEnd },
      h('div', { class: 'unit-fill' }, swatchCanvas(end.info, displayGamut(settings.gamut), false)),
      h(
        'div',
        { class: 'unit-val' },
        h('code', { class: 'value' }, value.approx ? h('span', { class: 'outl' }, '≈') : null, value.text),
        h('span', { class: 'lch' }, h('span', null, r.l), h('span', null, r.c), h('span', null, r.h)),
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

  /** A hidden palette: one collapsed row in its place in the stack. The eye shows it again. */
  private hiddenRow(cells: HTMLElement[], row: number, cols: number, p: Palette): number {
    const actions = actionCol(cols);
    cells.push(
      at(
        h(
          'div',
          { class: 'row-heading collapsed', 'data-palette': p.id },
          h(
            'div',
            { class: 'row-heading-inner' },
            h('h3', null, p.name),
            h('span', { class: 'meta' }, `${plural(p.swatches.length, 'color')} · hidden${p.excludedReason ? `: ${p.excludedReason}` : ''}`),
          ),
        ),
        row,
        `1 / ${actions}`,
      ),
    );
    cells.push(
      at(
        h('span', { class: 'row-end heading-end' }, h('button', { type: 'button', class: 'icon-btn eye off', 'aria-label': 'Show palette', 'aria-pressed': 'false', 'data-tip': TIP.treatAsBase, onclick: () => setPaletteIncluded(p.id, true) }, icon('eye-off'))),
        row,
        actions,
      ),
    );
    cells.push(at(h('span', { class: 'row-sep' }), row + 1, '1 / -1'));
    return row + 2;
  }

}

/** The change in one OKLCH channel from step `a` to step `b`: |ΔL| on 0–100, signed ΔC, signed ΔH in degrees. */
function delta(ch: Channel, a: ColorInfo, b: ColorInfo): string {
  const sign = (v: number, digits: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`;
  if (ch === 'l') return (Math.abs(b.oklch.l - a.oklch.l) * 100).toFixed(1);
  if (ch === 'c') return sign(b.oklch.c - a.oklch.c, 3);
  const grey = (x: ColorInfo) => Number.isNaN(x.oklch.h) || x.oklch.c < CHROMATIC;
  if (grey(a) || grey(b)) return '–';
  return `${sign(((((b.oklch.h - a.oklch.h) % 360) + 540) % 360) - 180, 0)}°`;
}
