import { evaluate, type Curve } from '../curves/model';
import type { Point } from '../curves/spline';

/**
 * One curve (lightness, chroma or hue) across a palette's steps, drawn on a
 * canvas with draggable handles.
 *
 * Mouse: drag a handle; double-click empty space to add a handle, or a
 * handle to remove it. Keyboard (canvas focused): ←/→ choose a handle,
 * ↑/↓ change its value (Shift for bigger steps), Delete removes it.
 * The first and last handles stay at their step positions; a pinned handle
 * (◆) does not move at all.
 */

export interface CurveCanvasOptions {
  label: string;
  domain: () => [number, number];
  positions: number[];
  labels: string[];
  /** Positions of the pinned steps, drawn ◆. */
  pinTs: () => number[];
  curve: () => Curve;
  /** Current palette values per step (hollow dots). */
  before: () => number[];
  /** Generated values per step after gamut mapping (filled dots); `mapped` steps get a ring. */
  after: () => { v: number; mapped: boolean }[];
  /** Optional limit lines, e.g. the largest chroma that fits sRGB / P3. */
  guides?: () => { values: (t: number) => number; dash: number[]; label: string }[];
  format: (v: number) => string;
  onChange: (curve: Curve, commit: boolean) => void;
}

const PAD = { l: 44, r: 12, t: 10, b: 22 };
const HIT = 9;

export class CurveCanvas {
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private readout: HTMLDivElement;
  private drag: { index: number; moved: boolean } | undefined;
  private selected = -1;

