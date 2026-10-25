/**
 * Lossless JSON concrete syntax tree.
 *
 * `JSON.parse` loses two things this tool depends on:
 *  - key order: integer-like keys ("50", "100", "900") are hoisted and sorted
 *    by the engine, which scrambles scale steps and breaks round-trips;
 *  - formatting: whitespace, inline arrays, number spelling (1.0 vs 1) and
 *    string escapes.
 *
 * This parser keeps every byte. `serialize(parseJson(text).doc) === text`
 * holds for any valid JSON, and edits through `setIn` / `deleteIn` touch only
 * the nodes they change, so exported files diff cleanly against the input.
 *
 * Trees are immutable: edits return a new document that shares untouched
 * nodes with the old one (cheap snapshots for undo/redo).
 */

export interface Pos {
  offset: number;
  line: number;
  col: number;
}

export type JNode = JObject | JArray | JString | JNumber | JBool | JNull;

export interface JObject {
  kind: 'object';
  entries: JEntry[];
  /** Whitespace between the braces when there are no entries. */
  inner: string;
  pos?: Pos;
}

export interface JEntry {
  key: string;
  /** Source spelling of the key, kept only when it differs from JSON.stringify(key). */
  rawKey?: string;
  /** Whitespace after `{` or `,`. */
  before: string;
  /** Whitespace between the key and `:`. */
  afterKey: string;
  /** Whitespace between `:` and the value. */
  afterColon: string;
  value: JNode;
  /** Whitespace after the value, before `,` or `}`. */
  after: string;
  /** Position of the key. */
  pos?: Pos;
}

export interface JArray {
  kind: 'array';
  items: JItem[];
  inner: string;
  pos?: Pos;
}

export interface JItem {
  before: string;
  value: JNode;
  after: string;
}

export interface JString {
  kind: 'string';
  value: string;
  raw?: string;
  pos?: Pos;
}

export interface JNumber {
  kind: 'number';
  value: number;
  raw?: string;
  pos?: Pos;
}

export interface JBool {
  kind: 'boolean';
  value: boolean;
  pos?: Pos;
}

export interface JNull {
  kind: 'null';
  pos?: Pos;
}

/** Formatting conventions detected from the source, used for newly inserted nodes. */
export interface JStyle {
  /** One indentation level ('' for compact files). */
  indent: string;
  newline: string;
  /** Whitespace after `:`. */
  colon: string;
}

export interface JDoc {
  leading: string;
  root: JNode;
  trailing: string;
  style: JStyle;
}

export type JPath = (string | number)[];

export interface DuplicateKey {
  path: JPath;
  key: string;
  pos: Pos;
}

export class JsonParseError extends Error {
  constructor(
    message: string,
    readonly pos: Pos,
  ) {
    super(message);
    this.name = 'JsonParseError';
  }
}

// ---------------------------------------------------------------------------
// Parsing

const NUMBER_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

class Parser {
  private i = 0;
  private line = 1;
  private lineStart = 0;
  readonly duplicates: DuplicateKey[] = [];

  constructor(private readonly s: string) {}

  parse(): JDoc {
    const leading = this.ws();
    if (this.i >= this.s.length) this.fail('The file is empty.');
    const root = this.value([]);
    const trailing = this.ws();
    if (this.i < this.s.length) this.fail('Unexpected content after the end of the JSON document.');
    return { leading, root, trailing, style: detectStyle(this.s, root) };
  }

  private pos(): Pos {
    return { offset: this.i, line: this.line, col: this.i - this.lineStart + 1 };
  }

  private fail(message: string, at: Pos = this.pos()): never {
    throw new JsonParseError(message, at);
  }

  private ws(): string {
    const start = this.i;
    const s = this.s;
    while (this.i < s.length) {
      const c = s.charCodeAt(this.i);
      if (c === 10) {
        this.line++;
        this.lineStart = this.i + 1;
      } else if (c !== 32 && c !== 9 && c !== 13) {
        break;
      }
      this.i++;
    }
    return s.slice(start, this.i);
  }

