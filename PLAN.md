# Tokens Tester — Plan

A single-page, browser-only evaluator for design-token files. All parsing, validation, color math and export happen locally in the browser. Token data never leaves the user's machine.

---

## 0. Privacy model

### The promise (user-facing wording)
> Your token files are processed entirely in your browser. Their contents — names, values, structure — are never uploaded, stored or sent anywhere. The hosted version uses masked usability recordings (Hotjar / Clarity) that never capture your token data. For full isolation, clone the repo and run it offline.

### Two builds, one codebase
| | Hosted build | Strict build (`npm run build:strict`) |
|---|---|---|
| Usability recording (Hotjar / Clarity) | Yes, after consent | Removed at build time (not just disabled) |
| URL input | Yes | Yes (user-initiated fetch only) |
| CSP `script-src` | self + inline + recorder domains | self + inline only |
| CSP `connect-src` | `https:` (URL fetch + recorder) | `https:` only for URL fetch, or `'none'` if `--no-url` |
| Runs from `file://` / offline | — | Yes |

The analytics loader lives in a single module (`src/telemetry/`) that is excluded by a build flag (`import.meta.env.STRICT`). A CI check greps the strict output for recorder domains and fails if any are found.

### Keeping session recording from leaking token data
Session replay tools record the DOM. Anything rendered as text or inline style can end up on their servers. Rules:

1. **Mask every user-data region.** Root containers that render file content get both `data-hj-suppress` (Hotjar) and `data-clarity-mask="true"` (Clarity). This covers token names, values, paths, file names, issue messages that quote values, the URL field and the diff view.
2. **Draw swatches, scale strips, curves and CVD previews on `<canvas>`.** Neither recorder captures canvas pixels, and CSS `background` colors (brand palettes) would otherwise be recorded as inline styles.
3. **Never put token data in DOM attributes, `title`, `aria-label` outside masked regions, the page title, or the URL/hash.**
4. **Consent first.** Recorders load only after the user agrees, which also covers GDPR. Declining is remembered.
5. **Custom events/tags carry only non-identifying counts** (e.g. "validation run: 12 errors"), never names or values.
6. A "What gets recorded?" panel explains the above and links to the strict build.

### Verify-it-yourself panel
Explains how to confirm no data leaves: DevTools → Network while loading a file, or run the strict build with Wi-Fi off.

---

## 1. Settings (global, persisted to `localStorage` — preferences only, never token data)

- **Color output format:** OKLCH | hex | rgb() — also used for export when "match display" is chosen.
- **Contrast compliance:** user picks one or more of:
  - WCAG 2.2 AA (4.5 text / 3.0 large text & UI)
  - WCAG 2.2 AAA (7.0 / 4.5)
  - APCA (Lc thresholds: 90 / 75 / 60 / 45 / 30 / 15 per use case)
  The selection drives pass marks, CVD checks and alias suggestions everywhere.
- **Accept legacy formats:** off by default (DTCG only). When on: Tokens Studio, Style Dictionary v3 and `value`/`type` files are accepted and normalized internally.
- **Gamut:** sRGB | Display P3 (P3 allowed, out-of-sRGB values flagged).
- **CVD severity:** 0–100% (default 100%).

---

## 2. Input

- Drop zone, file picker (multiple files) and URL field → `loadSource(text, origin)`.
- URL fetch: `fetch()` with clear CORS error help (e.g. "use the raw GitHub URL").
- JSON parse errors show line/column and a snippet.
- **Format detection:** DTCG vs. legacy. With the legacy toggle off, a legacy file is rejected with an explanation and a "turn on legacy support" button.
- **Multi-file and themes** (see §8): each file keeps its origin so export can write it back to the same place.

---

## 3. Token model

```
Token {
  path: string[]          // ["color","blue","500"]
  file: FileId
  type: TokenType         // resolved through group $type inheritance
  raw: unknown            // as written
  value: ResolvedValue    // after alias resolution (per theme)
  aliasOf?: string[]      // direct reference target
  description?, extensions?, deprecated?
  order: number           // original key order, preserved on export
  tier: 1 | 2 | 3         // auto-detected, user-overridable
}
```

- Original tree kept alongside the flat map so export keeps structure and key order.
- Resolves `{curly.aliases}` and `$ref` JSON pointers, `$extends`, `$root`.
- Detects circular references, missing targets and type mismatches.
- Parsed colors are held as Color.js objects. All manipulation happens in OKLCH.

