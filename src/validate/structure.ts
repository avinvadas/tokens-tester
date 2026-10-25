import { entry, toJS } from '../json/cst';
import { makeIssue, quote } from '../model/build';
import { closest } from '../model/suggest';
import type { Issue, Model } from '../model/types';
import { walkNodes } from './walk';

/**
 * Structure rules: what may appear where. DTCG 2025.10 reserves `$`-prefixed
 * names for properties, forbids `{`, `}` and `.` in names, and does not let a
 * token contain other tokens or groups.
 */

const TOKEN_PROPS = ['$value', '$type', '$description', '$extensions', '$deprecated'];
const GROUP_PROPS = ['$type', '$description', '$extensions', '$deprecated', '$extends', '$root'];
const ROOT_PROPS = [...GROUP_PROPS, '$schema'];
/** Tokens Studio stores these at the root of multi-set files. */
const STUDIO_ROOT = ['$themes', '$metadata'];
/** Legacy property names that map onto a DTCG property. */
const LEGACY_PROPS: Record<string, string> = { value: '$value', type: '$type', description: '$description', comment: '$description' };

const BAD_NAME = /[{}.]/;

export function structureRules(model: Model): Issue[] {
  const issues: Issue[] = [];

  for (const v of walkNodes(model.files)) {
    const { file, node, keyPath, kind } = v;
    const at = (key: string, pos = node.entries.find((e) => e.key === key)?.pos) => ({
      fileId: file.id,
      target: [...v.path, key].join('.'),
      keyPath: [...keyPath, key],
      pos,
    });
    const allowed = kind === 'token' ? TOKEN_PROPS : v.isRoot ? [...ROOT_PROPS, ...STUDIO_ROOT] : GROUP_PROPS;
    const has = (k: string) => !!entry(node, k);
    const children = node.entries.filter((e) => !e.key.startsWith('$'));

    for (const e of node.entries) {
      if (e.key.startsWith('$')) {
        if (allowed.includes(e.key)) continue;
        // A group with no children whose stray property is close to $value is probably a token with a typo.
        const candidates = kind === 'group' && children.length === 0 ? [...allowed, ...TOKEN_PROPS] : allowed;
        const hint = closest(e.key, candidates);
        issues.push(
          makeIssue(
            'warning',
            'structure',
            'unknown-property',
            `${quote(v.path.join('.'))} has an unknown property “${e.key}”.${hint ? ` Did you mean “${hint}”?` : ''}`,
            at(e.key, e.pos),
            hint && !has(hint)
              ? { label: `Rename to “${hint}”`, preview: { before: `"${e.key}"`, after: `"${hint}"` }, edits: [{ fileId: file.id, path: [...keyPath, e.key], rename: hint }] }
              : undefined,
          ),
        );
        continue;
      }

      if (kind === 'token') {
        const target = LEGACY_PROPS[e.key];
        issues.push(
          makeIssue(
            'error',
            'structure',
            'token-has-children',
            target
              ? `Token ${quote(v.path.join('.'))} has a legacy property “${e.key}”; DTCG calls it “${target}”.`
              : `Token ${quote(v.path.join('.'))} contains “${e.key}”. Tokens can't contain other tokens or groups.`,
            at(e.key, e.pos),
            target && !has(target)
              ? { label: `Rename to “${target}”`, preview: { before: `"${e.key}"`, after: `"${target}"` }, edits: [{ fileId: file.id, path: [...keyPath, e.key], rename: target }] }
              : undefined,
          ),
        );
        continue;
      }

      // Group children.
      if (e.value.kind !== 'object' && LEGACY_PROPS[e.key]) {
        const target = LEGACY_PROPS[e.key]!;
        issues.push(
          makeIssue(
            'error',
            'structure',
            'legacy-property',
            `${quote(v.path.join('.'))} uses the legacy property “${e.key}”; DTCG calls it “${target}”.`,
            at(e.key, e.pos),
            !has(target)
              ? { label: `Rename to “${target}”`, preview: { before: `"${e.key}"`, after: `"${target}"` }, edits: [{ fileId: file.id, path: [...keyPath, e.key], rename: target }] }
              : undefined,
          ),
        );
        continue;
      }
      if (BAD_NAME.test(e.key)) {
        const fixed = e.key.replace(/\./g, '-').replace(/[{}]/g, '');
        issues.push(
          makeIssue(
            'error',
            'structure',
            'invalid-name',
            `“${e.key}” in ${quote(v.path.join('.'))} contains “{”, “}” or “.”, which DTCG doesn't allow in names because they break references.`,
            at(e.key, e.pos),
            fixed && !has(fixed)
              ? { label: `Rename to “${fixed}”`, preview: { before: `"${e.key}"`, after: `"${fixed}"` }, edits: [{ fileId: file.id, path: [...keyPath, e.key], rename: fixed }] }
              : undefined,
          ),
        );
      }
    }

    // Only truly empty: a stray property (often a misspelled "$value") means the group isn't junk to delete.
    const onlyGroupProps = node.entries.every((e) => GROUP_PROPS.includes(e.key));
    if (kind === 'group' && !v.isRoot && !v.isSet && children.length === 0 && onlyGroupProps && !has('$root') && !has('$extends')) {
      issues.push(
        makeIssue(
          'info',
          'structure',
          'empty-group',
          `Group ${quote(v.path.join('.'))} is empty.`,
          { fileId: file.id, target: v.path.join('.'), keyPath, pos: v.pos },
          { label: 'Remove the empty group', preview: { before: JSON.stringify(toJS(node)), after: '(removed)' }, edits: [{ fileId: file.id, path: keyPath, delete: true }] },
        ),
      );
    }
  }

  // A name that is a token in one place and a group in another.
  const groupIds = new Set(model.groups.filter((g) => g.id !== '').map((g) => g.id));
  for (const t of model.tokens.values()) {
    if (t.extendedFrom || !groupIds.has(t.id)) continue;
    const g = model.groups.find((x) => x.id === t.id)!;
    const name = (id: string) => model.files.find((f) => f.id === id)?.name ?? 'another file';
    issues.push(
      makeIssue(
        'error',
        'structure',
        'token-group-conflict',
        `${quote(t.id)} is a token in ${name(t.fileId)} but a group in ${name(g.fileId)}. References to it are ambiguous.`,
        { fileId: t.fileId, target: t.id, keyPath: t.keyPath, pos: t.pos },
      ),
    );
  }

  return issues;
}
