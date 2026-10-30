import type { ColorInfo, Gamut } from '../color/format';
import type { End, EndId } from '../contrast/analyze';
import { rowEnds } from '../contrast/ends';
import {
  anchorT,
  C_MAX,
  contrastTargetedL,
  generate,
  generateFor,
  initialState,
  maxChroma,
  positions,
  presetC,
  presetH,
  presetL,
  setAnchorColor,
  setAnchorStep,
  toEdits,
  evaluate,
  type CurveState,
  type GenStep,
} from '../curves/model';
import type { Model } from '../model/types';
import type { Palette } from '../palette/detect';
import { allModels, applyEdits, store } from '../state/app';
import { contrastOf } from '../state/contrast';
import { palettesOf } from '../state/palettes';
import { clearPreview, preview, setPreview } from '../state/preview';
import { displayGamut, paintAll, swatchCanvas } from './canvas';
import { CurveCanvas } from './curve-canvas';
import { h, icon, masked, plural } from './dom';
import { CURVE_TIP } from './tips';

/**
 * Edit a whole palette row with lightness, chroma and hue curves around an
 * anchor color. The editor is a non-modal floating panel pointing at the ΔL,
 * ΔC or ΔH button that opened it, showing that channel's curve. Every change
 * is drawn live on the row itself (and on any batch rows) through the preview
 * store, so the effect is judged in the system. Nothing is written until
 * Apply, which makes the whole edit one undoable step; Revert drops it.
 */
let current: CurveEditor | undefined;

export function openCurveEditor(paletteId: string, focus: 'l' | 'c' | 'h' = 'l') {
  // Same row: keep the edit in progress and bring the requested curve forward.
  if (current?.paletteId === paletteId) return current.focus(focus);
  current?.dialog.close();
  const state = store.get();
  const set = palettesOf(state);
  const palette = set.palettes.find((p) => p.id === paletteId);
  if (!palette) return;
  // The row as the grid shows it: its light end, the steps within the global ends, its dark end.
  const view = contrastOf(state);
  const within = view.within.get(paletteId) ?? palette;
  const ends = view.rowEnds.get(paletteId) ?? view.ends;
  const row: Palette = { ...within, swatches: [endSwatch('light', ends.light.info), ...within.swatches, endSwatch('dark', ends.dark.info)] };
  const editor = new CurveEditor(row, set.palettes.filter((p) => p.included && p.id !== paletteId), state.settings.gamut, view.ends);
  current = editor;
  document.body.append(editor.dialog);
  editor.dialog.show();
  editor.focus(focus);
}

/** A row end as a curve point. It has no token: its color always comes from the global ends. */
function endSwatch(end: EndId, info: ColorInfo): Palette['swatches'][number] {
  return { step: end === 'light' ? '◻ end' : '◼ end', info, derived: end, token: undefined as never };
}

class CurveEditor {
  readonly dialog = masked(h('dialog', { class: 'curve-editor', 'aria-label': 'Curve editor' }));
  private s: CurveState;
  private history: CurveState[] = [];
  private future: CurveState[] = [];
  private canvases: CurveCanvas[] = [];
  private blocks: Partial<Record<'l' | 'c' | 'h', HTMLElement>> = {};
  private channel: 'l' | 'c' | 'h' = 'l';
  private scroller = h('div', { class: 'ce-scroll' });
  private unsubPreview?: () => void;
  private place = () => this.position();
  private mappedNote = h('p', { class: 'meta ce-mapped' });
  private batchBox = h('div', { class: 'ce-batch' });
  private impact = h('div', { class: 'ce-impact' });
  private anchorInputs: Partial<Record<'l' | 'c' | 'h', HTMLInputElement>> = {};
  private readouts: Partial<Record<'l' | 'c' | 'h', HTMLElement>> = {};
  private ranges: Partial<Record<'l' | 'c' | 'h', HTMLInputElement>> = {};
  private editors: Partial<Record<'l' | 'c' | 'h', HTMLElement>> = {};
  private values!: HTMLElement;
  private strip = h('div', { class: 'ce-strip', role: 'slider', tabindex: '0', 'aria-label': 'Anchor step', 'aria-valuemin': '0', 'data-tip': CURVE_TIP.anchor });
  private applyButton = h('button', { type: 'button', class: 'primary', 'data-tip': CURVE_TIP.apply }, 'Apply');
  private undoButton = h('button', { type: 'button' }, 'Undo');
  private redoButton = h('button', { type: 'button' }, 'Redo');
  private notes = h('ul', { class: 'flags ce-notes' });
  private title!: HTMLElement;
  private shown: Gamut;
  private resize = new ResizeObserver(() => this.redraw());

