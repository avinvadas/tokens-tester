import { describe, expect, it } from 'vitest';
import type { Palette } from '../src/palette/detect';
import { stepGroups } from '../src/palette/columns';
import type { OrderKind } from '../src/palette/order';

const pal = (id: string, order: OrderKind, steps: string[]) => ({ id, order, swatches: steps.map((step) => ({ step })) }) as unknown as Palette;
const shape = (ps: Palette[]) => stepGroups(ps).map((g) => ({ columns: g.columns, ids: g.palettes.map((p) => p.id) }));

describe('step groups', () => {
  it('lines up palettes on one scale and leaves gaps for missing steps', () => {
    const groups = shape([pal('blue', 'numeric', ['50', '100', '500', '900']), pal('red', 'numeric', ['100', '300', '500', '900', '950'])]);
    expect(groups).toEqual([{ columns: ['50', '100', '300', '500', '900', '950'], ids: ['blue', 'red'] }]);
  });

  it('keeps unrelated schemes in separate groups', () => {
    const groups = shape([pal('blue', 'numeric', ['100', '200', '300']), pal('gray', 'numeric', ['1', '2', '3', '4']), pal('accent', 'named', ['light', 'base', 'dark'])]);
    expect(groups.map((g) => g.ids)).toEqual([['blue'], ['gray'], ['accent']]);
  });

  it('orders named steps by their scale and appends off-scale names', () => {
    const groups = shape([pal('a', 'named', ['light', 'dark']), pal('b', 'named', ['light', 'base', 'dark', 'muted'])]);
    expect(groups[0]!.columns).toEqual(['light', 'base', 'dark', 'muted']);
  });
});
