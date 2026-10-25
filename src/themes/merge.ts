import { makeIssue } from '../model/build';
import type { Issue, Model, SourceFile } from '../model/types';
import type { Theme } from './detect';

export interface ThemeModel {
  theme: Theme;
  model: Model;
}

const issueKey = (i: Issue) => [i.code, i.fileId, (i.keyPath ?? []).join('\u0000'), i.target, i.message].join('\u0001');

/**
 * The "all themes" view: every theme's issues together, each tagged with the
 * themes it occurs in (untagged when it occurs in all of them). Tokens and
 * palettes come from the first theme.
 */
export function mergeModels(list: readonly ThemeModel[]): Model {
  const seen = new Map<string, { issue: Issue; themes: string[] }>();
  for (const { theme, model } of list) {
    for (const issue of model.issues) {
      const key = issueKey(issue);
      const entry = seen.get(key);
      if (entry) entry.themes.push(theme.name);
      else seen.set(key, { issue, themes: [theme.name] });
    }
  }
  const issues = [...seen.values()].map(({ issue, themes }) => (themes.length === list.length ? issue : { ...issue, themes }));
  return { ...list[0]!.model, issues };
}

/** An info issue for each file that no theme reads (it would otherwise go unchecked). */
export function orphanIssues(orphans: readonly SourceFile[]): Issue[] {
  return orphans.map((f) =>
    makeIssue('info', 'format', 'file-not-in-theme', `${f.name} isn't part of any theme, so it isn't checked. Add it to a theme in the Themes panel.`, { fileId: f.id }),
  );
}
