import { paintStyle, type ColorInfo, type Gamut } from '../color/format';

/**
 * Swatches are painted on <canvas> rather than as CSS backgrounds: usability
 * recorders capture DOM styles but not canvas pixels, so brand colors never
 * end up in a recording.
 */

/** The gamut this screen can actually show for the chosen target. */
export function displayGamut(target: Gamut): Gamut {
  return target === 'p3' && typeof matchMedia === 'function' && matchMedia('(color-gamut: p3)').matches ? 'p3' : 'srgb';
}

/** `mark`: draw the corner triangle on colors outside the gamut (off where a badge says so instead). */
export function swatchCanvas(info: ColorInfo, gamut: Gamut, mark = true): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.className = 'swatch-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  (canvas as HTMLCanvasElement & { paint?: () => void }).paint = () => paint(canvas, info, gamut, mark);
  return canvas;
}

/** Repaint every swatch canvas inside `root` at its current size. */
export function paintAll(root: ParentNode) {
  for (const c of root.querySelectorAll<HTMLCanvasElement & { paint?: () => void }>('canvas.swatch-canvas')) c.paint?.();
}

/**
 * A foreground on its background: "Aa" for text, a ring and bar for UI parts
 * (icons, borders). Painted like swatches, so the colors stay out of recordings.
 */
export function pairCanvas(fg: ColorInfo, bg: ColorInfo, kind: 'text' | 'ui', gamut: Gamut): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.className = 'swatch-canvas pair-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  (canvas as HTMLCanvasElement & { paint?: () => void }).paint = () => {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d', { colorSpace: gamut === 'p3' ? 'display-p3' : 'srgb' });
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    if (bg.oklch.alpha < 1) checkerboard(ctx, w, h, 6 * dpr);
    ctx.fillStyle = paintStyle(bg, gamut);
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = ctx.strokeStyle = paintStyle(fg, gamut);
    if (kind === 'text') {
      ctx.font = `600 ${Math.round(h * 0.5)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Aa', w / 2, h / 2 + h * 0.03);
    } else {
      const r = h * 0.22;
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.arc(w * 0.33, h / 2, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillRect(w * 0.55, h / 2 - dpr, w * 0.25, 2 * dpr);
    }
  };
  return canvas;
}

function paint(canvas: HTMLCanvasElement, info: ColorInfo, gamut: Gamut, mark: boolean) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d', { colorSpace: gamut === 'p3' ? 'display-p3' : 'srgb' });
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  if (info.oklch.alpha < 1) checkerboard(ctx, w, h, 6 * dpr);
  ctx.fillStyle = paintStyle(info, gamut);
  ctx.fillRect(0, 0, w, h);
  const outside = gamut === 'p3' ? !info.inP3 : !info.inSrgb;
  if (outside && mark) {
    // Corner mark: this swatch is a mapped approximation of the real color.
    const s = Math.min(w, h) * 0.32;
    ctx.fillStyle = info.oklch.l > 0.6 ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.75)';
    ctx.beginPath();
    ctx.moveTo(w - s, 0);
    ctx.lineTo(w, 0);
    ctx.lineTo(w, s);
    ctx.closePath();
    ctx.fill();
  }
}

function checkerboard(ctx: CanvasRenderingContext2D, w: number, h: number, size: number) {
  for (let y = 0; y < h; y += size) {
    for (let x = 0; x < w; x += size) {
      ctx.fillStyle = (x / size + y / size) % 2 < 1 ? '#ffffff' : '#d0d4da';
      ctx.fillRect(x, y, size, size);
    }
  }
}
