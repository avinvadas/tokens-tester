import { entry, isInline, reshape, setChild, toJS, type JDoc, type JEntry, type JNode, type JObject, type JStyle } from '../json/cst';
import type { ConversionNote, LegacyKind } from '../model/types';
import { DTCG_TYPES, LEGACY_EXT, LEGACY_TO_DTCG, TOKENS_STUDIO_TYPES } from './types';
import { addValueSuffix, convertLegacyValue, looksLikeHex, toLegacyValue } from './values';

/**
 * Converting whole legacy documents (Tokens Studio, Style Dictionary v3) to
 * DTCG and back. Both directions edit the concrete syntax tree in place:
 * keys are renamed where they stand and values are rewritten with the
 * surrounding formatting, so the converted file still looks like the original.
 */

const DTCG = new Set<string>(DTCG_TYPES);

/** A legacy token: an object with `value` and no `$value`, whose `value` isn't a group of tokens. */
export function isLegacyToken(n: JNode): boolean {
  if (n.kind !== 'object' || entry(n, '$value')) return false;
  const v = entry(n, 'value')?.value;
  if (!v) return false;
  if (v.kind === 'object') return !v.entries.some((e) => e.value.kind === 'object' && entry(e.value, 'value'));
  return true;
}

export function detectLegacyKind(root: JNode): LegacyKind {
  if (root.kind === 'object' && (entry(root, '$themes') || entry(root, '$metadata'))) return 'tokens-studio';
  let studio = false;
  const visit = (n: JNode) => {
    if (studio || n.kind !== 'object') return;
    if (isLegacyToken(n)) {
      const t = entry(n, 'type')?.value;
      if (t?.kind === 'string' && TOKENS_STUDIO_TYPES.has(t.value)) studio = true;
      return;
    }
    for (const e of n.entries) visit(e.value);
  };
  visit(root);
  return studio ? 'tokens-studio' : 'style-dictionary';
}

function rename(e: JEntry, key: string): JEntry {
  const { rawKey: _raw, ...rest } = e;
  return { ...rest, key };
}

/** After dropping or adding entries, restore the original separator whitespace pattern. */
function withEntries(original: JObject, entries: JEntry[]): JObject {
  const src = original.entries;
  if (entries.length === 0) return { ...original, entries, inner: '' };
  const firstBefore = src[0]!.before;
  const midBefore = (src[1] ?? src[0]!).before;
  const midAfter = src.length > 1 ? src[0]!.after : '';
  const lastAfter = src[src.length - 1]!.after;
  return {
    ...original,
    entries: entries.map((e, i) => ({
      ...e,
      before: i === 0 ? firstBefore : midBefore,
      after: i === entries.length - 1 ? lastAfter : midAfter,
    })),
  };
}

function mergeExtension(obj: JObject, data: Record<string, unknown>, depth: number, style: JStyle): JObject {
  const current = entry(obj, '$extensions')?.value;
  const ext = current?.kind === 'object' ? (toJS(current) as Record<string, unknown>) : {};
  return setChild(obj, '$extensions', { ...ext, [LEGACY_EXT]: data }, depth, style);
}

// ---------------------------------------------------------------------------
// Legacy → DTCG

export function legacyToDtcg(doc: JDoc): { doc: JDoc; notes: ConversionNote[] } {
  const notes: ConversionNote[] = [];
  const style = doc.style;

  const token = (node: JObject, keyPath: string[], depth: number): JObject => {
    const legacyType = entry(node, 'type')?.value;
    const typeName = legacyType?.kind === 'string' ? legacyType.value : undefined;
    const rawValue = toJS(entry(node, 'value')!.value);
    let dtcgType = typeName !== undefined ? LEGACY_TO_DTCG[typeName] : undefined;
    // Untyped Style Dictionary colors are unambiguous; type them so they convert.
    if (typeName === undefined && looksLikeHex(rawValue)) dtcgType = 'color';
    const note = (message: string) => notes.push({ keyPath, message: `${keyPath.join('.')}: ${message}` });
    const extras: Record<string, unknown> = {};
    if (typeName !== undefined && dtcgType !== typeName) extras.type = typeName;
    const hasDescription = !!entry(node, 'description');
    const inline = isInline(node);
    let typeWritten = false;

    const out: JEntry[] = [];
    for (const e of node.entries) {
      switch (e.key) {
        case 'value':
          out.push({ ...rename(e, '$value'), value: reshape(e.value, convertLegacyValue(dtcgType ?? typeName, rawValue, note), depth + 1, style, inline) });
          break;
        case 'type':
          out.push({ ...rename(e, '$type'), value: reshape(e.value, dtcgType ?? typeName, depth + 1, style) });
          typeWritten = true;
          break;
        case 'description':
          out.push(rename(e, '$description'));
          break;
        case 'comment':
          if (hasDescription) extras.comment = toJS(e.value);
          else out.push(rename(e, '$description'));
          break;
        default:
          if (e.key.startsWith('$')) out.push(e);
          else extras[e.key] = toJS(e.value);
      }
    }
    let obj = withEntries(node, out);
    if (!typeWritten && dtcgType) obj = setChild(obj, '$type', dtcgType, depth, style);
    if (Object.keys(extras).length) obj = mergeExtension(obj, extras, depth, style);
    return obj;
  };

  const group = (node: JObject, keyPath: string[], depth: number): JObject => ({
    ...node,
    entries: node.entries.map((e) => {
      if (e.key.startsWith('$')) return e;
      if (e.key === 'description' && e.value.kind === 'string') return rename(e, '$description');
      if (e.key === 'type' && e.value.kind === 'string' && LEGACY_TO_DTCG[e.value.value]) {
        return { ...rename(e, '$type'), value: reshape(e.value, LEGACY_TO_DTCG[e.value.value], depth + 1, style) };
      }
      if (e.value.kind !== 'object') return e;
      const path = [...keyPath, e.key];
      return { ...e, value: isLegacyToken(e.value) ? token(e.value, path, depth + 1) : group(e.value, path, depth + 1) };
    }),
  });

  if (doc.root.kind !== 'object') return { doc, notes };
  return { doc: { ...doc, root: group(doc.root, [], 0) }, notes };
}