---

## 4. DTCG compliance

Rules are checked against the DTCG 2025.10 stable format:

| Category | Checks |
|---|---|
| Structure | Names don't start with `$` and don't contain `{` `}` `.`; no node is both token and group; `$root`, `$extends` valid |
| Types | known `$type`; inherited correctly; every token resolves to a type |
| Values | color object `{colorSpace, components, alpha?, hex?}` (hex strings flagged legacy); `dimension {value, unit}`; duration; cubicBezier; fontWeight; composites (shadow, border, typography, gradient, transition, strokeStyle) |
| References | resolvable, non-circular, type-compatible |
| Metadata | `$description` string; `$extensions` reverse-domain keys; `$deprecated` bool/string |

Each issue has a severity (error, warning or info), a path, an explanation and a **suggested fix**. A fix is a small patch with a before/after preview. Users can apply one fix or all fixes in a category. Everything downstream runs on the fixed model.

Each rule is a pure function `(model) => Issue[]` in its own file, so rules are easy to test and to add.

---

## 5. Tier-1 color display

- **Tier detection:** tier 1 = color tokens with literal values; tier 2/3 = aliases. Group names (`primitive`, `base`, `core`, `global`, `ref`, `palette`) and file names add hints. The user can override.
- **Palette and step:** the parent group is the palette, the last segment is the step.
- **Ordering:** numeric steps (50–950, 1–12, 0–100) sort numerically; known word scales (`lightest`…`darkest`, t-shirt sizes) use their known order; anything else keeps file order and gets a flag.
- **Scale logic checks:** lightness inversions vs. step order, hue drift, near-duplicate steps (ΔE_OK), uneven L spacing, palettes whose step sets differ, out-of-sRGB (P3) flags.
- **Display:** one row per palette, canvas-drawn swatches, value in the chosen format, small L/C/H readouts. On screens without P3 support (`matchMedia('(color-gamut: p3)')`), P3 swatches are marked "shown clipped".

---

## 6. Contrast pass points (per selected compliance target)

- **Against light/dark ends:** white and black, or the system's own lightest/darkest neutral. Mark the first step that passes each level, e.g. "text on white from 600 up".
- **Within a scale:** for each step, the nearest step that passes each level, which reveals the system's "step distance" rule.
- **Across palettes:** does step N give the same contrast in every palette? Mismatches are flagged.
- Marks update live while the curve editor is in use.

---

## 7. Curve editor

- **Anchor:** pick a step as the anchor, or set or edit its color with a picker in OKLCH. The anchor is pinned and every curve passes through it.
- **Curves across steps:** L, C and H, each a spline with draggable handles (canvas + pointer events).
  - L presets: linear, ease-in/out, and **contrast-targeted** (solve L so chosen steps land exactly on the selected thresholds).
  - C: bell around the anchor, optionally clamped to the gamut maximum for each L in the active gamut.
  - H: a hue-shift curve.
