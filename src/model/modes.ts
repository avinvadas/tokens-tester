/**
 * Per-mode values stored in `$extensions`. Two shapes are recognized:
 *  - `"$extensions": { "mode": { "light": …, "dark": … } }` (Terrazzo / Cobalt UI);
 *  - `"$extensions": { "<any.vendor>": { "modes": { "light": …, "dark": … } } }`.
 * Each mode name becomes a theme; in it, the token's value is the mode's value.
 */

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export interface ModeValues {
  values: Record<string, unknown>;
  /** Where the mode map sits inside the token object, e.g. ["$extensions", "mode"]. */
  path: string[];
}

export function modeValues(ext: Record<string, unknown> | undefined): ModeValues | undefined {
  if (!ext) return undefined;
  if (isObj(ext.mode)) return { values: ext.mode, path: ['$extensions', 'mode'] };
  for (const [k, v] of Object.entries(ext)) if (isObj(v) && isObj(v.modes)) return { values: v.modes, path: ['$extensions', k, 'modes'] };
  return undefined;
}
