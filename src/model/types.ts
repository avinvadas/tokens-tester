import type { DuplicateKey, JDoc, JPath, Pos } from '../json/cst';

export type FileFormat = 'dtcg' | 'legacy' | 'unknown';
export type LegacyKind = 'tokens-studio' | 'style-dictionary';

/** User preferences. Persisted locally; never contains token data. */
export interface Settings {
  /** Accept Tokens Studio / Style Dictionary v3 files by converting them to DTCG. */
  acceptLegacy: boolean;
  /** How colors are written on screen. */
  colorFormat: 'oklch' | 'hex' | 'rgb';
  /** Target gamut: colors outside it are flagged. */
  gamut: 'srgb' | 'p3';
  /** Contrast compliance targets checked in the palette view. */
  contrast: ('wcag-aa' | 'wcag-aaa' | 'apca')[];
}

/** One change to a document. */
export type Edit = { fileId: string; path: JPath } & ({ value: unknown } | { delete: true } | { rename: string });

/** A note from converting a legacy file, e.g. a value that has no DTCG equivalent. */
export interface ConversionNote {
  keyPath: string[];
  message: string;
}

/** A loaded tokens file. `text` is the original input; `doc` reflects edits. */
export interface SourceFile {
  id: string;
  name: string;
  origin: 'file' | 'url';
  url?: string;
  /** Re-readable handle (Chromium File System Access API), used by Reload. */
  handle?: FileSystemFileHandle;
  /** The picked or dropped File, re-read by Reload when there is no handle. */
  blob?: File;
  /** The file as loaded (for reload comparisons). */
  text: string;
  /** The document as first prepared: equal to `text` for DTCG, the converted document for legacy files. Edits are measured against it. */
  baseText: string;
  doc: JDoc;
  duplicates: DuplicateKey[];
  /** Format of the file as loaded. */
  format: FileFormat;
  /** Set for legacy files; `converted` tells whether `doc` holds the DTCG conversion. */
  legacyKind?: LegacyKind;
  converted?: boolean;
  conversionNotes?: ConversionNote[];
}

export type Severity = 'error' | 'warning' | 'info';

export type Category = 'format' | 'structure' | 'types' | 'values' | 'references' | 'metadata';

/** A suggested fix: document edits (undoable), or a settings change. */
export type Fix = {
  label: string;
  /** Short before/after text shown before applying. */
  preview?: { before: string; after: string };
} & ({ edits: Edit[] } | { setting: Partial<Settings> });

export interface Issue {
  severity: Severity;
  category: Category;
  /** Stable machine-readable rule id, e.g. "unresolved-reference". */
  code: string;
  message: string;
  fix?: Fix;
  fileId?: string;
  /** Token or group id the issue is about. */
  target?: string;
  /** Location of the token or group inside its file, for fixes. */
  keyPath?: string[];
  pos?: Pos;
  /** In the all-themes view: the themes this issue occurs in, when not all of them. */
  themes?: string[];
}

export type Resolution = 'ok' | 'broken';

export interface Token {
  /** Dot-joined path, the same string used inside `{alias}` references. */
  id: string;
  path: string[];
  fileId: string;
  /** Location of the token object inside its file. */
  keyPath: string[];
  /** `$type` written on the token itself. */
  declaredType?: string;
  /** `$type` inherited from the closest ancestor group that sets one. */
  inheritedType?: string;
  /** Final type: declared, inherited, or taken from the alias target. */
  type?: string;
  /** `$value` as written (or, in a mode theme, the mode's value). */
  rawValue: unknown;
  /** Where `rawValue` sits inside the token object: ["$value"], or a mode entry under `$extensions`. */
  valuePath: string[];
  /** `$value` with every reference replaced; undefined when resolution failed. */
  value?: unknown;
  /** Set when the whole value is a reference to another token. */
  aliasOf?: string;
  /** Every token this one references directly, in order of appearance. */
  refs: string[];
  resolution: Resolution;
  description?: string;
  extensions?: Record<string, unknown>;
  deprecated?: boolean | string;
  /** Global source order across files, for stable display. */
  order: number;
  pos?: Pos;
  /** Set on tokens copied into a group by `$extends`; such tokens are not written on export. */
  extendedFrom?: string;
}

export interface Group {
  id: string;
  path: string[];
  fileId: string;
  keyPath: string[];
  type?: string;
  description?: string;
  extensions?: Record<string, unknown>;
  deprecated?: boolean | string;
  /** Raw `$extends` reference. */
  extends?: string;
  pos?: Pos;
}

/**
 * What a theme reads: which Tokens Studio sets per file (all when absent),
 * and which `$extensions` mode supplies values (the plain `$value` when absent).
 * Which files a theme includes is decided before building.
 */
export interface ThemeScope {
  sets?: Readonly<Record<string, readonly string[]>>;
  mode?: string;
}

export interface Model {
  files: SourceFile[];
  settings: Settings;
  tokens: Map<string, Token>;
  groups: Group[];
  issues: Issue[];
}
