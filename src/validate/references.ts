import { makeIssue, parseAlias, quote } from '../model/build';
import type { Issue, Model } from '../model/types';

/**
 * Reference rules beyond resolution (which the model reports): references
 * embedded in longer strings, and references to deprecated tokens.
 */
export function referenceRules(model: Model): Issue[] {
  const issues: Issue[] = [];
  for (const t of model.tokens.values()) {
    if (t.extendedFrom) continue;
    const at = { fileId: t.fileId, target: t.id, keyPath: t.keyPath, pos: t.pos };

    const embedded = findEmbedded(t.rawValue);
    if (embedded) {
      issues.push(
        makeIssue(
          'warning',
          'references',
          'embedded-reference',
          `${quote(t.id)} has a reference inside a longer text (“${embedded}”). DTCG references must be the whole value, so tools won't resolve it.`,
          at,
        ),
      );
    }

    for (const ref of new Set(t.refs)) {
      const target = model.tokens.get(ref);
      if (!target?.deprecated) continue;
      const why = typeof target.deprecated === 'string' ? ` (${target.deprecated})` : '';
      issues.push(makeIssue('info', 'references', 'deprecated-reference', `${quote(t.id)} references ${quote(ref)}, which is deprecated${why}.`, at));
    }
  }
  return issues;
}

/** The first string in a value that embeds a reference inside other text. */
export function findEmbedded(v: unknown): string | undefined {
  if (typeof v === 'string') return v.includes('{') && parseAlias(v) === undefined && /\{[^{}]+\}/.test(v) ? v : undefined;
  if (Array.isArray(v)) {
    for (const x of v) {
      const found = findEmbedded(x);
      if (found) return found;
    }
    return undefined;
  }
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) {
      const found = findEmbedded(x);
      if (found) return found;
    }
  }
  return undefined;
}
