import { entry, toJS, type JNode, type JObject, type Pos } from '../json/cst';
import { DEFAULT_SETTINGS } from './defaults';
import { closest } from './suggest';
import { isStudioMetaFile } from './format';
import { modeValues } from './modes';
import type { Category, Fix, Group, Issue, Model, Settings, Severity, SourceFile, ThemeScope, Token } from './types';

/**
 * Build the token model from loaded files: collect tokens and groups,
 * apply `$extends`, then resolve every `{alias}` and `$ref` pointer.
 *
 * Files share one namespace, so a semantic file can reference tokens in a
 * primitives file. Tokens Studio "sets" inside one file share it too: a token's
 * `path` (its alias name) omits the set, while `keyPath` (its location in the
 * file) includes it. Per-theme namespaces arrive with themes.
 */

const ALIAS_RE = /^\{([^{}]+)\}$/;

/** The referenced token id if `v` is a whole-value `{alias}`. */
export function parseAlias(v: unknown): string | undefined {
  return typeof v === 'string' ? ALIAS_RE.exec(v)?.[1] : undefined;
}

/** Replace every `{from}` reference inside a value with `{to}`. */
export function replaceRef(v: unknown, from: string, to: string): unknown {
  if (typeof v === 'string') return v.split(`{${from}}`).join(`{${to}}`);
  if (Array.isArray(v)) return v.map((x) => replaceRef(x, from, to));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = replaceRef(x, from, to);
    return out;
  }
  return v;
}

const keyOf = (fileId: string, keyPath: string[]) => `${fileId}\u0000${keyPath.join('\u0000')}`;
export const quote = (id: string) => `“${id || '(root)'}”`;

/**
 * Token set names when the file is a Tokens Studio multi-set file
 * (`$metadata.tokenSetOrder` or `$themes` present), in set order.
 */
export function tokenSets(root: JNode): string[] | undefined {
  if (root.kind !== 'object') return undefined;
  const meta = entry(root, '$metadata')?.value;
  const order = entry(meta, 'tokenSetOrder')?.value;
  if (!order && !entry(root, '$themes')) return undefined;
  const present = root.entries.filter((e) => !e.key.startsWith('$') && e.value.kind === 'object').map((e) => e.key);
  const ordered = order?.kind === 'array' ? order.items.map((i) => (i.value.kind === 'string' ? i.value.value : '')).filter((k) => present.includes(k)) : [];
  return [...new Set([...ordered, ...present])];
}

interface Ctx {
  model: Model;
  scope: ThemeScope;
  order: number;
  byKeyPath: Map<string, Token>;
  groupIds: Set<string>;
}

export function makeIssue(
  severity: Severity,
  category: Category,
  code: string,
  message: string,
  at: { fileId?: string; target?: string; keyPath?: string[]; pos?: Pos | undefined } = {},
  fix?: Fix,
): Issue {
  const issue: Issue = { severity, category, code, message };
  if (at.fileId !== undefined) issue.fileId = at.fileId;
  if (at.target !== undefined) issue.target = at.target;
  if (at.keyPath !== undefined) issue.keyPath = at.keyPath;
  if (at.pos) issue.pos = at.pos;
  if (fix) issue.fix = fix;
  return issue;
}

