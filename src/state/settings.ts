import { DEFAULT_SETTINGS } from '../model/defaults';
import type { Settings } from '../model/types';

export { DEFAULT_SETTINGS };

/**
 * Preferences persist in localStorage so they survive reloads. They hold
 * only preferences, never token data. Storage can be unavailable (private
 * windows, file://, blocked site data), so every access is guarded.
 */

const KEY = 'tokens-tester:settings:v1';

const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback);

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      acceptLegacy: typeof parsed.acceptLegacy === 'boolean' ? parsed.acceptLegacy : DEFAULT_SETTINGS.acceptLegacy,
      colorFormat: oneOf(parsed.colorFormat, ['oklch', 'hex', 'rgb'] as const, DEFAULT_SETTINGS.colorFormat),
      gamut: oneOf(parsed.gamut, ['srgb', 'p3'] as const, DEFAULT_SETTINGS.gamut),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: settings last for this session only */
  }
}
