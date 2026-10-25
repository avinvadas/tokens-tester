import { lch, type ColorInfo, type Gamut } from '../color/format';
import { analyzePalette, type EndId } from '../contrast/analyze';
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
import { checkPalettes, type ScaleFlag } from '../palette/checks';
import type { Palette } from '../palette/detect';
import { allModels, applyEdits, store } from '../state/app';
import { contrastOf } from '../state/contrast';
import { palettesOf } from '../state/palettes';
import { displayGamut, paintAll, swatchCanvas } from './canvas';
import { swatchContrast } from './contrast';
import { CurveCanvas } from './curve-canvas';
import { h, masked, plural } from './dom';

/**
 * Batch-edit a palette with lightness, chroma and hue curves around an
 * anchor color. Nothing is written until Apply; the whole edit (this palette
 * and any batch palettes) is then one undoable step.
 */
export function openCurveEditor(paletteId: string) {
  const state = store.get();
  const set = palettesOf(state);
  const palette = set.palettes.find((p) => p.id === paletteId);
  if (!palette) return;
  const editor = new CurveEditor(palette, set.palettes.filter((p) => p.included && p.id !== paletteId), state.settings.gamut);
  document.body.append(editor.dialog);
  editor.dialog.showModal();
  editor.redraw();
}

class CurveEditor {
  readonly dialog = masked(h('dialog', { class: 'curve-editor', 'aria-label': 'Curve editor' }));
  private s: CurveState;
  private history: CurveState[] = [];
  private future: CurveState[] = [];
  private canvases: CurveCanvas[] = [];
  private preview = h('div', { class: 'ce-preview' });
  private batchBox = h('div', { class: 'ce-batch' });
  private impact = h('div', { class: 'ce-impact' });
  private anchorInputs!: Record<'l' | 'c' | 'h', HTMLInputElement>;
  private anchorSwatch = h('span', { class: 'ce-anchor-swatch' });
  private anchorSelect!: HTMLSelectElement;
  private applyButton = h('button', { type: 'button', class: 'primary' }, 'Apply');
  private undoButton = h('button', { type: 'button' }, 'Undo');
  private redoButton = h('button', { type: 'button' }, 'Redo');
  private notes = h('ul', { class: 'flags ce-notes' });
  private shown: Gamut;
  private resize = new ResizeObserver(() => this.redraw());

  constructor(
    private p: Palette,
    private others: Palette[],
    private gamut: Gamut,
  ) {
    this.s = initialState(p);
    this.shown = displayGamut(gamut);
    this.build();
    this.dialog.addEventListener('close', () => {
      this.resize.disconnect();
      this.dialog.remove();
    });
    this.resize.observe(this.dialog);
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
      source: generate(this.p, this.s, this.gamut),
      batch: this.others.filter((o) => this.s.batch.includes(o.id)).map((o) => ({ palette: o, gen: generateFor(o, this.p, this.s, this.gamut) })),
    };
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