export function buildModel(files: SourceFile[], settings: Settings = DEFAULT_SETTINGS, scope: ThemeScope = {}): Model {
  const model: Model = { files, settings, tokens: new Map(), groups: [], issues: [] };
  const ctx: Ctx = { model, scope, order: 0, byKeyPath: new Map(), groupIds: new Set() };

  for (const f of files) {
    if (isStudioMetaFile(f)) continue;
    for (const d of f.duplicates) {
      const where = d.path.length ? quote(d.path.join('.')) : 'the root object';
      model.issues.push(
        makeIssue('warning', 'structure', 'duplicate-key', `“${d.key}” appears more than once in ${where}. Only the last one is used.`, {
          fileId: f.id,
          target: [...d.path, d.key].join('.'),
          pos: d.pos,
        }),
      );
    }
    if (f.doc.root.kind !== 'object') {
      model.issues.push(
        makeIssue('error', 'structure', 'root-not-object', `${f.name} must contain a JSON object at the top level, not a ${f.doc.root.kind}.`, {
          fileId: f.id,
          pos: f.doc.root.pos,
        }),
      );
      continue;
    }
    if (f.format === 'legacy' && !f.converted) {
      const kind = f.legacyKind === 'tokens-studio' ? 'Tokens Studio' : f.legacyKind === 'style-dictionary' ? 'Style Dictionary' : 'legacy';
      model.issues.push(
        makeIssue(
          'error',
          'format',
          'legacy-format',
          `${f.name} uses the ${kind} format (“value” / “type” without “$”). Turn on legacy support to convert it to DTCG.`,
          { fileId: f.id },
          { label: 'Turn on legacy support', setting: { acceptLegacy: true } },
        ),
      );
      continue;
    }
    for (const note of f.conversionNotes ?? []) {
      model.issues.push(makeIssue('warning', 'format', 'legacy-conversion', note.message, { fileId: f.id, target: note.keyPath.join('.'), keyPath: note.keyPath }));
    }
    const sets = tokenSets(f.doc.root);
    if (sets) {
      const enabled = scope.sets?.[f.id];
      for (const set of sets) {
        if (enabled && !enabled.includes(set)) continue;
        const e = entry(f.doc.root, set)!;
        walkGroup(ctx, f, e.value as JObject, [], [set], undefined, e.pos);
      }
      walkRootProps(ctx, f, f.doc.root);
    } else {
      walkGroup(ctx, f, f.doc.root, [], [], undefined, undefined);
    }
  }

  applyExtends(ctx);
  resolveAll(ctx);
  return model;
}

// ---------------------------------------------------------------------------
// Collection

const str = (n: JNode | undefined) => (n?.kind === 'string' ? n.value : undefined);
const obj = (n: JNode | undefined) => (n?.kind === 'object' ? (toJS(n) as Record<string, unknown>) : undefined);
const deprecation = (n: JNode | undefined) => (n?.kind === 'boolean' || n?.kind === 'string' ? n.value : undefined);

/** In a multi-set file, the root itself is only metadata; register it as a group so rules can check its properties. */
function walkRootProps(ctx: Ctx, f: SourceFile, root: JObject) {
  const g: Group = { id: '', path: [], fileId: f.id, keyPath: [] };
  const description = str(entry(root, '$description')?.value);
  if (description !== undefined) g.description = description;
  ctx.model.groups.push(g);
}

function walkGroup(ctx: Ctx, f: SourceFile, node: JObject, path: string[], keyPath: string[], inheritedType: string | undefined, pos: Pos | undefined) {
  const ownType = str(entry(node, '$type')?.value);
  const type = ownType ?? inheritedType;
  const id = path.join('.');
  const group: Group = { id, path, fileId: f.id, keyPath };
  if (ownType !== undefined) group.type = ownType;
  const description = str(entry(node, '$description')?.value);
  if (description !== undefined) group.description = description;
  const extensions = obj(entry(node, '$extensions')?.value);
  if (extensions) group.extensions = extensions;
  const deprecated = deprecation(entry(node, '$deprecated')?.value);
  if (deprecated !== undefined) group.deprecated = deprecated;
  const ext = str(entry(node, '$extends')?.value);
  if (ext !== undefined) group.extends = ext;
  if (pos) group.pos = pos;
  ctx.model.groups.push(group);
  ctx.groupIds.add(id);

  for (const e of node.entries) {
    const childPath = [...path, e.key];
    const childKeyPath = [...keyPath, e.key];
    if (e.key === '$root') {
      if (e.value.kind === 'object' && entry(e.value, '$value')) addToken(ctx, f, e.value, childPath, childKeyPath, type, e.pos);
      else invalidNode(ctx, f, childPath, childKeyPath, e.pos, '“$root” must be a token object with a “$value”.');
      continue;
    }
    if (e.key.startsWith('$')) continue;
    if (e.value.kind !== 'object') {
      invalidNode(ctx, f, childPath, childKeyPath, e.pos, `${quote(childPath.join('.'))} is neither a token nor a group: expected an object, found a ${e.value.kind}.`);
      continue;
    }
    if (entry(e.value, '$value')) addToken(ctx, f, e.value, childPath, childKeyPath, type, e.pos);
    else walkGroup(ctx, f, e.value, childPath, childKeyPath, type, e.pos);
  }
}

