import { entry, type JObject, type Pos } from '../json/cst';
import { tokenSets } from '../model/build';
import type { SourceFile } from '../model/types';

export interface NodeVisit {
  file: SourceFile;
  node: JObject;
  /** Location in the file. */
  keyPath: string[];
  /** Token or group name as used in references (without a Tokens Studio set). */
  path: string[];
  kind: 'token' | 'group';
  /** The file's root object (or, in a multi-set file, the metadata root). */
  isRoot: boolean;
  /** A Tokens Studio set object. */
  isSet: boolean;
  /** Nesting depth of `node` in the document, for formatting edits. */
  depth: number;
  pos?: Pos;
}

/** Every token and group object in the files that are read as DTCG. */
export function* walkNodes(files: SourceFile[]): Generator<NodeVisit> {
  for (const file of files) {
    if (file.doc.root.kind !== 'object' || (file.format === 'legacy' && !file.converted)) continue;
    const root = file.doc.root;
    const sets = tokenSets(root);
    yield { file, node: root, keyPath: [], path: [], kind: 'group', isRoot: true, isSet: false, depth: 0 };
    if (sets) {
      for (const set of sets) {
        const e = entry(root, set)!;
        yield* visit(file, e.value as JObject, [set], [], 1, false, e.pos, true);
      }
    } else {
      yield* children(file, root, [], [], 0);
    }
  }
}

function* visit(file: SourceFile, node: JObject, keyPath: string[], path: string[], depth: number, token: boolean, pos: Pos | undefined, isSet = false): Generator<NodeVisit> {
  const v: NodeVisit = { file, node, keyPath, path, kind: token ? 'token' : 'group', isRoot: false, isSet, depth };
  if (pos) v.pos = pos;
  yield v;
  if (!token) yield* children(file, node, keyPath, path, depth);
}

function* children(file: SourceFile, node: JObject, keyPath: string[], path: string[], depth: number): Generator<NodeVisit> {
  for (const e of node.entries) {
    if (e.value.kind !== 'object') continue;
    if (e.key.startsWith('$') && e.key !== '$root') continue;
    const isToken = !!entry(e.value, '$value');
    yield* visit(file, e.value, [...keyPath, e.key], [...path, e.key], depth + 1, isToken, e.pos);
  }
}
