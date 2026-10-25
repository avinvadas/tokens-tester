import { buildModel, makeIssue } from '../model/build';
import type { Issue, Model, Settings, SourceFile } from '../model/types';
import { metadataRules } from './metadata';
import { referenceRules } from './references';
import { structureRules } from './structure';
import { typeAndValueRules } from './values';

const key = (i: Issue) => `${i.fileId}\u0000${(i.keyPath ?? []).join('\u0000')}`;

/** Build the model and run every rule. The result's `issues` holds model and rule findings together. */
export function analyze(files: SourceFile[], settings: Settings): Model {
  const model = buildModel(files, settings);
  const ruleIssues = [...structureRules(model), ...typeAndValueRules(model), ...referenceRules(model), ...metadataRules(model)];

  // A legacy property in a group (`"value": "#fff"`) is reported, with a fix,
  // by the structure rules; drop the model's generic "not a token or group" for it.
  const legacy = new Set(ruleIssues.filter((i) => i.code === 'legacy-property').map(key));
  const modelIssues = model.issues.filter((i) => !(i.code === 'invalid-node' && legacy.has(key(i))));
  // A conversion note already explains an expression the converter couldn't translate.
  const noted = new Set(modelIssues.filter((i) => i.code === 'legacy-conversion').map(key));
  const rules = ruleIssues.filter((i) => !(i.code === 'embedded-reference' && noted.has(key(i))));

  const withTokens = new Set([...model.tokens.values()].map((t) => t.fileId));
  for (const f of files) {
    if (!withTokens.has(f.id) && f.doc.root.kind === 'object' && !(f.format === 'legacy' && !f.converted)) {
      modelIssues.push(makeIssue('info', 'format', 'no-tokens', `${f.name} contains no tokens (no “$value” anywhere).`, { fileId: f.id }));
    }
  }
  model.issues = [...modelIssues, ...rules];
  return model;
}