function invalidNode(ctx: Ctx, f: SourceFile, path: string[], keyPath: string[], pos: Pos | undefined, message: string) {
  ctx.model.issues.push(makeIssue('error', 'structure', 'invalid-node', message, { fileId: f.id, target: path.join('.'), keyPath, pos }));
}

function addToken(ctx: Ctx, f: SourceFile, node: JObject, path: string[], keyPath: string[], inheritedType: string | undefined, pos: Pos | undefined) {
  const id = path.join('.');
  let rawValue = toJS(entry(node, '$value')!.value);
  let valuePath = ['$value'];
  if (ctx.scope.mode !== undefined) {
    const modes = modeValues(obj(entry(node, '$extensions')?.value));
    if (modes && Object.prototype.hasOwnProperty.call(modes.values, ctx.scope.mode)) {
      rawValue = modes.values[ctx.scope.mode];
      valuePath = [...modes.path, ctx.scope.mode];
    }
  }
  const t: Token = { id, path, fileId: f.id, keyPath, rawValue, valuePath, refs: [], resolution: 'ok', order: ctx.order++ };
  const declaredType = str(entry(node, '$type')?.value);
  if (declaredType !== undefined) t.declaredType = declaredType;
  if (inheritedType !== undefined) t.inheritedType = inheritedType;
  const description = str(entry(node, '$description')?.value);
  if (description !== undefined) t.description = description;
  const extensions = obj(entry(node, '$extensions')?.value);
  if (extensions) t.extensions = extensions;
  const deprecated = deprecation(entry(node, '$deprecated')?.value);
  if (deprecated !== undefined) t.deprecated = deprecated;
  const alias = parseAlias(rawValue);
  if (alias !== undefined) t.aliasOf = alias;
  if (pos) t.pos = pos;

  const prev = ctx.model.tokens.get(id);
  const sameKey = prev && prev.fileId === f.id && prev.keyPath.join('\u0000') === keyPath.join('\u0000');
  if (prev && !prev.extendedFrom && !sameKey) {
    const where = (x: { fileId: string; keyPath: string[]; path: string[] }) => {
      const name = ctx.model.files.find((file) => file.id === x.fileId)?.name ?? 'another file';
      const set = x.keyPath.length > x.path.length ? x.keyPath[0] : undefined;
      return set ? `set “${set}” of ${name}` : name;
    };
    ctx.model.issues.push(
      makeIssue('warning', 'structure', 'duplicate-path', `${quote(id)} is defined in both ${where(prev)} and ${where(t)}. The definition in ${where(t)} is used.`, {
        fileId: f.id,
        target: id,
        keyPath,
        pos,
      }),
    );
  }
  ctx.model.tokens.set(id, t);
  ctx.byKeyPath.set(keyOf(f.id, keyPath), t);
}

// ---------------------------------------------------------------------------
// $extends

function applyExtends(ctx: Ctx) {
  const { model } = ctx;
  const byId = new Map<string, Group[]>();
  for (const g of model.groups) byId.set(g.id, [...(byId.get(g.id) ?? []), g]);
  const done = new Set<Group>();
  const active = new Set<Group>();

  const report = (g: Group, code: string, message: string) => {
    model.issues.push(makeIssue('error', 'references', code, message, { fileId: g.fileId, target: g.id, keyPath: g.keyPath, pos: g.pos }));
  };

  const run = (g: Group) => {
    if (done.has(g)) return;
    if (active.has(g)) {
      report(g, 'circular-extends', `${quote(g.id)} extends itself through a chain of “$extends”.`);
      return;
    }
    active.add(g);
    const target = parseAlias(g.extends);
    if (target === undefined) {
      report(g, 'invalid-extends', `“$extends” on ${quote(g.id)} must be a reference like "{group.name}".`);
    } else if (!byId.has(target)) {
      if (model.tokens.has(target)) {
        report(g, 'extends-token', `“$extends” on ${quote(g.id)} references the token ${quote(target)}; it must reference a group.`);
      } else {
        const hint = closest(target, byId.keys());
        report(g, 'unresolved-extends', `“$extends” on ${quote(g.id)} references ${quote(target)}, which doesn't exist.${hint ? ` Did you mean ${quote(hint)}?` : ''}`);
      }
    } else {
      for (const tg of byId.get(target)!) if (tg.extends !== undefined) run(tg);
      const depth = target === '' ? 0 : target.split('.').length;
      const prefix = target === '' ? '' : `${target}.`;
      const sources = [...model.tokens.values()].filter((t) => t.id.startsWith(prefix));
      for (const s of sources) {
        const path = [...g.path, ...s.path.slice(depth)];
        const id = path.join('.');
        if (model.tokens.has(id)) continue;
        model.tokens.set(id, { ...s, id, path, refs: [], extendedFrom: s.extendedFrom ?? s.id, order: ctx.order++ });
      }
    }
    active.delete(g);
    done.add(g);
  };

  for (const g of model.groups) if (g.extends !== undefined) run(g);
}

