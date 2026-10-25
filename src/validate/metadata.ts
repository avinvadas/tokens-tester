import { entry, toJS } from '../json/cst';
import { makeIssue, quote } from '../model/build';
import type { Issue, Model } from '../model/types';
import { walkNodes } from './walk';

/** Metadata rules: `$description`, `$extensions`, `$deprecated` and `$type` must have the right shape. */
export function metadataRules(model: Model): Issue[] {
  const issues: Issue[] = [];
  for (const v of walkNodes(model.files)) {
    const { file, node, keyPath } = v;
    const name = quote(v.path.join('.'));
    const at = (key: string) => ({ fileId: file.id, target: v.path.join('.'), keyPath: [...keyPath, key], pos: node.entries.find((e) => e.key === key)?.pos });

    const desc = entry(node, '$description')?.value;
    if (desc && desc.kind !== 'string') {
      const text = desc.kind === 'number' || desc.kind === 'boolean' ? String(desc.value) : JSON.stringify(toJS(desc));
      issues.push(
        makeIssue('error', 'metadata', 'invalid-description', `“$description” on ${name} must be a string.`, at('$description'), {
          label: 'Convert to text',
          preview: { before: JSON.stringify(toJS(desc)), after: JSON.stringify(text) },
          edits: [{ fileId: file.id, path: [...keyPath, '$description'], value: text }],
        }),
      );
    }

    const type = entry(node, '$type')?.value;
    if (type && type.kind !== 'string') issues.push(makeIssue('error', 'metadata', 'invalid-type-property', `“$type” on ${name} must be a string.`, at('$type')));

    const dep = entry(node, '$deprecated')?.value;
    if (dep && dep.kind !== 'boolean' && dep.kind !== 'string') {
      issues.push(makeIssue('error', 'metadata', 'invalid-deprecated', `“$deprecated” on ${name} must be true, false, or a text explaining what to use instead.`, at('$deprecated')));
    }

    const ext = entry(node, '$extensions')?.value;
    if (ext && ext.kind !== 'object') {
      issues.push(makeIssue('error', 'metadata', 'invalid-extensions', `“$extensions” on ${name} must be an object.`, at('$extensions')));
    } else if (ext?.kind === 'object') {
      const loose = ext.entries.filter((e) => !e.key.includes('.')).map((e) => e.key);
      if (loose.length) {
        issues.push(
          makeIssue(
            'warning',
            'metadata',
            'extension-naming',
            `“$extensions” on ${name} uses ${loose.map((k) => `“${k}”`).join(', ')}. Extension keys should be reverse domain names, like “com.example.tool”, so tools don't collide.`,
            at('$extensions'),
          ),
        );
      }
    }
  }
  return issues;
}
