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
