import { JsonParseError, parseJson, serialize } from '../json/cst';
import { detectLegacyKind, legacyToDtcg } from '../legacy/convert';
import { DEFAULT_SETTINGS } from '../model/defaults';
import { detectFormat } from '../model/format';
import type { Settings, SourceFile } from '../model/types';
import type { LoadError } from '../state/app';

/**
 * Turning user input into SourceFiles. Everything here runs in the browser:
 * files are read with the File API, and the only network request is the
 * user-initiated fetch of a URL they typed.
 */

export interface RawSource {
  name: string;
  text: string;
  origin: 'file' | 'url';
  url?: string;
  handle?: FileSystemFileHandle;
  blob?: File;
}

export const ACCEPT = '.json,.tokens,application/json,application/design-tokens+json';
const MAX_BYTES = 50 * 1024 * 1024;

let nextId = 0;

/**
 * Parse a source into a SourceFile. Legacy files are converted to DTCG when
 * the setting allows it; otherwise they load as-is and are reported.
 */
export function parseSource(raw: RawSource, settings: Settings = DEFAULT_SETTINGS): SourceFile | LoadError {
  try {
    const { doc: parsed, duplicates } = parseJson(raw.text);
    const format = detectFormat(parsed.root);
    let doc = parsed;
    const file: SourceFile = {
      id: `f${++nextId}`,
      name: raw.name,
      origin: raw.origin,
      text: raw.text,
      baseText: raw.text,
      doc,
      duplicates,
      format,
    };
    if (format === 'legacy') {
      file.legacyKind = detectLegacyKind(parsed.root);
      if (settings.acceptLegacy) {
        const converted = legacyToDtcg(parsed);
        doc = converted.doc;
        file.doc = doc;
        file.baseText = serialize(doc);
        file.converted = true;
        file.conversionNotes = converted.notes;
      }
    }
    if (raw.url) file.url = raw.url;
    if (raw.handle) file.handle = raw.handle;
    if (raw.blob) file.blob = raw.blob;
    return file;
  } catch (err) {
    if (err instanceof JsonParseError) {
      return {
        name: raw.name,
        message: err.message,
        line: err.pos.line,
        col: err.pos.col,
        excerpt: excerpt(raw.text, err.pos.line, err.pos.col),
      };
    }
    return { name: raw.name, message: err instanceof Error ? err.message : String(err) };
  }
}

export const isLoadError = (x: SourceFile | LoadError): x is LoadError => !('doc' in x);

/** Up to two lines of context before the error line, plus a caret under the column. */
function excerpt(text: string, line: number, col: number): string {
  const lines = text.split(/\r?\n/);
  const from = Math.max(0, line - 3);
  const width = String(line).length;
  const out = lines.slice(from, line).map((l, i) => `${String(from + i + 1).padStart(width)} | ${truncate(l)}`);
  out.push(`${' '.repeat(width)} | ${' '.repeat(Math.min(col - 1, 120))}^`);
  return out.join('\n');
}

const truncate = (s: string) => (s.length > 160 ? `${s.slice(0, 160)}…` : s);

/** The browser's own explanation of a failure, for messages. */
const reason = (err: unknown) =>
  err instanceof Error && (err.name !== 'Error' || err.message) ? ` The browser said: ${err.name}${err.message ? `: ${err.message}` : ''}` : '';

async function readFile(file: File, handle?: FileSystemFileHandle): Promise<RawSource | LoadError> {
  if (file.size > MAX_BYTES) return { name: file.name, message: `The file is ${(file.size / 1024 / 1024).toFixed(0)} MB; the limit is 50 MB.` };
  try {
    const raw: RawSource = { name: file.name, text: await file.text(), origin: 'file', blob: file };
    if (handle) raw.handle = handle;
    return raw;
  } catch (err) {
    return { name: file.name, message: `The file could not be read.${reason(err)}` };
  }
}

export function readFiles(files: Iterable<File>): Promise<(RawSource | LoadError)[]> {
  return Promise.all([...files].map((f) => readFile(f)));
}

/**
 * Read through a file handle so Reload can see later changes on disk. Some
 * browsers (embedded Chromium builds in particular) expose the API but fail
 * to read through it; then use the plain File when there is one.
 */
async function readHandle(h: FileSystemHandle | null, fallback: File | null | undefined): Promise<RawSource | LoadError> {
  if (!h) return fallback ? readFile(fallback) : { name: 'Unknown item', message: 'This item is not a file.' };
  if (h.kind !== 'file') return { name: h.name, message: 'Folders are not supported. Choose or drop the token files themselves.' };
  const fh = h as FileSystemFileHandle;
  let result: RawSource | LoadError;
  try {
    result = await readFile(await fh.getFile(), fh);
  } catch (err) {
    result = { name: fh.name, message: `The file could not be read.${reason(err)}` };
  }
  if ('text' in result || !fallback) return result;
  return readFile(fallback);
}