  private value(path: JPath): JNode {
    const c = this.s[this.i];
    const pos = this.pos();
    switch (c) {
      case '{':
        return this.object(path);
      case '[':
        return this.array(path);
      case '"': {
        const { value, raw } = this.string();
        return raw === JSON.stringify(value) ? { kind: 'string', value, pos } : { kind: 'string', value, raw, pos };
      }
      case 't':
        return this.literal('true', { kind: 'boolean', value: true, pos });
      case 'f':
        return this.literal('false', { kind: 'boolean', value: false, pos });
      case 'n':
        return this.literal('null', { kind: 'null', pos });
      case undefined:
        return this.fail('Unexpected end of file.');
      default:
        if (c === '-' || (c >= '0' && c <= '9')) return this.number();
        return this.fail(`Unexpected character ${JSON.stringify(c)}.`);
    }
  }

  private literal<T extends JNode>(word: string, node: T): T {
    if (!this.s.startsWith(word, this.i)) this.fail(`Unexpected token; did you mean "${word}"?`);
    this.i += word.length;
    return node;
  }

  private number(): JNumber {
    const pos = this.pos();
    NUMBER_RE.lastIndex = this.i;
    const m = NUMBER_RE.exec(this.s);
    if (!m) this.fail('Invalid number.');
    const raw = m[0];
    this.i += raw.length;
    const value = Number(raw);
    return String(value) === raw ? { kind: 'number', value, pos } : { kind: 'number', value, raw, pos };
  }

  private string(): { value: string; raw: string } {
    const start = this.i;
    const startPos = this.pos();
    const s = this.s;
    this.i++;
    for (;;) {
      if (this.i >= s.length) this.fail('Unterminated string.', startPos);
      const c = s.charCodeAt(this.i);
      if (c === 34) break;
      if (c === 92) {
        this.i += 2;
        continue;
      }
      if (c < 0x20) this.fail('Strings cannot contain unescaped line breaks or control characters.');
      this.i++;
    }
    this.i++;
    const raw = s.slice(start, this.i);
    try {
      return { value: JSON.parse(raw) as string, raw };
    } catch {
      return this.fail('Invalid escape sequence in string.', startPos);
    }
  }

  private object(path: JPath): JObject {
    const pos = this.pos();
    this.i++;
    const entries: JEntry[] = [];
    const seen = new Set<string>();
    let before = this.ws();
    if (this.s[this.i] === '}') {
      this.i++;
      return { kind: 'object', entries, inner: before, pos };
    }
    for (;;) {
      if (this.s[this.i] !== '"') {
        if (this.s[this.i] === '}' && entries.length > 0) this.fail('Trailing commas are not allowed in JSON.');
        this.fail('Expected a property name in double quotes.');
      }
      const keyPos = this.pos();
      const { value: key, raw: rawKey } = this.string();
      const afterKey = this.ws();
      if (this.s[this.i] !== ':') this.fail("Expected ':' after the property name.");
      this.i++;
      const afterColon = this.ws();
      if (seen.has(key)) this.duplicates.push({ path, key, pos: keyPos });
      seen.add(key);
      const value = this.value([...path, key]);
      const after = this.ws();
      const entry: JEntry = { key, before, afterKey, afterColon, value, after, pos: keyPos };
      if (rawKey !== JSON.stringify(key)) entry.rawKey = rawKey;
      entries.push(entry);
      const c = this.s[this.i];
      if (c === ',') {
        this.i++;
        before = this.ws();
        continue;
      }
      if (c === '}') {
        this.i++;
        return { kind: 'object', entries, inner: '', pos };
      }
      this.fail(c === undefined ? "Unexpected end of file; expected '}'." : "Expected ',' or '}' after the value.");
    }
  }