- **Gamut:** in sRGB mode values are mapped with `toGamut` (CSS Color 4 method); in P3 mode out-of-sRGB values are kept and flagged.
- **Batch mode:** apply the same curves (absolute or relative to each palette's anchor) to selected palettes.
- **Live preview:** before/after strips, contrast marks, and the impact on semantic tokens in **every theme**.
- Undo/redo (command stack) and reset per palette.
- Only tier-1 values are written. Aliases follow automatically.

---

## 8. Themes

- **Sources:**
  1. Multiple files assigned to themes by the user (e.g. `semantic.light.json`, `semantic.dark.json`).
  2. Tokens Studio `$themes.json` (when legacy is on).
  3. DTCG Resolver module documents (sets + modifiers), as that spec stabilizes.
  4. Mode values in `$extensions` (e.g. Figma-style modes).
- **Theme matrix:** each theme gets its own resolved semantic layer over the shared primitives.
- **Theme switcher plus an "all themes" view:** contrast and CVD results are shown per theme, and a pair fails if it fails in any theme.
- **Suggestions are per theme:** a dark-theme alias fix doesn't touch light.

---

## 9. Semantic layer: CVD distinction and alias suggestions

- **Pair detection:** foreground/background pairs are inferred from naming (`bg`, `background`, `surface`, `fill`, `container` ↔ `fg`, `text`, `on-*`, `icon`, `border`, matched on shared modifiers such as `danger` or `subtle-hover`). An editable pairing table lets users fix or add pairs. Pairs are optionally saved to `$extensions["com.tokens-tester.pairs"]` so the next run needs no setup.
- **Sibling groups:** sets that must be told apart (success/warning/danger/info, chart series), auto-detected and editable.
- **Simulation (own module, since Color.js has no CVD):** Machado 2009 matrices for protan/deutan/tritan at the chosen severity, plus achromatopsia from luminance. Runs in linear sRGB.
- **Checks per theme × vision type:**
  1. Fg/bg contrast under simulation meets the selected compliance target.
  2. Sibling ΔE_OK under simulation is above a threshold (default 0.1, adjustable).
- **Alternative aliases:** search tier-1 for the candidate closest to the current target (ΔE_OK) that passes every check. Ranking prefers the same palette and the nearest step, then other palettes. Each suggestion shows the change and ΔE. Applying it rewrites the alias, never a raw value.

---

## 10. Export

- Rebuild the original tree(s) with the same key order, groups, `$extensions`, plus the applied changes (fixes, curve edits, alias changes).
- **Options:**
  - Color format: keep original | DTCG object in OKLCH (+ `hex` fallback) | DTCG object in sRGB | Display P3 where flagged.
  - Output: original multi-file split (zip, built locally) or one merged file.
  - Legacy input: export as DTCG (default) or back in the original legacy format.
  - Optional changelog under `$extensions`.
- A diff/summary view before download. Download via `Blob` + `URL.createObjectURL`.

---

## 11. Architecture (plain TypeScript, no framework)

- **Tooling:** Vite + TypeScript (build only) + `vite-plugin-singlefile` → one self-contained `index.html`. Color.js bundled, never loaded from a CDN. Zip export with a small bundled library (e.g. `fflate`).
- **State:** a tiny typed store (`createStore<State>()` with `subscribe`, `set`, `select`) plus a command stack for undo/redo. No reactive library.
- **UI:** native Custom Elements (`<tt-dropzone>`, `<tt-issues>`, `<tt-palette-row>`, `<tt-curve-editor>`, `<tt-pair-table>`, …) that render from store selections. Canvas for all color rendering.
- **Workers:** CVD and contrast scans move to a Web Worker if large files (thousands of tokens) feel slow. Start without one.

```
src/
  io/          load, detect format, url fetch, export, zip
  model/       parse, normalize legacy, resolve aliases, themes
  validate/    rules/*.ts, fixes
  color/       colorjs wrappers, contrast (WCAG/APCA), gamut, cvd
  scales/      palette detection, ordering, scale checks, curves
  semantic/    pairing, sibling groups, suggestions
  state/       store, commands (undo/redo), settings
  ui/          custom elements, canvas renderers, masking helpers
  telemetry/   consent + Hotjar/Clarity loader (excluded in strict build)
tests/fixtures/  dtcg-clean, dtcg-broken, tokens-studio, style-dictionary, multi-theme
```

- **Tests:** Vitest unit tests for rules, alias resolution, scale detection, CVD matrices and contrast math. A round-trip test: load → export with no edits gives an identical file. A strict-build CI check for recorder domains.

---

## 12. Milestones

1. **Foundation:** scaffold, store, input, model, alias resolution, export round-trip.
2. **Compliance:** DTCG rules + fixes; legacy toggle + normalizers.
3. **Palettes:** tier/scale detection, canvas display, format toggle, gamut/P3 flags.
4. **Contrast:** compliance selector, pass points, cross-palette parity.
5. **Themes:** theme sources, matrix, switcher.
6. **Curve editor:** anchor, L/C/H curves, batch, live contrast, undo/redo.
7. **Semantic CVD:** pairing table, simulation, checks, alias suggestions.
8. **Privacy and ship:** masking audit, consent, telemetry module, strict build + CI check, verify panel, README.

---

## Open questions
- Strict build: keep URL input (needs `connect-src https:`) or offer a `--no-url` variant with `connect-src 'none'`? Plan currently supports both via flag.
- Sibling distinction threshold: is ΔE_OK 0.1 a good default for your users?
- Hosting target for the public build (GitHub Pages, Netlify, other)? This affects how CSP is delivered (meta tag vs. headers).
