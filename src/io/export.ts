import { serialize } from '../json/cst';
import { dtcgToLegacy } from '../legacy/convert';
import type { SourceFile } from '../model/types';

export type ExportFormat = 'dtcg' | 'original';

export const exportText = (f: SourceFile): string => serialize(f.doc);

/**
 * Text to download. Converted legacy files export as DTCG by default, or back
 * in their original format; `notes` lists what couldn't be converted back.
 */
export function exportAs(f: SourceFile, format: ExportFormat = 'dtcg'): { text: string; notes: string[] } {
  if (format === 'original' && f.converted && f.legacyKind) {
    const { doc, notes } = dtcgToLegacy(f.doc, f.legacyKind);
    return { text: serialize(doc), notes };
  }
  return { text: exportText(f), notes: [] };
}

/** True when the file has no edits: exporting gives back what was loaded (or its DTCG conversion). */
export const isUnchanged = (f: SourceFile): boolean => exportText(f) === f.baseText;

/** Save text as a file. The Blob never leaves the browser. */
export function download(name: string, text: string) {
  const blob = new Blob([text], { type: 'application/json' });
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