  private array(path: JPath): JArray {
    const pos = this.pos();
    this.i++;
    const items: JItem[] = [];
    let before = this.ws();
    if (this.s[this.i] === ']') {
      this.i++;
      return { kind: 'array', items, inner: before, pos };
    }
    for (;;) {
      if (this.s[this.i] === ']' && items.length > 0) this.fail('Trailing commas are not allowed in JSON.');
      const value = this.value([...path, items.length]);
      const after = this.ws();
      items.push({ before, value, after });
      const c = this.s[this.i];
      if (c === ',') {
        this.i++;
        before = this.ws();
        continue;
      }
      if (c === ']') {
        this.i++;
        return { kind: 'array', items, inner: '', pos };
      }
      this.fail(c === undefined ? "Unexpected end of file; expected ']'." : "Expected ',' or ']' after the value.");
    }
  }
}

function detectStyle(text: string, root: JNode): JStyle {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const indent = /\n([ \t]+)\S/.exec(text)?.[1] ?? '';
  let colon = indent ? ' ' : '';
  if (root.kind === 'object' && root.entries[0]) colon = root.entries[0].afterColon;
  return { indent, newline, colon };
}

export function parseJson(text: string): { doc: JDoc; duplicates: DuplicateKey[] } {
  // A UTF-8 byte-order mark is not JSON whitespace but is common in exported files.
  const bom = text.charCodeAt(0) === 0xfeff ? '﻿' : '';
  const parser = new Parser(bom ? text.slice(1) : text);
  const doc = parser.parse();
  return { doc: { ...doc, leading: bom + doc.leading }, duplicates: parser.duplicates };
}

// ---------------------------------------------------------------------------
// Serializing

export function serialize(doc: JDoc): string {
  const out: string[] = [doc.leading];
  emit(doc.root, out);
  out.push(doc.trailing);
  return out.join('');
}

function emit(n: JNode, out: string[]): void {
  switch (n.kind) {
    case 'object':
      out.push('{');
      if (n.entries.length === 0) out.push(n.inner);
      n.entries.forEach((e, i) => {
        if (i > 0) out.push(',');
        out.push(e.before, e.rawKey ?? JSON.stringify(e.key), e.afterKey, ':', e.afterColon);
        emit(e.value, out);
        out.push(e.after);
      });
      out.push('}');
      return;
    case 'array':
      out.push('[');
      if (n.items.length === 0) out.push(n.inner);
      n.items.forEach((it, i) => {
        if (i > 0) out.push(',');
        out.push(it.before);
        emit(it.value, out);
        out.push(it.after);
      });
      out.push(']');
      return;
    case 'string':
      out.push(n.raw ?? JSON.stringify(n.value));
      return;
    case 'number':
      out.push(n.raw ?? String(n.value));
      return;
    case 'boolean':
      out.push(String(n.value));
      return;
    case 'null':
      out.push('null');
      return;
  }
}

// ---------------------------------------------------------------------------
// Reading

export function toJS(n: JNode): unknown {
  switch (n.kind) {
    case 'object': {
      const o: Record<string, unknown> = {};
      for (const e of n.entries) {
        Object.defineProperty(o, e.key, { value: toJS(e.value), enumerable: true, writable: true, configurable: true });
      }
      return o;
    }
    case 'array':
      return n.items.map((it) => toJS(it.value));
    case 'null':
      return null;
    default:
      return n.value;
  }
}

export function entry(n: JNode | undefined, key: string): JEntry | undefined {
  if (n?.kind !== 'object') return undefined;
  // Last one wins, matching JSON.parse for duplicate keys.
  for (let i = n.entries.length - 1; i >= 0; i--) if (n.entries[i]!.key === key) return n.entries[i];
  return undefined;
}

