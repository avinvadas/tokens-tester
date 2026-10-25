/** Closest candidate to `target` by edit distance, if it is close enough to be a likely typo. */
export function closest(target: string, candidates: Iterable<string>, limit = 5000): string | undefined {
  const maxDist = Math.max(2, Math.floor(target.length / 4));
  let best: string | undefined;
  let bestDist = maxDist + 1;
  let seen = 0;
  for (const c of candidates) {
    if (++seen > limit) break;
    if (Math.abs(c.length - target.length) >= bestDist) continue;
    const d = levenshtein(target, c, bestDist);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

/** Edit distance, giving up early once every path exceeds `cap`. */
function levenshtein(a: string, b: string, cap: number): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin >= cap) return cap;
    prev = cur;
  }
  return prev[b.length]!;
}
