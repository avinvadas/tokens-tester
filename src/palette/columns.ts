import type { Palette } from './detect';
import { orderSteps, type OrderKind } from './order';

/**
 * Shared step columns for the palette grid. Palettes on the same step scheme
 * (e.g. 50–950) form one group whose columns are the union of their steps,
 * so every palette in the group lines up and a step it lacks shows as a gap.
 */

export interface StepGroup {
  columns: string[];
  palettes: Palette[];
}

export function stepGroups(palettes: readonly Palette[]): StepGroup[] {
  const groups: { kind: OrderKind; steps: string[]; palettes: Palette[] }[] = [];
  for (const p of palettes) {
    const own = p.swatches.map((s) => s.step);
    const g = groups.find((x) => x.kind === p.order && shared(own, x.steps) >= Math.ceil(Math.min(own.length, x.steps.length) / 2));
    if (g) {
      g.palettes.push(p);
      for (const s of own) if (!g.steps.includes(s)) g.steps.push(s);
    } else {
      groups.push({ kind: p.order, steps: [...own], palettes: [p] });
    }
  }
  // File-ordered steps have no scale to sort by, so they keep first-seen order.
  return groups.map((g) => ({ columns: g.kind === 'file' ? g.steps : orderSteps(g.steps, (s) => s).items, palettes: g.palettes }));
}

const shared = (a: string[], b: string[]) => a.filter((s) => b.includes(s)).length;
