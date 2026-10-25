/**
 * Interpolation through curve handles. Smooth curves use monotone cubic
 * Hermite interpolation (Fritsch–Carlson / PCHIP): it passes through every
 * handle and never overshoots between them, so a lightness curve that goes
 * down at its handles goes down everywhere.
 */

export interface Point {
  t: number;
  v: number;
}

export function interpolate(points: readonly Point[], smooth: boolean): (t: number) => number {
  const p = [...points].sort((a, b) => a.t - b.t);
  if (p.length === 0) return () => 0;
  if (p.length === 1) return () => p[0]!.v;
  const n = p.length;
  const h = p.slice(1).map((q, k) => q.t - p[k]!.t);
  const d = p.slice(1).map((q, k) => (h[k]! === 0 ? 0 : (q.v - p[k]!.v) / h[k]!));

  const m = new Array<number>(n).fill(0);
  if (smooth) {
    m[0] = d[0]!;
    m[n - 1] = d[n - 2]!;
    for (let k = 1; k < n - 1; k++) {
      const a = d[k - 1]!;
      const b = d[k]!;
      if (a * b <= 0) m[k] = 0;
      else {
        const w1 = 2 * h[k]! + h[k - 1]!;
        const w2 = h[k]! + 2 * h[k - 1]!;
        m[k] = (w1 + w2) / (w1 / a + w2 / b);
      }
    }
  }

  return (t: number) => {
    if (t <= p[0]!.t) return p[0]!.v;
    if (t >= p[n - 1]!.t) return p[n - 1]!.v;
    let k = 0;
    while (k < n - 2 && t > p[k + 1]!.t) k++;
    const hk = h[k]!;
    if (hk === 0) return p[k]!.v;
    const s = (t - p[k]!.t) / hk;
    if (!smooth) return p[k]!.v + s * (p[k + 1]!.v - p[k]!.v);
    const s2 = s * s;
    const s3 = s2 * s;
    return (
      (2 * s3 - 3 * s2 + 1) * p[k]!.v + (s3 - 2 * s2 + s) * hk * m[k]! + (-2 * s3 + 3 * s2) * p[k + 1]!.v + (s3 - s2) * hk * m[k + 1]!
    );
  };
}
