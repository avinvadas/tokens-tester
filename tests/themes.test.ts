import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/model/defaults';
import {
  addFiles,
  addTheme,
  ALL_THEMES,
  applyFixes,
  clearAll,
  removeTheme,
  renameTheme,
  resetThemes,
  setActiveTheme,
  setThemeFile,
  store,
} from '../src/state/app';
import { exportText } from '../src/io/export';
import { detectThemes } from '../src/themes/detect';
import { loadFixture, loadText } from './helpers';

const S = DEFAULT_SETTINGS;
const lightDark = () => ['primitives.tokens.json', 'semantic.light.tokens.json', 'semantic.dark.tokens.json'].map((n) => loadFixture(`themes/${n}`));
const codes = () => store.get().model.issues.map((i) => `${i.code} ${i.target ?? ''}${i.themes ? ` [${i.themes.join(',')}]` : ''}`.trim());

describe('detection', () => {
  it('reads file names: themed files plus shared ones', () => {
    const files = lightDark();
    const themes = detectThemes(files, S);
    expect(themes.map((t) => [t.name, t.source, t.fileIds.length])).toEqual([
      ['Light', 'file-names', 2],
      ['Dark', 'file-names', 2],
    ]);
    expect(themes[0]!.fileIds).toEqual([files[0]!.id, files[1]!.id]);
  });

  it('needs at least two theme words', () => {
    expect(detectThemes([loadFixture('themes/primitives.tokens.json'), loadFixture('themes/semantic.light.tokens.json')], S)).toEqual([]);
  });

  it('reads Tokens Studio $themes with their sets', () => {
    const f = loadFixture('themes/tokens-studio-themes.json');
    const themes = detectThemes([f], S);
    expect(themes.map((t) => [t.name, t.source])).toEqual([
      ['Mode / Light', 'tokens-studio'],
      ['Mode / Dark', 'tokens-studio'],
    ]);
    expect(themes[0]!.scope.sets).toEqual({ [f.id]: ['global', 'light'] });
  });

  it('reads a Tokens Studio folder export with a separate $themes.json', () => {
    const themesFile = loadText(
      JSON.stringify([
        { name: 'light', selectedTokenSets: { 'core/global': 'source', 'modes/light': 'enabled' } },
        { name: 'dark', selectedTokenSets: { 'core/global': 'source', 'modes/dark': 'enabled' } },
      ]),
      '$themes.json',
    );
    const global = loadText('{"white": {"$type": "color", "$value": {"colorSpace": "srgb", "components": [1, 1, 1]}}}', 'global.json');
    const light = loadText('{"bg": {"$value": "{white}"}}', 'light.json');
    const dark = loadText('{"bg": {"$value": "{nope}"}}', 'dark.json');
    const themes = detectThemes([themesFile, global, light, dark], S);
    expect(themes.map((t) => t.fileIds)).toEqual([
      [global.id, light.id],
      [global.id, dark.id],
    ]);
  });

  it('reads per-mode values from $extensions', () => {
    const themes = detectThemes([loadFixture('themes/modes.tokens.json')], S);
    expect(themes.map((t) => [t.name, t.scope.mode])).toEqual([
      ['Light', 'light'],
      ['Dark', 'dark'],
    ]);
  });
});

