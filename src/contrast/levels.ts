/**
 * Contrast compliance targets and the levels each one checks.
 *
 * WCAG 2.2 uses the same contrast formula as 2.1: a ratio from 1 to 21,
 * symmetric in text and background. APCA (the candidate method for WCAG 3)
 * gives a lightness contrast Lc that depends on which color is the text;
 * thresholds follow the APCA "bronze" readability guidance.
 */

export type ContrastTarget = 'wcag-aa' | 'wcag-aaa' | 'apca';
export type Metric = 'wcag' | 'apca';

export interface Level {
  id: string;
  metric: Metric;
  threshold: number;
  /** Full label, e.g. "AA text (4.5)". */
  label: string;
  /** Short name, e.g. "AA large". */
  short: string;
  /** Compact badge for narrow cells, e.g. "AA L". */
  badge: string;
}

export const TARGETS: { id: ContrastTarget; label: string }[] = [
  { id: 'wcag-aa', label: 'WCAG 2.2 AA' },
  { id: 'wcag-aaa', label: 'WCAG 2.2 AAA' },
  { id: 'apca', label: 'APCA' },
];

const LEVELS: Record<ContrastTarget, Level[]> = {
  'wcag-aa': [
    { id: 'aa', metric: 'wcag', threshold: 4.5, label: 'AA text (4.5)', short: 'AA', badge: 'AA' },
    { id: 'aa-large', metric: 'wcag', threshold: 3, label: 'AA large text & UI (3)', short: 'AA large', badge: 'AA L' },
  ],
  'wcag-aaa': [
    { id: 'aaa', metric: 'wcag', threshold: 7, label: 'AAA text (7)', short: 'AAA', badge: 'AAA' },
    { id: 'aaa-large', metric: 'wcag', threshold: 4.5, label: 'AAA large text (4.5)', short: 'AAA large', badge: 'AAA L' },
  ],
  apca: [
    { id: 'lc75', metric: 'apca', threshold: 75, label: 'Lc 75 body text', short: 'Lc 75', badge: 'Lc75' },
    { id: 'lc60', metric: 'apca', threshold: 60, label: 'Lc 60 content text', short: 'Lc 60', badge: 'Lc60' },
    { id: 'lc45', metric: 'apca', threshold: 45, label: 'Lc 45 large text', short: 'Lc 45', badge: 'Lc45' },
    { id: 'lc30', metric: 'apca', threshold: 30, label: 'Lc 30 non-text & placeholder', short: 'Lc 30', badge: 'Lc30' },
  ],
};

/** Levels for the selected targets, strictest first within each metric. */
export function levelsFor(targets: readonly ContrastTarget[]): Level[] {
  const order: ContrastTarget[] = ['wcag-aaa', 'wcag-aa', 'apca'];
  return order.filter((t) => targets.includes(t)).flatMap((t) => LEVELS[t]);
}

export function metricsFor(levels: readonly Level[]): Metric[] {
  return [...new Set(levels.map((l) => l.metric))];
}

/** The strictest level a value passes, among `levels` of its metric. */
export function bestLevel(value: number, metric: Metric, levels: readonly Level[]): Level | undefined {
  return levels.filter((l) => l.metric === metric && value >= l.threshold).sort((a, b) => b.threshold - a.threshold)[0];
}