export function getIn(n: JNode | undefined, path: JPath): JNode | undefined {
  let cur = n;
  for (const seg of path) {
    if (!cur) return undefined;
    if (typeof seg === 'number') cur = cur.kind === 'array' ? cur.items[seg]?.value : undefined;
    else cur = entry(cur, seg)?.value;
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Building and editing

/**
 * Build a fresh node for `value`, formatted like JSON.stringify with the
 * document's style. With `inline`, objects and arrays go on one line
 * (`{ "a": 1, "b": [1, 2] }`), for values that sit inside a single-line object.
 */
export function fromJS(value: unknown, depth: number, style: JStyle, inline = false): JNode {
  if (value === null) return { kind: 'null' };
  if (typeof value === 'string') return { kind: 'string', value };
  if (typeof value === 'boolean') return { kind: 'boolean', value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Cannot write ${value} to JSON.`);
    return { kind: 'number', value };
  }
  const spaced = inline && style.indent !== '';
  const pad = (d: number) => (style.indent && !inline ? style.newline + style.indent.repeat(d) : '');
  if (Array.isArray(value)) {
    const items = value.map((v, i) => ({
      before: spaced && i > 0 ? ' ' : pad(depth + 1),
      value: fromJS(v === undefined ? null : v, depth + 1, style, inline),
      after: i === value.length - 1 ? pad(depth) : '',
    }));
    return { kind: 'array', items, inner: '' };
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => (value as Record<string, unknown>)[k] !== undefined);
    const entries = keys.map((key, i) => ({
      key,
      before: spaced ? ' ' : pad(depth + 1),
      afterKey: '',
      afterColon: spaced ? ' ' : style.colon,
      value: fromJS((value as Record<string, unknown>)[key], depth + 1, style, inline),
      after: i === keys.length - 1 ? (spaced ? ' ' : pad(depth)) : '',
    }));
    return { kind: 'object', entries, inner: '' };
  }
  throw new TypeError(`Cannot write a ${typeof value} to JSON.`);
}

/**
 * Build a node for `value` that reuses the formatting of `old` wherever the
 * shapes line up: an inline array stays inline, unchanged numbers keep their
 * spelling, existing keys keep their order and spacing.
 */
export function reshape(old: JNode | undefined, value: unknown, depth: number, style: JStyle, inline = false): JNode {
  if (old && value !== null && typeof value !== 'object') {
    if ((old.kind === 'string' || old.kind === 'number' || old.kind === 'boolean') && old.value === value) return old;
    return fromJS(value, depth, style, inline);
  }
  if (old?.kind === 'null' && value === null) return old;

  if (Array.isArray(value) && old?.kind === 'array' && old.items.length > 0) {
    const t = old.items;
    const firstBefore = t[0]!.before;
    const midBefore = (t[1] ?? t[0]!).before;
    const midAfter = t.length > 1 ? t[0]!.after : '';
    const lastAfter = t[t.length - 1]!.after;
    const items = value.map((v, i) => ({
      before: i === 0 ? firstBefore : midBefore,
      value: reshape(t[i]?.value, v === undefined ? null : v, depth + 1, style, isInline(old)),
      after: i === value.length - 1 ? lastAfter : midAfter,
    }));
    return { kind: 'array', items, inner: items.length ? '' : old.inner, pos: old.pos };
  }

  if (value && typeof value === 'object' && !Array.isArray(value) && old?.kind === 'object' && old.entries.length > 0) {
    const obj = value as Record<string, unknown>;
    const has = (k: string) => Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== undefined;
    const t = old.entries;
    const keys = [...t.map((e) => e.key).filter((k, i, a) => has(k) && a.indexOf(k) === i)];
    for (const k of Object.keys(obj)) if (has(k) && !keys.includes(k)) keys.push(k);
    const firstBefore = t[0]!.before;
    const midBefore = (t[1] ?? t[0]!).before;
    const midAfter = t.length > 1 ? t[0]!.after : '';
    const lastAfter = t[t.length - 1]!.after;
    const entries = keys.map((key, i): JEntry => {
      const prev = entry(old, key);
      const e: JEntry = {
        key,
        before: i === 0 ? firstBefore : midBefore,
        afterKey: prev?.afterKey ?? t[0]!.afterKey,
        afterColon: prev?.afterColon ?? t[0]!.afterColon,
        value: reshape(prev?.value, obj[key], depth + 1, style, isInline(old)),
        after: i === keys.length - 1 ? lastAfter : midAfter,
      };
      if (prev?.rawKey) e.rawKey = prev.rawKey;
      if (prev?.pos) e.pos = prev.pos;
      return e;
    });
    return { kind: 'object', entries, inner: entries.length ? '' : old.inner, pos: old.pos };
  }

  return fromJS(value, depth, style, inline);
}

/** True when an object or array is written on a single line. */
export function isInline(n: JNode): boolean {
  if (n.kind === 'object') return n.entries.every((e) => !e.before.includes('\n') && !e.after.includes('\n'));
  if (n.kind === 'array') return n.items.every((it) => !it.before.includes('\n') && !it.after.includes('\n'));
  return false;
}

function appendEntry(obj: JObject, key: string, value: JNode, depth: number, style: JStyle): JObject {
  const n = obj.entries.length;
  if (n === 0) {
    const pad = (d: number) => (style.indent ? style.newline + style.indent.repeat(d) : '');
    const e: JEntry = { key, before: pad(depth + 1), afterKey: '', afterColon: style.colon, value, after: pad(depth) };
    return { ...obj, entries: [e], inner: '' };
  }
  const last = obj.entries[n - 1]!;
  const midAfter = n > 1 ? obj.entries[n - 2]!.after : '';
  const entries = obj.entries.slice(0, n - 1);
  entries.push({ ...last, after: midAfter });
  entries.push({ key, before: last.before, afterKey: last.afterKey, afterColon: last.afterColon, value, after: last.after });
  return { ...obj, entries };
}

function nest(path: JPath, from: number, value: unknown): unknown {
  let v = value;
  for (let i = path.length - 1; i >= from; i--) {
    const seg = path[i]!;
    v = typeof seg === 'number' ? Object.assign([], { [seg]: v }) : { [seg]: v };
  }
  return v;
}

function setNode(node: JNode, path: JPath, i: number, value: unknown, depth: number, style: JStyle, inline = false): JNode {
  if (i === path.length) return reshape(node, value, depth, style, inline);
  const seg = path[i]!;
  if (typeof seg === 'number') {
    if (node.kind !== 'array') throw new TypeError(`Cannot index a ${node.kind} with ${seg}.`);
    if (seg < node.items.length) {
      const items = node.items.slice();
      items[seg] = { ...items[seg]!, value: setNode(items[seg]!.value, path, i + 1, value, depth + 1, style, isInline(node)) };
      return { ...node, items };
    }
    if (seg === node.items.length) {
      const arr = reshape(node, [...(toJS(node) as unknown[]), nest(path, i + 1, value)], depth, style) as JArray;
      return arr;
    }
    throw new RangeError(`Index ${seg} is out of range.`);
  }
  if (node.kind !== 'object') throw new TypeError(`Cannot set "${seg}" on a ${node.kind}.`);
  const idx = findLastIndex(node.entries, (e) => e.key === seg);
  if (idx === -1) {
    const child = fromJS(nest(path, i + 1, value), depth + 1, style, node.entries.length > 0 && isInline(node));
    return appendEntry(node, seg, child, depth, style);
  }
  const entries = node.entries.slice();
  entries[idx] = { ...entries[idx]!, value: setNode(entries[idx]!.value, path, i + 1, value, depth + 1, style, isInline(node)) };
  return { ...node, entries };
}

/** Set or add property `key` on an object that sits at `depth`, keeping surrounding formatting. */
export function setChild(obj: JObject, key: string, value: unknown, depth: number, style: JStyle): JObject {
  return setNode(obj, [key], 0, value, depth, style) as JObject;
}

function findLastIndex<T>(a: T[], pred: (t: T) => boolean): number {
  for (let i = a.length - 1; i >= 0; i--) if (pred(a[i]!)) return i;
  return -1;
}

/** Return a new document with `value` written at `path`, creating missing objects. */
export function setIn(doc: JDoc, path: JPath, value: unknown): JDoc {
  return { ...doc, root: setNode(doc.root, path, 0, value, 0, doc.style) };
}

/** Return a new document with the property at `path` removed (no-op if missing). */
export function deleteIn(doc: JDoc, path: JPath): JDoc {
  if (path.length === 0) throw new RangeError('Cannot delete the document root.');
  const del = (node: JNode, i: number): JNode => {
    const seg = path[i]!;
    if (i < path.length - 1) {
      const child = typeof seg === 'number' ? (node.kind === 'array' ? node.items[seg]?.value : undefined) : entry(node, seg)?.value;
      if (!child) return node;
      if (typeof seg === 'number' && node.kind === 'array') {
        const items = node.items.slice();
        items[seg] = { ...items[seg]!, value: del(child, i + 1) };
        return { ...node, items };
      }
      if (node.kind === 'object') {
        const idx = findLastIndex(node.entries, (e) => e.key === seg);
        const entries = node.entries.slice();
        entries[idx] = { ...entries[idx]!, value: del(child, i + 1) };
        return { ...node, entries };
      }
      return node;
    }
    if (typeof seg === 'number') {
      if (node.kind !== 'array' || seg >= node.items.length) return node;
      return { ...node, items: removeAt(node.items, seg), inner: '' };
    }
    if (node.kind !== 'object') return node;
    const idx = findLastIndex(node.entries, (e) => e.key === seg);
    if (idx === -1) return node;
    return { ...node, entries: removeAt(node.entries, idx), inner: '' };
  };
  return { ...doc, root: del(doc.root, 0) };
}

function removeAt<T extends { before: string; after: string }>(list: T[], idx: number): T[] {
  const out = list.slice();
  const [removed] = out.splice(idx, 1);
  if (removed && idx === list.length - 1 && out.length > 0) {
    // The removed item carried the whitespace before the closing bracket.
    out[out.length - 1] = { ...out[out.length - 1]!, after: removed.after };
  }
  return out;
}

/** Return a new document with the property at `path` renamed to `newKey`, keeping its position and formatting. */
export function renameIn(doc: JDoc, path: JPath, newKey: string): JDoc {
  if (path.length === 0) throw new RangeError('Cannot rename the document root.');
  const key = path[path.length - 1];
  if (typeof key !== 'string') throw new TypeError('Only object properties can be renamed.');
  const parentPath = path.slice(0, -1);
  const rename = (node: JNode, i: number): JNode => {
    if (i === parentPath.length) {
      if (node.kind !== 'object') return node;
      const idx = findLastIndex(node.entries, (e) => e.key === key);
      if (idx === -1) return node;
      const entries = node.entries.slice();
      const { rawKey: _drop, ...rest } = entries[idx]!;
      entries[idx] = { ...rest, key: newKey };
      return { ...node, entries };
    }
    const seg = parentPath[i]!;
    if (typeof seg === 'number') {
      if (node.kind !== 'array' || !node.items[seg]) return node;
      const items = node.items.slice();
      items[seg] = { ...items[seg]!, value: rename(items[seg]!.value, i + 1) };
      return { ...node, items };
    }
    if (node.kind !== 'object') return node;
    const idx = findLastIndex(node.entries, (e) => e.key === seg);
    if (idx === -1) return node;
    const entries = node.entries.slice();
    entries[idx] = { ...entries[idx]!, value: rename(entries[idx]!.value, i + 1) };
    return { ...node, entries };
  };
  return { ...doc, root: rename(doc.root, 0) };
}
