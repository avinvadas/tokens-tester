import type { JNode } from '../json/cst';
import type { FileFormat } from './types';

/**
 * Tell DTCG files (`$value`) apart from legacy ones (Tokens Studio,
 * Style Dictionary v3: `value` / `type` without the `$`).
 */
export function detectFormat(root: JNode): FileFormat {
  let dtcg = false;
  let legacy = false;
  const visit = (n: JNode): void => {
    if (dtcg) return;
    if (n.kind === 'array') {
      for (const it of n.items) visit(it.value);
      return;
    }
    if (n.kind !== 'object') return;
    for (const e of n.entries) {
      if (e.key === '$value') {
        dtcg = true;
        return;
      }
      if (e.key === 'value' && e.value.kind !== 'object') legacy = true;
      visit(e.value);
    }
  };
  visit(root);
  return dtcg ? 'dtcg' : legacy ? 'legacy' : 'unknown';
}

/** Tokens Studio project files (`$themes.json`, `$metadata.json`) that hold metadata rather than tokens. */
export const isStudioMetaFile = (f: { name: string }) => /(^|\/)\$(themes|metadata)\.json$/.test(f.name);