    this.dialog.append(
      h(
        'header',
        { class: 'ce-head' },
        h('h2', null, 'Curves: ', h('code', null, this.p.name)),
        h('button', { type: 'button', class: 'ghost', onclick: close, 'aria-label': 'Close without applying' }, '✕'),
      ),
      h(
        'p',
        { class: 'meta' },
        'Each curve runs across the steps and passes through the anchor (◆). Drag handles, double-click to add or remove one. Hollow dots are the current colors, filled dots the result. Nothing changes in your files until you apply.',
      ),
      this.anchorRow(),
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
      this.notes,
      h('section', null, h('h3', null, 'Preview'), this.preview),
      this.others.length ? h('section', null, h('h3', null, 'Apply to more palettes'), this.batchBox) : '',
      h('section', null, h('h3', null, 'Semantic tokens affected'), this.impact),
      h(
        'footer',
        { class: 'ce-foot' },
        this.undoButton,
        this.redoButton,
        h('button', { type: 'button', onclick: () => this.set(initialState(this.p, this.s.anchor), true) }, 'Reset'),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', onclick: close }, 'Cancel'),
        this.applyButton,
      ),
    );
    this.refresh(true);
  }

  private anchorRow() {
    this.anchorSelect = h(
      'select',
      { 'aria-label': 'Anchor step' },
      this.p.swatches.map((sw, i) => h('option', { value: String(i), selected: i === this.s.anchor }, sw.step)),
    );
    this.anchorSelect.addEventListener('change', () => this.set(setAnchorStep(this.p, this.s, Number(this.anchorSelect.value)), true));
    const input = (ch: 'l' | 'c' | 'h', label: string, min: number, max: number, step: number) => {
      const el = h('input', { type: 'number', min, max, step, 'aria-label': `Anchor ${label}` });
      el.addEventListener('change', () => {
        const raw = Number(el.value);
        if (!Number.isFinite(raw)) return;
        const v = ch === 'l' ? raw / 100 : raw;
        this.set(setAnchorColor(this.p, this.s, { [ch]: v }), true);
      });
      return el;
    };
    this.anchorInputs = { l: input('l', 'lightness', 0, 100, 0.5), c: input('c', 'chroma', 0, C_MAX, 0.005), h: input('h', 'hue', 0, 360, 1) };
    return h(
      'div',
      { class: 'ce-anchor' },
      h('label', null, 'Anchor step ', this.anchorSelect),
      this.anchorSwatch,
      h('label', null, 'L ', this.anchorInputs.l),
      h('label', null, 'C ', this.anchorInputs.c),
      h('label', null, 'H ', this.anchorInputs.h),
    );
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
        generate(this.p, this.s, this.gamut).map((g) => ({
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
    return h(
      'section',
      { class: 'ce-curve' },
      h(
        'div',
        { class: 'ce-curve-head' },
        h('h3', null, label),
        h('div', { class: 'chips' }, presets.map(([name, fn]) => h('button', { type: 'button', class: 'chip-toggle', onclick: fn }, name))),
        extra,
      ),
      canvas.el,
    );
  }

  private hueShift() {
    const deg = h('input', { type: 'number', value: '10', step: '1', min: '-90', max: '90', 'aria-label': 'Hue shift in degrees' });
    return h(
      'span',
      { class: 'ce-inline' },
      h('button', { type: 'button', class: 'chip-toggle', onclick: () => this.set(presetH(this.p, this.s, 'shift', Number(deg.value) || 0), true) }, 'Shift'),
      deg,
      h('span', { class: 'meta' }, '° from the anchor toward the last step (opposite toward the first)'),
    );
  }

  private contrastForm() {
    const view = contrastOf(store.get());
    const levels = view.levels.length ? view.levels : [];
    const details = h('details', { class: 'ce-contrast' });
    if (!levels.length) {
      details.append(h('summary', null, 'Contrast-targeted…'), h('p', { class: 'meta' }, 'Turn on a contrast target in the palette view to use this.'));
      return details;
    }
    const levelSelect = h('select', { 'aria-label': 'Contrast level' }, levels.map((l, i) => h('option', { value: String(i) }, l.label)));
    const stepSelect = (end: EndId) =>
      h(
        'select',
        { 'aria-label': `Step that should just pass on the ${end} end` },
        h('option', { value: '' }, '—'),
        this.p.swatches.map((s, i) => h('option', { value: String(i) }, s.step)),
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
        .map(([sel, end]) => ({ index: Number(sel.value), end: view.ends[end] }));
      if (!targets.length) return;
      const { state, notes } = contrastTargetedL(this.p, this.s, targets, levels[Number(levelSelect.value)]!, this.gamut);
      this.notes.replaceChildren(...notes.map((n) => h('li', { class: 'warning' }, n)));
      this.set(state, true);
    };
    details.append(
      h('summary', null, 'Contrast-targeted…'),
      h(
        'div',
        { class: 'ce-inline' },
        levelSelect,
        h('label', null, ` first passes on ${view.ends.light.name} at `, light),
        h('label', null, ` last passes on ${view.ends.dark.name} at `, dark),
        h('button', { type: 'button', onclick: run }, 'Solve'),
      ),
      h('p', { class: 'meta' }, 'Sets those steps’ lightness so they just pass, keeping chroma and hue; the rest of the curve runs smoothly through the ends and the anchor.'),
    );
    return details;
  }

  // -------------------------------------------------------------------------
  // Rendering

  redraw() {
    for (const c of this.canvases) c.draw();
    paintAll(this.dialog);
  }

  private refresh(full: boolean) {
    const a = this.s.anchorColor;
    if (this.anchorInputs) {
      this.anchorInputs.l.value = (a.l * 100).toFixed(1);
      this.anchorInputs.c.value = a.c.toFixed(3);
      this.anchorInputs.h.value = ((((a.h % 360) + 360) % 360)).toFixed(1);
      this.anchorSelect.value = String(this.s.anchor);
    }
    this.undoButton.disabled = this.history.length === 0;
    this.redoButton.disabled = this.future.length === 0;

    const g = this.generated();
    const edits = this.edits();
    this.applyButton.textContent = edits.length ? `Apply ${plural(edits.length, 'change')}` : 'Apply';
    this.applyButton.disabled = edits.length === 0;
    this.anchorSwatch.replaceChildren(swatchCanvas(g.source[this.s.anchor]!.info, this.shown));
    this.preview.replaceChildren(this.comparison(this.p, g.source));
    if (full) {
      this.batchBox.replaceChildren(this.batchControls(g.batch));
      this.impact.replaceChildren(this.semanticImpact(g));
    }
    for (const c of this.canvases) c.draw();
    paintAll(this.dialog);
  }

  /** Before and after strips with the result's contrast and scale checks. */
  private comparison(p: Palette, gen: GenStep[]) {
    const view = contrastOf(store.get());
    const after: Palette = { ...p, swatches: p.swatches.map((sw, i) => ({ ...sw, info: gen[i]!.info })), flags: [], direction: 'flat' };
    checkPalettes([after], this.gamut);
    const scores = view.levels.length ? analyzePalette(after, view.ends, view.levels).scores : undefined;
    const flags = after.flags.filter((f) => f.kind !== 'missing-steps');
    const strip = (infos: ColorInfo[], label: string, extra?: (i: number) => Node | null) =>
      h(
        'div',
        { class: 'ce-strip' },
        h('span', { class: 'ce-strip-label' }, label),
        h(
          'div',
          { class: 'swatches', style: `--n: ${infos.length}` },
          infos.map((info, i) => h('div', { class: `swatch${gen[i]!.mapped ? ' flagged warning' : ''}` }, swatchCanvas(info, this.shown), h('div', { class: 'labels' }, h('span', { class: 'step' }, p.swatches[i]!.step), extra?.(i) ?? null))),
        ),
      );
    return h(
      'div',
      null,
      strip(p.swatches.map((s) => s.info), 'Before'),
      strip(gen.map((x) => x.info), 'After', (i) => {
        const r = lch(gen[i]!.info);
        return h('div', null, h('span', { class: 'lch' }, h('span', null, `L ${r.l}`), h('span', null, `C ${r.c}`)), scores ? swatchContrast(scores[p.swatches[i]!.step], view.levels) : null);
      }),
      flags.length ? h('ul', { class: 'flags' }, flags.map((f: ScaleFlag) => h('li', { class: f.severity }, f.message))) : h('p', { class: 'ok' }, 'The result passes the scale checks.'),
    );
  }

  private batchControls(batch: { palette: Palette; gen: GenStep[] }[]) {
    const mode = (value: CurveState['lightness'], label: string) => {
      const r = h('input', { type: 'radio', name: 'ce-lightness', value, checked: this.s.lightness === value });
      r.addEventListener('change', () => this.set({ ...this.s, lightness: value }, true));
      return h('label', null, r, ` ${label}`);
    };
    return h(
      'div',
      null,
      h(
        'div',
        { class: 'ce-inline' },
        h('span', { class: 'meta' }, 'Lightness: '),
        mode('match', 'same as this palette at each step (equal contrast across palettes)'),
        mode('relative', 'shifted with each palette’s own anchor'),
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
          const b = batch.find((x) => x.palette.id === o.id);
          return h('li', null, h('label', null, box, ' ', h('code', null, o.name)), b ? this.comparison(o, b.gen) : null);
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