// ---------------------------------------------------------------------------
// DTCG → legacy

/**
 * Write a DTCG document back in a legacy format. Group `$type`s are pushed
 * down onto tokens (legacy formats have no inheritance), original legacy
 * types and extra properties are restored from the conversion extension.
 */
export function dtcgToLegacy(doc: JDoc, kind: LegacyKind): { doc: JDoc; notes: string[] } {
  const notes: string[] = [];
  const style = doc.style;
  const descKey = kind === 'style-dictionary' ? 'comment' : 'description';

  const token = (node: JObject, keyPath: string[], depth: number, inherited: string | undefined): JObject => {
    const ownType = entry(node, '$type')?.value;
    const dtcgType = ownType?.kind === 'string' ? ownType.value : inherited;
    const extNode = entry(node, '$extensions')?.value;
    const ext = extNode?.kind === 'object' ? (toJS(extNode) as Record<string, unknown>) : undefined;
    const legacy = (ext?.[LEGACY_EXT] ?? {}) as Record<string, unknown>;
    const legacyType = typeof legacy.type === 'string' ? legacy.type : dtcgType;
    const value = toJS(entry(node, '$value')!.value);
    if (value && typeof value === 'object' && '$ref' in value) notes.push(`${keyPath.join('.')}: “$ref” pointers have no legacy equivalent and were kept as is.`);
    const inline = isInline(node);

    const out: JEntry[] = [];
    for (const e of node.entries) {
      if (e.key === '$value') {
        const legacyValue = toLegacyValue(dtcgType, value);
        const written = kind === 'style-dictionary' ? addValueSuffix(legacyValue) : legacyValue;
        out.push({ ...rename(e, 'value'), value: reshape(e.value, written, depth + 1, style, inline) });
      } else if (e.key === '$type') {
        out.push({ ...rename(e, 'type'), value: reshape(e.value, legacyType, depth + 1, style) });
      } else if (e.key === '$description') {
        out.push(rename(e, descKey));
      } else if (e.key === '$extensions') {
        const { [LEGACY_EXT]: _legacy, ...others } = ext ?? {};
        if (Object.keys(others).length) out.push({ ...e, value: reshape(e.value, others, depth + 1, style) });
      } else {
        out.push(e);
      }
    }
    let obj = withEntries(node, out);
    if (!entry(obj, 'type') && legacyType) obj = setChild(obj, 'type', legacyType, depth, style);
    for (const [k, v] of Object.entries(legacy)) if (k !== 'type' && !entry(obj, k)) obj = setChild(obj, k, v, depth, style);
    if (!DTCG.has(dtcgType ?? '') && dtcgType && !legacy.type) notes.push(`${keyPath.join('.')}: type “${dtcgType}” was written as is.`);
    return obj;
  };

  const group = (node: JObject, keyPath: string[], depth: number, inherited: string | undefined): JObject => {
    const own = entry(node, '$type')?.value;
    const type = own?.kind === 'string' ? own.value : inherited;
    const entries: JEntry[] = [];
    for (const e of node.entries) {
      if (e.key === '$type') continue;
      if (e.key === '$description' && keyPath.length > 0) {
        entries.push(rename(e, 'description'));
        continue;
      }
      if (e.key === '$root' && e.value.kind === 'object') {
        notes.push(`${[...keyPath, '$root'].join('.')}: “$root” tokens have no legacy equivalent and were written as a token named “$root”.`);
      }
      if (e.value.kind === 'object' && (!e.key.startsWith('$') || e.key === '$root')) {
        const path = [...keyPath, e.key];
        entries.push({ ...e, value: entry(e.value, '$value') ? token(e.value, path, depth + 1, type) : group(e.value, path, depth + 1, type) });
        continue;
      }
      entries.push(e);
    }
    return withEntries(node, entries);
  };

  if (doc.root.kind !== 'object') return { doc, notes };
  return { doc: { ...doc, root: group(doc.root, [], 0, undefined) }, notes };
}
