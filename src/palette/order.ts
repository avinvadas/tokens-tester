/**
 * Ordering a palette's steps. Numeric names sort numerically ("50" < "100" <
 * "950", "100A" after "100"); known word scales use their usual order;
 * anything else keeps file order and is reported as unordered.
 */

export type OrderKind = 'numeric' | 'named' | 'file';

const NAMED_SCALES: string[][] = [
  ['lightest', 'lighter', 'light', 'base', 'default', 'dark', 'darker', 'darkest'],
  ['subtlest', 'subtler', 'subtle', 'base', 'default', 'bold', 'bolder', 'boldest'],
  ['weakest', 'weaker', 'weak', 'base', 'default', 'strong', 'stronger', 'strongest'],
  ['4xs', '3xs', '2xs', 'xxs', 'xs', 'sm', 's', 'md', 'm', 'base', 'default', 'lg', 'l', 'xl', 'xxl', '2xl', '3xl', '4xl'],
];

const NUMERIC = /^(\d+(?:\.\d+)?)([a-z]*)$/i;

export interface Ordered<T> {
  items: T[];
  kind: OrderKind;
  /** Steps that could not be placed by name and were appended in file order. */
  unplaced: T[];
}

export function orderSteps<T>(items: T[], name: (t: T) => string): Ordered<T> {
  const numeric = items.filter((t) => NUMERIC.test(name(t)));
  if (numeric.length >= Math.max(2, items.length / 2)) {
    const key = (t: T) => {
      const m = NUMERIC.exec(name(t))!;
      return [Number(m[1]), m[2]!.toLowerCase()] as const;
    };
    const sorted = [...numeric].sort((a, b) => {
      const [na, sa] = key(a);
      const [nb, sb] = key(b);
      return na - nb || sa.localeCompare(sb);
    });
    const unplaced = items.filter((t) => !NUMERIC.test(name(t)));
    return { items: [...sorted, ...unplaced], kind: 'numeric', unplaced };
  }
  const lower = (t: T) => name(t).toLowerCase();
  const scale = NAMED_SCALES.map((s) => ({ s, hits: items.filter((t) => s.includes(lower(t))).length })).sort((a, b) => b.hits - a.hits)[0]!;
  if (scale.hits >= Math.max(2, items.length / 2)) {
    const placed = items.filter((t) => scale.s.includes(lower(t))).sort((a, b) => scale.s.indexOf(lower(a)) - scale.s.indexOf(lower(b)));
    const unplaced = items.filter((t) => !scale.s.includes(lower(t)));
    return { items: [...placed, ...unplaced], kind: 'named', unplaced };
  }
  return { items: [...items], kind: 'file', unplaced: [] };
}