export const canKeepHandles = () => typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function' && !pickerBroken;

/** Set once reading through the picker has failed; later clicks use the standard file input. */
let pickerBroken = false;

/**
 * Open the system file picker. Where the browser supports it, keep file
 * handles so Reload can read the current file from disk later.
 * Resolves to null when the user cancels or the standard input takes over.
 */
export async function pickFiles(fallback: HTMLInputElement): Promise<(RawSource | LoadError)[] | null> {
  if (!canKeepHandles()) {
    fallback.click();
    return null;
  }
  let handles: FileSystemFileHandle[];
  try {
    handles = await window.showOpenFilePicker!({
      multiple: true,
      types: [{ description: 'Design tokens', accept: { 'application/json': ['.json', '.tokens'] } }],
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null;
    pickerBroken = true;
    fallback.click();
    return null;
  }
  const results = await Promise.all(handles.map((h) => readHandle(h, null)));
  if (results.some((r) => !('text' in r))) {
    // The picker returned files this browser can't read. Switch to the standard
    // input for next time; it can't be opened here because the click is used up.
    pickerBroken = true;
    return results.map((r) =>
      'text' in r ? r : { ...r, message: `${r.message} Click the drop zone again to choose it with the standard dialog, or drag it onto the page.` },
    );
  }
  return results;
}

/** Read dropped files, keeping handles where the browser offers them. Must be called during the drop event. */
export function readDropped(dt: DataTransfer): Promise<(RawSource | LoadError)[]> {
  const items = [...dt.items].filter((i) => i.kind === 'file');
  if (items.length && items.every((i) => typeof i.getAsFileSystemHandle === 'function')) {
    // Both must be captured synchronously: the DataTransfer is emptied after the drop event.
    const files = items.map((i) => i.getAsFile());
    const pending = items.map((i) => i.getAsFileSystemHandle!());
    return Promise.all(pending).then(
      (handles) => Promise.all(handles.map((h, i) => readHandle(h, files[i]))),
      () => readFiles(files.filter((f): f is File => f !== null)),
    );
  }
  return readFiles(dt.files);
}

/** Read a loaded file's source again: refetch its URL or re-read it from disk. */
export async function reloadSource(f: SourceFile): Promise<RawSource | LoadError> {
  if (f.origin === 'url' && f.url) {
    return { ...(await fetchSource(f.url)), name: f.name };
  }
  if (f.handle) {
    try {
      return await readFile(await f.handle.getFile(), f.handle);
    } catch (err) {
      return { name: f.name, message: `Couldn't read “${f.name}” again. It may have been moved, renamed or deleted.${reason(err)}` };
    }
  }
  if (f.blob) {
    try {
      return { name: f.name, text: await f.blob.text(), origin: 'file', blob: f.blob };
    } catch (err) {
      return {
        name: f.name,
        message: `This browser can't read “${f.name}” again after it changed on disk. Drop or choose the file again to reload it.${reason(err)}`,
      };
    }
  }
  return { name: f.name, message: `There is no source to reload “${f.name}” from.` };
}

/** github.com/o/r/blob/branch/path → raw.githubusercontent.com/o/r/branch/path */
export function normalizeUrl(input: string): { url: URL; rewritten: boolean } {
  const url = new URL(input.trim());
  if (url.hostname === 'github.com') {
    const m = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url.pathname);
    if (m) return { url: new URL(`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`), rewritten: true };
  }
  return { url, rewritten: false };
}

export async function fetchSource(input: string): Promise<RawSource | LoadError> {
  let url: URL;
  try {
    url = normalizeUrl(input).url;
  } catch {
    return { name: input, message: 'That is not a valid URL.' };
  }
  const name = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? '') || 'tokens.json';
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { name, message: 'Only http and https URLs can be loaded.' };
  let res: Response;
  try {
    // No cookies, no referrer: the request carries nothing about this page or the user.
    res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', mode: 'cors' });
  } catch {
    return {
      name,
      message:
        "Couldn't load the URL. The server may not allow cross-origin requests (CORS), or it may be unreachable. " +
        'Try a raw file URL (for GitHub, raw.githubusercontent.com), or download the file and drop it here.',
    };
  }
  if (!res.ok) return { name, message: `The server answered ${res.status} ${res.statusText}.`.trim() };
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > MAX_BYTES) return { name, message: 'The file is larger than the 50 MB limit.' };
  return { name, text: await res.text(), origin: 'url', url: url.href };
}