describe('per-theme models', () => {
  beforeEach(() => clearAll());

  it('checks each theme on its own: no duplicate warnings, theme-only issues are tagged', () => {
    addFiles(lightDark());
    const s = store.get();
    expect(s.themes).toHaveLength(2);
    expect(s.activeTheme).toBe(ALL_THEMES);
    expect(codes()).toEqual(['unresolved-reference color.accent [Dark]']);
    const light = s.themeModels[0]!.model;
    const dark = s.themeModels[1]!.model;
    expect(light.tokens.get('color.bg.default')!.aliasOf).toBe('color.gray.0');
    expect(dark.tokens.get('color.bg.default')!.aliasOf).toBe('color.gray.900');
  });

  it('switches the active theme', () => {
    addFiles(lightDark());
    const dark = store.get().themes[1]!.id;
    setActiveTheme(dark);
    expect(store.get().model).toBe(store.get().themeModels[1]!.model);
    expect(codes()).toEqual(['unresolved-reference color.accent']);
    setActiveTheme(store.get().themes[0]!.id);
    expect(codes()).toEqual([]);
  });

  it('without themes, the same files clash', () => {
    addFiles(lightDark());
    store.get().themes.forEach((t) => removeTheme(t.id));
    expect(store.get().themes).toEqual([]);
    expect(codes().filter((c) => c.startsWith('duplicate-path'))).toHaveLength(3);
  });

  it('Tokens Studio themes read only their sets', () => {
    addFiles([loadFixture('themes/tokens-studio-themes.json')]);
    const [light, dark] = store.get().themeModels;
    expect(light!.model.tokens.get('bg')!.aliasOf).toBe('color.white');
    expect(dark!.model.tokens.get('bg')!.aliasOf).toBe('color.black');
    expect(codes()).toEqual([]);
  });

  it('mode themes use the mode value, and fixes edit that value', () => {
    addFiles([loadFixture('themes/modes.tokens.json')]);
    const [light, dark] = store.get().themeModels;
    expect(light!.model.tokens.get('color.fg')!.aliasOf).toBe('color.black');
    expect(dark!.model.tokens.get('color.fg')).toMatchObject({ valuePath: ['$extensions', 'mode', 'dark'], rawValue: '#ffffff' });
    const issue = store.get().model.issues.find((i) => i.code === 'legacy-value')!;
    expect(issue.themes).toEqual(['Dark']);
    applyFixes([issue.fix!]);
    expect(JSON.parse(exportText(store.get().files[0]!)).color.fg.$extensions.mode.dark).toEqual({ colorSpace: 'srgb', components: [1, 1, 1], hex: '#ffffff' });
    expect(codes().sort()).toEqual(['extension-naming color.bg', 'extension-naming color.fg']);
  });
});

describe('editing themes', () => {
  beforeEach(() => clearAll());

  it('rename, toggle files, add and remove; a file in no theme is reported', () => {
    addFiles(lightDark());
    const [light, dark] = store.get().themes;
    renameTheme(light!.id, 'Day');
    expect(store.get().themes[0]!.name).toBe('Day');
    expect(store.get().themesCustomized).toBe(true);

    const darkFile = store.get().files[2]!.id;
    setThemeFile(dark!.id, darkFile, false);
    expect(codes()).toContain('file-not-in-theme');
    setThemeFile(dark!.id, darkFile, true);
    expect(store.get().themes[1]!.fileIds).toEqual(store.get().files.filter((f) => f.id !== store.get().files[1]!.id).map((f) => f.id));

    addTheme();
    expect(store.get().themes.map((t) => t.name)).toEqual(['Day', 'Dark', 'Theme 3']);
    expect(store.get().themes[2]!.fileIds).toHaveLength(3);
  });

  it('keeps edited themes when files are added or reloaded', () => {
    addFiles(lightDark());
    renameTheme(store.get().themes[0]!.id, 'Day');
    const extra = loadText('{"x": {"$type": "number", "$value": 1}}', 'extra.json');
    addFiles([extra]);
    expect(store.get().themes.every((t) => t.fileIds.includes(extra.id))).toBe(true);
    const reloaded = loadFixture('themes/semantic.dark.tokens.json');
    addFiles([reloaded]);
    expect(store.get().themes[1]!.fileIds).toContain(reloaded.id);
    expect(store.get().themes[0]!.fileIds).not.toContain(reloaded.id);
  });

  it('detects again on reset', () => {
    addFiles(lightDark());
    renameTheme(store.get().themes[0]!.id, 'Day');
    resetThemes();
    expect(store.get().themes.map((t) => t.name)).toEqual(['Light', 'Dark']);
    expect(store.get().themesCustomized).toBe(false);
  });

  it('starts manual themes as a pair when none were detected', () => {
    addFiles([loadFixture('dtcg/primitives.tokens.json'), loadFixture('dtcg/semantic.tokens.json')]);
    addTheme();
    expect(store.get().themes.map((t) => [t.name, t.source, t.fileIds.length])).toEqual([
      ['Theme 1', 'manual', 2],
      ['Theme 2', 'manual', 2],
    ]);
  });
});