  constructor(
    private p: Palette,
    private others: Palette[],
    private gamut: Gamut,
    private globalEnds: Record<EndId, End>,
  ) {
    this.s = initialState(p);
    this.shown = displayGamut(gamut);
    this.build();
    this.dialog.addEventListener('close', () => {
      this.resize.disconnect();
      this.dialog.remove();
      window.removeEventListener('scroll', this.place, true);
      window.removeEventListener('resize', this.place);
      this.unsubPreview?.();
      if (current === this) {
        current = undefined;
        clearPreview();
      }
    });
    this.dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.dialog.close();
    });
    this.resize.observe(this.dialog);
    window.addEventListener('scroll', this.place, true);
    window.addEventListener('resize', this.place);
    // The grid redraws its buttons on every preview change; follow ours once it has.
    this.unsubPreview = preview.subscribe(() => requestAnimationFrame(() => requestAnimationFrame(this.place)));
  }

  // -------------------------------------------------------------------------
  // State

  private set(next: CurveState, commit: boolean) {
    if (commit) {
      this.history.push(this.s);
      this.future = [];
    }
    this.s = next;
    this.refresh(commit);
  }

  /** A drag in progress changed the curve; record history once, at its start. */
  private dragStart: CurveState | undefined;
  private onCurve(ch: 'l' | 'c' | 'h', curve: CurveState['curves']['l'], commit: boolean) {
    if (!commit && !this.dragStart) this.dragStart = this.s;
    const next = { ...this.s, curves: { ...this.s.curves, [ch]: curve } };
    // Dragging the anchor handle moves the anchor color.
    const tA = anchorT(this.p, next);
    const a = curve.points.find((q) => Math.abs(q.t - tA) < 1e-6);
    if (a) next.anchorColor = { ...next.anchorColor, [ch]: a.v };
    if (commit) {
      this.history.push(this.dragStart ?? this.s);
      this.future = [];
      this.dragStart = undefined;
    }
    this.s = next;
    this.refresh(commit);
  }

  private undo() {
    const prev = this.history.pop();
    if (!prev) return;
    this.future.push(this.s);
    this.s = prev;
    this.refresh(true);
  }

  private redo() {
    const next = this.future.pop();
    if (!next) return;
    this.history.push(this.s);
    this.s = next;
    this.refresh(true);
  }

  private generated(): { source: GenStep[]; batch: { palette: Palette; gen: GenStep[] }[] } {
    return {
      source: this.withEnds(generate(this.p, this.s, this.gamut)),
      batch: this.others.filter((o) => this.s.batch.includes(o.id)).map((o) => ({ palette: o, gen: generateFor(o, this.p, this.s, this.gamut) })),
    };
  }

  /**
   * The ends are not the curves' to set: they follow the global ends, tinted
   * with the generated steps' hue, exactly as the grid derives them.
   */
  private withEnds(gen: GenStep[]): GenStep[] {
    const steps = gen.filter((_, i) => !this.p.swatches[i]!.derived);
    const own = rowEnds({ ...this.p, swatches: this.p.swatches.filter((s) => !s.derived).map((s, i) => ({ ...s, info: steps[i]!.info })) }, this.globalEnds, this.gamut);
    return gen.map((g, i) => {
      const end = this.p.swatches[i]!.derived;
      return end ? { ...g, info: own[end].info, mapped: false } : g;
    });
  }

  private edits() {
    const g = this.generated();
    return [...toEdits(this.p, g.source), ...g.batch.flatMap((b) => toEdits(b.palette, b.gen))];
  }

  // -------------------------------------------------------------------------
  // Layout

  private build() {
    const close = () => this.dialog.close();
    this.undoButton.onclick = () => this.undo();
    this.redoButton.onclick = () => this.redo();
    this.applyButton.onclick = () => {
      const edits = this.edits();
      if (edits.length) {
        const n = this.s.batch.length;
        applyEdits(`Curve edit: ${this.p.name}${n ? ` and ${plural(n, 'more palette')}` : ''}`, edits);
      }
      close();
    };

    this.dialog.append(this.scroller);
    this.scroller.append(
      h(
        'header',
        { class: 'ce-head' },
        h('h2', null, 'Curves: ', h('code', null, this.p.name)),
        (this.title = h('span', { class: 'ce-channel' })),
        h('span', { class: 'meta' }, 'Live on the row'),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'ghost', onclick: close, 'aria-label': 'Revert and close', 'data-tip': CURVE_TIP.revert }, '✕'),
      ),
      h(
        'p',
        { class: 'meta' },
        'Each curve runs across the steps and passes through the anchor (◆). Drag handles, double-click to add or remove one. Hollow dots are the current colors, filled dots the result.',
      ),
      ...this.anchorRow(),
      h('div', { class: 'ce-curves' },
      this.curveBlock('l', 'Lightness', [
        ['Current', () => this.set(presetL(this.p, this.s, 'current'), true)],
        ['Linear', () => this.set(presetL(this.p, this.s, 'linear'), true)],
        ['Ease', () => this.set(presetL(this.p, this.s, 'ease'), true)],
      ], this.contrastForm()),
      this.curveBlock('c', 'Chroma', [
        ['Current', () => this.set(presetC(this.p, this.s, 'current'), true)],
        ['Bell', () => this.set(presetC(this.p, this.s, 'bell'), true)],
        ['Flat', () => this.set(presetC(this.p, this.s, 'flat'), true)],
      ], h('span', { class: 'meta' }, `Dashed line: the most chroma that fits ${this.gamut === 'p3' ? 'Display P3' : 'sRGB'} at each step; colors above it are mapped down (ringed dots).`)),
      this.curveBlock('h', 'Hue', [
        ['Current', () => this.set(presetH(this.p, this.s, 'current'), true)],
        ['Constant', () => this.set(presetH(this.p, this.s, 'constant'), true)],
      ], this.hueShift()),
      ),
      this.notes,
      this.mappedNote,
      this.others.length ? h('details', { class: 'ce-more' }, h('summary', null, 'Apply to more palettes'), this.batchBox) : '',
      h('details', { class: 'ce-more' }, h('summary', null, 'Semantic tokens affected'), this.impact),
      h(
        'footer',
        { class: 'ce-foot' },
        this.undoButton,
        this.redoButton,
        h('button', { type: 'button', 'data-tip': CURVE_TIP.reset, onclick: () => this.set(initialState(this.p, this.s.anchor), true) }, 'Reset'),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', onclick: close, 'data-tip': CURVE_TIP.revert }, 'Revert'),
        this.applyButton,
      ),
    );
    this.refresh(true);
  }

  /**
   * The anchor as two rows: a strip of the palette's steps (the live result,
   * in scale order) to scrub along, with the anchor marked; then the anchor's
   * L, C and H, where only the channel being edited is an input.
   */
  private anchorRow() {
    const n = this.p.swatches.length;
    this.strip.setAttribute('aria-valuemax', String(n - 1));
    const at = (x: number) => {
      const r = this.strip.getBoundingClientRect();
      return Math.min(n - 1, Math.max(0, Math.floor(((x - r.left) / r.width) * n)));
    };
    // A scrub is one undo step: record the state from before the first move.
    let start: CurveState | undefined;
    const move = (e: PointerEvent) => {
      const i = at(e.clientX);
      if (i !== this.s.anchor) this.set(setAnchorStep(this.p, this.s, i), false);
    };
    const end = () => {
      if (start && start !== this.s) {
        this.history.push(start);
        this.future = [];
        this.refresh(true);
      }
      start = undefined;
    };
    this.strip.addEventListener('pointerdown', (e) => {
      start = this.s;
      this.strip.setPointerCapture(e.pointerId);
      move(e);
    });
    this.strip.addEventListener('pointermove', (e) => start && move(e));
    this.strip.addEventListener('pointerup', end);
    this.strip.addEventListener('pointercancel', end);
    this.strip.addEventListener('keydown', (e) => {
      const i = { ArrowLeft: this.s.anchor - 1, ArrowDown: this.s.anchor - 1, ArrowRight: this.s.anchor + 1, ArrowUp: this.s.anchor + 1, Home: 0, End: n - 1 }[e.key];
      if (i === undefined) return;
      e.preventDefault();
      if (i >= 0 && i < n && i !== this.s.anchor) this.set(setAnchorStep(this.p, this.s, i), true);
    });

    const slot = (ch: 'l' | 'c' | 'h', label: string, min: number, max: number, step: number) => {
      const input = h('input', { type: 'number', min, max, step, 'aria-label': `Anchor ${label}` });
      input.addEventListener('change', () => {
        const raw = Number(input.value);
        if (!Number.isFinite(raw)) return;
        this.set(setAnchorColor(this.p, this.s, { [ch]: ch === 'l' ? raw / 100 : raw }), true);
      });
      // While the edited value has focus, a vertical slider spans its full range, max at the top.
      const range = h('input', { type: 'range', class: 'ce-vrange', min, max, step, 'aria-label': `Anchor ${label} slider` });
      let start: CurveState | undefined;
      range.addEventListener('input', () => {
        start ??= this.s;
        const raw = Number(range.value);
        this.set(setAnchorColor(this.p, this.s, { [ch]: ch === 'l' ? raw / 100 : raw }), false);
      });
      range.addEventListener('change', () => {
        if (start && start !== this.s) {
          this.history.push(start);
          this.future = [];
          this.refresh(true);
        }
        start = undefined;
      });
      const edit = h(
        'span',
        { class: 'ce-val-edit' },
        input,
        h('span', { class: 'ce-vslider' }, h('span', { class: 'ce-vend' }, String(max)), range, h('span', { class: 'ce-vend' }, String(min))),
      );
      const readout = h('span', { class: 'ce-readout' });
      this.anchorInputs[ch] = input;
      this.ranges[ch] = range;
      this.editors[ch] = edit;
      this.readouts[ch] = readout;
      return h('span', { class: 'ce-val', 'data-tip': { l: CURVE_TIP.anchorL, c: CURVE_TIP.anchorC, h: CURVE_TIP.anchorH }[ch] }, h('b', null, ch.toUpperCase()), edit, readout);
    };
    return [
      h('div', { class: 'ce-anchor' }, h('span', { class: 'ce-label' }, 'Anchor'), this.strip),
      (this.values = h('div', { class: 'ce-values' }, h('span', { class: 'ce-label' }, 'Values'), slot('l', 'lightness', 0, 100, 0.5), slot('c', 'chroma', 0, C_MAX, 0.005), slot('h', 'hue', 0, 360, 1))),
    ];
  }

  /** The step strip, drawn from the current result with the anchor raised and marked. */
  private drawStrip(gen: GenStep[]) {
    const i = this.s.anchor;
    this.strip.setAttribute('aria-valuenow', String(i));
    this.strip.setAttribute('aria-valuetext', this.p.swatches[i]!.step);
    this.strip.replaceChildren(
      ...gen.map((x, k) =>
        h(
          'span',
          { class: `ce-stop${k === i ? ' on' : ''}${this.p.swatches[k]!.derived ? ' end' : ''}` },
          swatchCanvas(x.info, this.shown),
          h('span', { class: 'ce-stop-step' }, this.p.swatches[k]!.step, k === i ? icon('pin') : null),
        ),
      ),
    );
  }

  /** Readouts for every channel; the edited channel's input unless it is being typed in. */
  private drawValues() {
    const a = this.s.anchorColor;
    const text = { l: (a.l * 100).toFixed(1), c: a.c.toFixed(3), h: (((a.h % 360) + 360) % 360).toFixed(1) };
    // An end as anchor pins the curves to the end's color, which only the global ends can change.
    const atEnd = !!this.p.swatches[this.s.anchor]?.derived;
    this.values.dataset.tip = atEnd ? CURVE_TIP.anchorEnd : '';
    for (const ch of ['l', 'c', 'h'] as const) {
      const input = this.anchorInputs[ch]!;
      const range = this.ranges[ch]!;
      const edited = ch === this.channel && !atEnd;
      this.editors[ch]!.hidden = !edited;
      this.readouts[ch]!.hidden = edited;
      this.readouts[ch]!.textContent = text[ch];
      if (document.activeElement !== input) input.value = text[ch];
      if (document.activeElement !== range) range.value = text[ch];
    }
  }

  private curveBlock(ch: 'l' | 'c' | 'h', label: string, presets: [string, () => void][], extra: Node | null) {
    const t = positions(this.p);
    const hueSpan = () => {
      const vals = [...this.s.curves.h.points.map((q) => q.v), this.s.anchorColor.h];
      const lo = Math.min(...vals, this.s.anchorColor.h - 60);
      const hi = Math.max(...vals, this.s.anchorColor.h + 60);
      return [Math.floor(lo / 10) * 10, Math.ceil(hi / 10) * 10] as [number, number];
    };
    const chromaTop = () => Math.min(C_MAX, Math.max(0.2, this.s.anchorColor.c * 1.3, ...this.p.swatches.map((s) => s.info.oklch.c * 1.3)));
    const canvas = new CurveCanvas({
      label,
      domain: () => (ch === 'l' ? [0, 1] : ch === 'c' ? [0, chromaTop()] : hueSpan()),
      positions: t,
      labels: this.p.swatches.map((s) => s.step),
      anchorT: () => anchorT(this.p, this.s),
      curve: () => this.s.curves[ch],
      before: () =>
        this.p.swatches.map((s) => (ch === 'h' ? (Number.isNaN(s.info.oklch.h) ? this.s.anchorColor.h : unwrapNear(s.info.oklch.h, this.s.anchorColor.h)) : s.info.oklch[ch])),
      after: () =>
        this.withEnds(generate(this.p, this.s, this.gamut)).map((g) => ({
          v: ch === 'h' ? (Number.isNaN(g.info.oklch.h) ? g.wanted.h : unwrapNear(g.info.oklch.h, g.wanted.h)) : g.info.oklch[ch],
          mapped: g.mapped,
        })),
      guides:
        ch === 'c'
          ? () => {
              const fl = evaluate(this.s.curves.l);
              const fh = evaluate(this.s.curves.h);
              return [{ values: (x: number) => maxChroma(fl(x), fh(x), this.gamut), dash: [5, 4], label: 'gamut' }];
            }
          : undefined,
      format: (v) => (ch === 'l' ? `${(v * 100).toFixed(1)}` : ch === 'c' ? v.toFixed(3) : `${(((v % 360) + 360) % 360).toFixed(0)}°`),
      onChange: (curve, commit) => this.onCurve(ch, curve, commit),
    });
    this.canvases.push(canvas);
    const block = h(
      'section',
      { class: 'ce-curve' },
      h(
        'div',
        { class: 'ce-curve-head' },
        h('h3', null, label),
        h('div', { class: 'chips' }, presets.map(([name, fn]) => h('button', { type: 'button', class: 'chip-toggle', 'data-tip': CURVE_TIP.presets[name], onclick: fn }, name))),
        extra,
      ),
      canvas.el,
    );
    this.blocks[ch] = block;
    return block;
  }

  private hueShift() {
    const deg = h('input', { type: 'number', value: '10', step: '1', min: '-90', max: '90', 'aria-label': 'Hue shift in degrees' });
    return h(
      'span',
      { class: 'ce-inline' },
      h('button', { type: 'button', class: 'chip-toggle', 'data-tip': CURVE_TIP.shift, onclick: () => this.set(presetH(this.p, this.s, 'shift', Number(deg.value) || 0), true) }, 'Shift'),
      deg,
      h('span', { class: 'meta' }, '° from the anchor toward the last step (opposite toward the first)'),
    );
  }

  private contrastForm() {
    const view = contrastOf(store.get());
    const ends = view.rowEnds.get(this.p.id) ?? view.ends;
    const levels = view.levels.length ? view.levels : [];
    const details = h('details', { class: 'ce-contrast' });
    if (!levels.length) {
      details.append(h('summary', { 'data-tip': CURVE_TIP.contrast }, 'Contrast-targeted…'), h('p', { class: 'meta' }, 'Turn on a contrast target in Base colors to use this.'));
      return details;
    }
    const levelSelect = h('select', { 'aria-label': 'Contrast level' }, levels.map((l, i) => h('option', { value: String(i) }, l.label)));
    const stepSelect = (end: EndId) =>
      h(
        'select',
        { 'aria-label': `Step that should just pass on the ${end} end` },
        h('option', { value: '' }, '—'),
        this.p.swatches.map((s, i) => (s.derived ? null : h('option', { value: String(i) }, s.step))),
      );
    const light = stepSelect('light');
    const dark = stepSelect('dark');
    const run = () => {
      const targets = (
        [
          [light, 'light'],
          [dark, 'dark'],
        ] as const
      )
        .filter(([sel]) => sel.value !== '')
        .map(([sel, end]) => ({ index: Number(sel.value), end: ends[end] }));
      if (!targets.length) return;
      const { state, notes } = contrastTargetedL(this.p, this.s, targets, levels[Number(levelSelect.value)]!, this.gamut);
      this.notes.replaceChildren(...notes.map((n) => h('li', { class: 'warning' }, n)));
      this.set(state, true);
    };
    details.append(
      h('summary', { 'data-tip': CURVE_TIP.contrast }, 'Contrast-targeted…'),
      h(
        'div',
        { class: 'ce-inline' },
        levelSelect,
        h('label', null, ' first passes on its light end at ', light),
        h('label', null, ' last passes on its dark end at ', dark),
        h('button', { type: 'button', 'data-tip': CURVE_TIP.solve, onclick: run }, 'Solve'),
      ),
      h('p', { class: 'meta' }, 'Sets those steps’ lightness so they just pass, keeping chroma and hue; the rest of the curve runs smoothly through the ends and the anchor.'),
    );
    return details;
  }

  // -------------------------------------------------------------------------
  // Rendering

  get paletteId() {
    return this.p.id;
  }

  /** Show one channel's curve and point the panel at that channel's button. */
  focus(ch: 'l' | 'c' | 'h') {
    this.channel = ch;
    for (const [k, el] of Object.entries(this.blocks)) el.hidden = k !== ch;
    this.title.textContent = { l: 'Lightness', c: 'Chroma', h: 'Hue' }[ch];
    this.drawValues();
    this.redraw();
    this.position();
    this.blocks[ch]?.querySelector<HTMLElement>('canvas')?.focus({ preventScroll: true });
  }

  /** Below the button if it fits, else above; the caret points at the button's centre. */
  private position() {
    const btn = document.querySelector<HTMLElement>(`[data-curve="${CSS.escape(`${this.p.id}:${this.channel}`)}"]`);
    if (!btn || !this.dialog.open) return;
    const r = btn.getBoundingClientRect();
    const d = this.dialog;
    const gap = 12;
    const margin = 8;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const roomBelow = vh - r.bottom - gap - margin;
    const roomAbove = r.top - gap - margin;
    const below = roomBelow >= 360 || roomBelow >= roomAbove;
    d.style.maxHeight = `${Math.max(240, below ? roomBelow : roomAbove)}px`;
    const w = d.offsetWidth;
    const hgt = d.offsetHeight;
    const left = Math.min(Math.max(margin, r.right + 10 - w), vw - w - margin);
    const top = below ? r.bottom + gap : r.top - gap - hgt;
    d.style.left = `${Math.round(left)}px`;
    d.style.top = `${Math.round(Math.max(margin, top))}px`;
    d.dataset.side = below ? 'below' : 'above';
    d.style.setProperty('--caret-x', `${Math.round(r.left + r.width / 2 - left)}px`);
  }

  redraw() {
    for (const c of this.canvases) c.draw();
    paintAll(this.dialog);
  }

  private refresh(full: boolean) {
    if (this.anchorInputs.l) this.drawValues();
    this.undoButton.disabled = this.history.length === 0;
    this.redoButton.disabled = this.future.length === 0;

    const g = this.generated();
    const edits = this.edits();
    this.applyButton.textContent = edits.length ? `Apply ${plural(edits.length, 'change')}` : 'Apply';
    this.applyButton.disabled = edits.length === 0;
    this.drawStrip(g.source);
    // Rows show the preview only once the curves change something.
    const byStep = (gen: GenStep[]) => new Map(gen.map((x) => [x.step, x.info]));
    if (edits.length) setPreview(new Map([[this.p.id, byStep(g.source.filter((_, i) => !this.p.swatches[i]!.derived))], ...g.batch.map((b) => [b.palette.id, byStep(b.gen)] as const)]));
    else clearPreview();
    const mapped = g.source.filter((x) => x.mapped).length + g.batch.reduce((n, b) => n + b.gen.filter((x) => x.mapped).length, 0);
    this.mappedNote.textContent = mapped ? `${plural(mapped, 'color')} asked for by the curves ${mapped === 1 ? 'is' : 'are'} outside the gamut and mapped down (ringed dots on the chroma curve).` : '';
    if (full) {
      this.batchBox.replaceChildren(this.batchControls());
      this.impact.replaceChildren(this.semanticImpact(g));
    }
    for (const c of this.canvases) c.draw();
    paintAll(this.dialog);
  }

  private batchControls() {
    const mode = (value: CurveState['lightness'], label: string, tip: string) => {
      const r = h('input', { type: 'radio', name: 'ce-lightness', value, checked: this.s.lightness === value });
      r.addEventListener('change', () => this.set({ ...this.s, lightness: value }, true));
      return h('label', { 'data-tip': tip }, r, ` ${label}`);
    };
    return h(
      'div',
      null,
      h(
        'div',
        { class: 'ce-inline' },
        h('span', { class: 'meta' }, 'Lightness: '),
        mode('match', 'same as this palette at each step (equal contrast across palettes)', CURVE_TIP.match),
        mode('relative', 'shifted with each palette’s own anchor', CURVE_TIP.relative),
      ),
      h('p', { class: 'meta' }, 'Chroma scales and hue turns with each palette’s own anchor color.'),
      h(
        'ul',
        { class: 'ce-batch-list' },
        this.others.map((o) => {
          const box = h('input', { type: 'checkbox', checked: this.s.batch.includes(o.id) });
          box.addEventListener('change', () =>
            this.set({ ...this.s, batch: box.checked ? [...this.s.batch, o.id] : this.s.batch.filter((id) => id !== o.id) }, true),
          );
          return h('li', null, h('label', null, box, ' ', h('code', null, o.name)));
        }),
      ),
    );
  }

  /** Semantic (alias) tokens, in every theme, whose base color this edit changes. */
  private semanticImpact(g: ReturnType<CurveEditor['generated']>) {
    const changed = new Map<string, { before: ColorInfo; after: ColorInfo }>();
    const record = (p: Palette, gen: GenStep[]) =>
      gen.forEach((x, i) => {
        const before = p.swatches[i]!.info;
        if (toEdits({ ...p, swatches: [p.swatches[i]!] }, [x]).length) changed.set(p.swatches[i]!.token.id, { before, after: x.info });
      });
    record(this.p, g.source);
    for (const b of g.batch) record(b.palette, b.gen);
    if (!changed.size) return h('p', { class: 'meta' }, 'No base colors change yet.');

    const state = store.get();
    const models = state.themeModels.length ? state.themeModels.map((m) => ({ name: m.theme.name, model: m.model })) : allModels(state).map((model) => ({ name: '', model }));
    const hits = new Map<string, { base: string; themes: string[] }>();
    for (const { name, model } of models) {
      for (const t of model.tokens.values()) {
        if (!t.aliasOf || t.extendedFrom) continue;
        const base = rootOf(model, t.id);
        if (!base || !changed.has(base)) continue;
        const hit = hits.get(t.id) ?? { base, themes: [] };
        if (name) hit.themes.push(name);
        hits.set(t.id, hit);
      }
    }
    const list = [...hits].slice(0, 40);
    return h(
      'div',
      null,
      h('p', { class: 'meta' }, `${plural(changed.size, 'base color')} change, affecting ${plural(hits.size, 'semantic token')}.`),
      list.length
        ? h(
            'ul',
            { class: 'ce-impact-list' },
            list.map(([id, hit]) => {
              const c = changed.get(hit.base)!;
              return h(
                'li',
                null,
                h('span', { class: 'mini' }, swatchCanvas(c.before, this.shown)),
                '→',
                h('span', { class: 'mini' }, swatchCanvas(c.after, this.shown)),
                h('code', null, id),
                h('span', { class: 'meta' }, ` via ${hit.base}${hit.themes.length && hit.themes.length < models.length ? ` (${hit.themes.join(', ')})` : ''}`),
              );
            }),
          )
        : null,
      hits.size > list.length ? h('p', { class: 'meta' }, `…and ${hits.size - list.length} more.`) : null,
    );
  }
}

function rootOf(model: Model, id: string): string | undefined {
  let cur = model.tokens.get(id);
  for (let k = 0; k < 32 && cur?.aliasOf; k++) cur = model.tokens.get(cur.aliasOf);
  return cur && !cur.aliasOf ? cur.id : undefined;
}

const unwrapNear = (h: number, base: number) => base + ((((h - base) % 360) + 540) % 360) - 180;