// ---------------------------------------------------------------------------
// Resolution

interface Status {
  broken: boolean;
}

function resolveAll(ctx: Ctx) {
  const { model } = ctx;
  const stack: string[] = [];
  const resolved = new Set<string>();
  const cycles = new Set<string>();

  // Tokens copied by $extends repeat their source's problems; report only the source.
  const report = (owner: Token, code: string, message: string, fix?: Fix) => {
    if (owner.extendedFrom) return;
    model.issues.push(makeIssue('error', 'references', code, message, { fileId: owner.fileId, target: owner.id, keyPath: owner.keyPath, pos: owner.pos }, fix));
  };

  const resolveToken = (id: string): Token | undefined => {
    const t = model.tokens.get(id)!;
    if (resolved.has(id)) return t;
    const at = stack.indexOf(id);
    if (at !== -1) {
      const cycle = [...stack.slice(at), id];
      const key = [...new Set(cycle)].sort().join('\u0000');
      if (!cycles.has(key)) {
        cycles.add(key);
        report(t, 'circular-reference', `Circular reference: ${cycle.map((c) => `{${c}}`).join(' → ')}.`);
      }
      return undefined;
    }
    stack.push(id);
    const st: Status = { broken: false };
    t.refs = [];
    const value = resolveValue(t, t.rawValue, st, true);
    stack.pop();
    if (st.broken) {
      t.resolution = 'broken';
      delete t.value;
    } else {
      t.resolution = 'ok';
      t.value = value;
    }
    const target = t.aliasOf ? model.tokens.get(t.aliasOf) : undefined;
    const type = t.declaredType ?? t.inheritedType ?? target?.type;
    if (type !== undefined) t.type = type;
    const own = t.declaredType ?? t.inheritedType;
    if (own && target?.type && own !== target.type && t.resolution === 'ok' && !t.extendedFrom) {
      // Removing the token's own $type helps only if what remains (group type or the reference's type) matches.
      const canFix = t.declaredType !== undefined && (t.inheritedType === undefined || t.inheritedType === target.type);
      const fix: Fix | undefined = canFix
        ? {
            label: `Remove “$type” so it follows ${quote(target.id)}`,
            preview: { before: `"$type": "${t.declaredType}"`, after: `type "${target.type}"` },
            edits: [{ fileId: t.fileId, path: [...t.keyPath, '$type'], delete: true }],
          }
        : undefined;
      model.issues.push(
        makeIssue(
          'warning',
          'types',
          'alias-type-mismatch',
          `${quote(t.id)} has type “${own}” but references ${quote(target.id)} of type “${target.type}”.`,
          { fileId: t.fileId, target: t.id, keyPath: t.keyPath, pos: t.pos },
          fix,
        ),
      );
    }
    resolved.add(id);
    return t;
  };

  const refToken = (owner: Token, targetId: string, st: Status): unknown => {
    owner.refs.push(targetId);
    if (!model.tokens.has(targetId)) {
      st.broken = true;
      if (ctx.groupIds.has(targetId)) {
        const root = model.tokens.has(`${targetId}.$root`) ? `${targetId}.$root` : undefined;
        report(
          owner,
          'reference-to-group',
          `${quote(owner.id)} references {${targetId}}, which is a group, not a token.${root ? ` Did you mean its root token {${root}}?` : ''}`,
          root ? refFix(owner, targetId, root) : undefined,
        );
      } else {
        const hint = closest(targetId, model.tokens.keys());
        report(
          owner,
          'unresolved-reference',
          `${quote(owner.id)} references {${targetId}}, which doesn't exist.${hint ? ` Did you mean {${hint}}?` : ''}`,
          hint ? refFix(owner, targetId, hint) : undefined,
        );
      }
      return undefined;
    }
    const r = resolveToken(targetId);
    if (!r || r.resolution === 'broken') {
      st.broken = true;
      return undefined;
    }
    return r.value;
  };

  const refFix = (owner: Token, from: string, to: string): Fix => ({
    label: `Use {${to}}`,
    preview: { before: `{${from}}`, after: `{${to}}` },
    edits: [{ fileId: owner.fileId, path: [...owner.keyPath, ...owner.valuePath], value: replaceRef(owner.rawValue, from, to) }],
  });

  const resolvePointer = (owner: Token, ref: string, st: Status, whole: boolean): unknown => {
    const fail = (code: string, message: string) => {
      st.broken = true;
      report(owner, code, message);
      return undefined;
    };
    const hash = ref.indexOf('#');
    if (hash === -1) return fail('invalid-ref', `“$ref” in ${quote(owner.id)} must be a JSON Pointer such as "#/color/blue/$value".`);
    const fileName = ref.slice(0, hash);
    const file = fileName
      ? model.files.find((f) => f.name === fileName || f.name.endsWith(`/${fileName}`))
      : model.files.find((f) => f.id === owner.fileId);
    if (!file) return fail('unresolved-ref', `“$ref” in ${quote(owner.id)} points into “${fileName}”, which isn't loaded.`);
    const frag = ref.slice(hash + 1);
    if (frag !== '' && !frag.startsWith('/')) return fail('invalid-ref', `“$ref” in ${quote(owner.id)} must start with "#/".`);
    let segs: string[];
    try {
      segs = frag === '' ? [] : frag.slice(1).split('/').map((s) => decodeURIComponent(s).replace(/~1/g, '/').replace(/~0/g, '~'));
    } catch {
      return fail('invalid-ref', `“$ref” in ${quote(owner.id)} is not a valid JSON Pointer.`);
    }
    const missing = () => fail('unresolved-ref', `“$ref” in ${quote(owner.id)} points to "${ref}", which doesn't exist.`);

    for (let k = segs.length; k >= 1; k--) {
      const tok = ctx.byKeyPath.get(keyOf(file.id, segs.slice(0, k)));
      if (!tok) continue;
      const rest = segs.slice(k);
      if (rest.length > 0 && rest[0] !== '$value') break;
      owner.refs.push(tok.id);
      if (whole && rest.length <= 1) owner.aliasOf = tok.id;
      const r = resolveToken(tok.id);
      if (!r || r.resolution === 'broken') {
        st.broken = true;
        return undefined;
      }
      const v = indexValue(r.value, rest.slice(1));
      return v === undefined ? missing() : v;
    }
    const node = pointerGet(file.doc.root, segs);
    if (!node) return missing();
    return resolveValue(owner, toJS(node), st, false);
  };

  const resolveValue = (owner: Token, v: unknown, st: Status, whole: boolean): unknown => {
    const alias = parseAlias(v);
    if (alias !== undefined) return refToken(owner, alias, st);
    if (Array.isArray(v)) return v.map((x) => resolveValue(owner, x, st, false));
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o);
      if (keys.length === 1 && keys[0] === '$ref' && typeof o.$ref === 'string') return resolvePointer(owner, o.$ref, st, whole);
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        Object.defineProperty(out, k, { value: resolveValue(owner, o[k], st, false), enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
    return v;
  };

  for (const id of model.tokens.keys()) resolveToken(id);
}

function pointerGet(root: JNode, segs: string[]): JNode | undefined {
  let cur: JNode | undefined = root;
  for (const s of segs) {
    if (!cur) return undefined;
    if (cur.kind === 'array') cur = /^\d+$/.test(s) ? cur.items[Number(s)]?.value : undefined;
    else cur = entry(cur, s)?.value;
  }
  return cur;
}

function indexValue(v: unknown, segs: string[]): unknown {
  let cur = v;
  for (const s of segs) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (Array.isArray(cur)) cur = /^\d+$/.test(s) ? cur[Number(s)] : undefined;
    else cur = Object.prototype.hasOwnProperty.call(cur, s) ? (cur as Record<string, unknown>)[s] : undefined;
  }
  return cur;
}
