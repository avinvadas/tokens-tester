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

export interface Stack extends StepGroup {
  /** Every palette shown in this grid, in file order: the group's own, plus hidden palettes that belong here. */
  members: Palette[];
}

/**
 * Grids for the whole palette list. Columns come from the shown palettes only;
 * a hidden palette keeps its place in the stack, in the grid whose steps it
 * matches, or else after the palette that precedes it in the file. `orphans`
 * are hidden palettes when no palette is shown at all.
 */
export function stacks(all: readonly Palette[]): { stacks: Stack[]; orphans: Palette[] } {
  const groups = stepGroups(all.filter((p) => p.included));
  const home = new Map<Palette, StepGroup>();
  for (const g of groups) for (const p of g.palettes) home.set(p, g);
  const members = new Map(groups.map((g) => [g, [] as Palette[]]));
  const orphans: Palette[] = [];
  let last = groups[0];
  for (const p of all) {
    const own = p.swatches.map((s) => s.step);
    const g =
      home.get(p) ??
      groups.find((x) => x.palettes[0]!.order === p.order && shared(own, x.columns) >= Math.ceil(own.length / 2)) ??
      last;
    if (!g) {
      orphans.push(p);
      continue;
    }
    members.get(g)!.push(p);
    if (home.has(p)) last = g;
  }
  return { stacks: groups.map((g) => ({ ...g, members: members.get(g)! })), orphans };
}