  constructor(private o: CurveCanvasOptions) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'curve-canvas';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'application');
    this.canvas.setAttribute('aria-label', `${o.label} curve. Arrow keys choose a handle and change its value; Delete removes it.`);
    this.readout = document.createElement('div');
    this.readout.className = 'curve-readout';
    this.el = document.createElement('div');
    this.el.className = 'curve-box';
    this.el.append(this.canvas, this.readout);
    this.canvas.addEventListener('pointerdown', (e) => this.down(e));
    this.canvas.addEventListener('pointermove', (e) => this.move(e));
    this.canvas.addEventListener('pointerup', (e) => this.up(e));
    this.canvas.addEventListener('pointercancel', (e) => this.up(e));
    this.canvas.addEventListener('dblclick', (e) => this.double(e));
    this.canvas.addEventListener('keydown', (e) => this.key(e));
    this.canvas.addEventListener('blur', () => {
      this.selected = -1;
      this.draw();
    });
  }

  // -------------------------------------------------------------------------
  // Geometry

  private size() {
    return { w: this.canvas.clientWidth, h: this.canvas.clientHeight };
  }
  private x(t: number) {
    const { w } = this.size();
    return PAD.l + t * (w - PAD.l - PAD.r);
  }
  private y(v: number) {
    const { h } = this.size();
    const [lo, hi] = this.o.domain();
    return PAD.t + (1 - (v - lo) / (hi - lo || 1)) * (h - PAD.t - PAD.b);
  }
  private t(x: number) {
    const { w } = this.size();
    return Math.min(1, Math.max(0, (x - PAD.l) / (w - PAD.l - PAD.r)));
  }
  private v(y: number) {
    const { h } = this.size();
    const [lo, hi] = this.o.domain();
    const v = lo + (1 - (y - PAD.t) / (h - PAD.t - PAD.b)) * (hi - lo);
    return Math.min(hi, Math.max(lo, v));
  }

  private pinned(p: Point) {
    return p.t <= 1e-6 || p.t >= 1 - 1e-6 || this.isAnchor(p);
  }
  private isAnchor(p: Point) {
    return this.o.pinTs().some((t) => Math.abs(p.t - t) < 1e-6);
  }

  private hit(e: PointerEvent | MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const pts = this.o.curve().points;
    let best = -1;
    let dist = HIT;
    pts.forEach((p, i) => {
      const d = Math.hypot(this.x(p.t) - px, this.y(p.v) - py);
      if (d <= dist) {
        dist = d;
        best = i;
      }
    });
    return { index: best, px, py };
  }

  // -------------------------------------------------------------------------
  // Interaction

  private update(points: Point[], commit: boolean) {
    this.o.onChange({ ...this.o.curve(), points }, commit);
  }

  private down(e: PointerEvent) {
    const { index } = this.hit(e);
    if (index === -1) return;
    e.preventDefault();
    this.canvas.focus();
    this.canvas.setPointerCapture(e.pointerId);
    this.drag = { index, moved: false };
    this.selected = index;
    this.draw();
  }

  private move(e: PointerEvent) {
    if (!this.drag) {
      const { index } = this.hit(e);
      this.canvas.style.cursor = index === -1 ? 'crosshair' : this.isAnchor(this.o.curve().points[index]!) ? 'not-allowed' : 'grab';
      return;
    }
    const r = this.canvas.getBoundingClientRect();
    const pts = this.o.curve().points.map((p) => ({ ...p }));
    const p = pts[this.drag.index]!;
    if (this.isAnchor(p)) return;
    p.v = this.v(e.clientY - r.top);
    if (!this.pinned(p)) {
      const lo = (pts[this.drag.index - 1]?.t ?? 0) + 0.01;
      const hi = (pts[this.drag.index + 1]?.t ?? 1) - 0.01;
      p.t = Math.min(hi, Math.max(lo, this.t(e.clientX - r.left)));
    }
    this.drag.moved = true;
    this.update(pts, false);
  }

  private up(e: PointerEvent) {
    if (!this.drag) return;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    const moved = this.drag.moved;
    this.drag = undefined;
    if (moved) this.update(this.o.curve().points, true);
  }

  private double(e: MouseEvent) {
    const { index, px } = this.hit(e);
    const pts = this.o.curve().points;
    if (index !== -1) {
      if (this.pinned(pts[index]!)) return;
      this.update(pts.filter((_, i) => i !== index), true);
      return;
    }
    const t = this.t(px);
    const v = evaluate(this.o.curve())(t);
    this.update([...pts, { t, v }].sort((a, b) => a.t - b.t), true);
  }

  private key(e: KeyboardEvent) {
    const pts = this.o.curve().points;
    if (!pts.length) return;
    const [lo, hi] = this.o.domain();
    const step = ((hi - lo) / 100) * (e.shiftKey ? 5 : 1);
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      this.selected = this.selected === -1 ? 0 : Math.min(pts.length - 1, Math.max(0, this.selected + (e.key === 'ArrowRight' ? 1 : -1)));
      this.draw();
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && this.selected !== -1 && !this.isAnchor(pts[this.selected]!)) {
      const next = pts.map((p, i) => (i === this.selected ? { ...p, v: Math.min(hi, Math.max(lo, p.v + (e.key === 'ArrowUp' ? step : -step))) } : p));
      this.update(next, true);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected !== -1 && !this.pinned(pts[this.selected]!)) {
      this.update(pts.filter((_, i) => i !== this.selected), true);
      this.selected = -1;
    } else {
      return;
    }
    e.preventDefault();
  }

  // -------------------------------------------------------------------------
  // Drawing

  draw() {
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = this.size();
    if (!w || !h) return;
    if (this.canvas.width !== Math.round(w * dpr)) this.canvas.width = Math.round(w * dpr);
    if (this.canvas.height !== Math.round(h * dpr)) this.canvas.height = Math.round(h * dpr);
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const css = getComputedStyle(this.canvas);
    const color = (name: string) => css.getPropertyValue(name).trim() || '#888';
    const [lo, hi] = this.o.domain();
    const plotW = w - PAD.l - PAD.r;

    // Grid and axis labels.
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.fillStyle = color('--muted');
    ctx.strokeStyle = color('--border');
    ctx.lineWidth = 1;
    for (let k = 0; k <= 4; k++) {
      const v = lo + ((hi - lo) * k) / 4;
      const y = Math.round(this.y(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(PAD.l, y);
      ctx.lineTo(PAD.l + plotW, y);
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.o.format(v), PAD.l - 6, y);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    this.o.positions.forEach((t, i) => {
      const x = Math.round(this.x(t)) + 0.5;
      ctx.strokeStyle = color('--border');
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(x, PAD.t);
      ctx.lineTo(x, h - PAD.b);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color('--muted');
      ctx.fillText(this.o.labels[i]!, x, h - PAD.b + 5);
    });

    // Limit lines (e.g. gamut chroma).
    for (const g of this.o.guides?.() ?? []) {
      ctx.strokeStyle = color('--warn');
      ctx.setLineDash(g.dash);
      ctx.beginPath();
      for (let k = 0; k <= 80; k++) {
        const t = k / 80;
        const y = this.y(Math.min(hi, g.values(t)));
        if (k === 0) ctx.moveTo(this.x(t), y);
        else ctx.lineTo(this.x(t), y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // The curve.
    const f = evaluate(this.o.curve());
    ctx.strokeStyle = color('--accent');
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let k = 0; k <= 120; k++) {
      const t = k / 120;
      const y = this.y(Math.min(hi, Math.max(lo, f(t))));
      if (k === 0) ctx.moveTo(this.x(t), y);
      else ctx.lineTo(this.x(t), y);
    }
    ctx.stroke();
    ctx.lineWidth = 1;

    // Before (hollow) and after (filled) values at each step.
    const before = this.o.before();
    const after = this.o.after();
    this.o.positions.forEach((t, i) => {
      const x = this.x(t);
      ctx.strokeStyle = color('--muted');
      ctx.beginPath();
      ctx.arc(x, this.y(before[i]!), 3.5, 0, Math.PI * 2);
      ctx.stroke();
      const a = after[i]!;
      ctx.fillStyle = color('--text');
      ctx.beginPath();
      ctx.arc(x, this.y(Math.min(hi, Math.max(lo, a.v))), 2.5, 0, Math.PI * 2);
      ctx.fill();
      if (a.mapped) {
        ctx.strokeStyle = color('--warn');
        ctx.beginPath();
        ctx.arc(x, this.y(Math.min(hi, a.v)), 6, 0, Math.PI * 2);
        ctx.stroke();
      }
    });

    // Handles.
    this.o.curve().points.forEach((p, i) => {
      const x = this.x(p.t);
      const y = this.y(Math.min(hi, Math.max(lo, p.v)));
      ctx.fillStyle = i === this.selected ? color('--accent') : color('--surface');
      ctx.strokeStyle = color('--accent');
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (this.isAnchor(p)) {
        ctx.moveTo(x, y - 7);
        ctx.lineTo(x + 7, y);
        ctx.lineTo(x, y + 7);
        ctx.lineTo(x - 7, y);
        ctx.closePath();
      } else {
        ctx.arc(x, y, 5, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.stroke();
      ctx.lineWidth = 1;
    });

    const sel = this.o.curve().points[this.selected];
    this.readout.textContent = sel ? `${this.o.label}: ${this.o.format(sel.v)}` : '';
  }
}
