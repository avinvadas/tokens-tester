# Tokens Tester

A one-page, browser-only evaluator for design-token files. Load your tokens, check them against the [DTCG format](https://www.designtokens.org/), see your base colors as ordered palettes, and download a corrected file.

**The promise: your tokens never leave your browser.** Files are parsed, checked and edited on the page itself. Nothing is uploaded, stored or sent anywhere. The only network request the page makes is fetching a URL you type in yourself.

## What it does

- **Load** tokens by choosing files, dropping them on the page, or entering a URL (GitHub page links are converted to raw file links). Several files can be loaded together, such as primitives and semantic, and references resolve across them. **Reload files** reads them again after you edit them elsewhere.
- **Check DTCG compliance** (2025.10): structure, names, types, values, references (aliases and `$ref` pointers, cycles, typos), and metadata. Most issues come with a suggested fix and a before/after preview. Apply fixes one at a time or a whole category at once; every change can be undone.
- **Convert legacy formats** (optional): Tokens Studio and Style Dictionary v3 files are converted to DTCG on load, and can be downloaded as DTCG or back in their original format.
- **Show base colors** (tokens with their own color value) as ordered palettes, with checks on each scale: lightness inversions, near-duplicate steps, hue drift, uneven lightness gaps, missing steps, and colors outside the target gamut (sRGB or Display P3). Colors can be shown as OKLCH, hex or RGB.
- **Check contrast** against the compliance targets you choose (WCAG 2.2 AA, AAA, APCA): every base color is scored as text on a light end and a dark end (by default your own lightest and darkest neutral), with the passing range per scale, the step distance at which any two colors of a scale pass, and where palettes that share step names start passing at different steps.
- **Export** without noise: a file with no edits downloads byte-for-byte as it was loaded, and edits change only the lines they touch.

All color math uses OKLCH, through [Color.js](https://colorjs.io/).

### Coming next

Multiple themes, a curve editor for batch-editing scales around an anchor color, and color-vision-deficiency checks on semantic foreground/background pairs with suggested alternative aliases. See [PLAN.md](PLAN.md).

## Privacy

- The build is a single self-contained `index.html`. All scripts and styles are inlined, and a Content Security Policy blocks loading anything external.
- Settings saved in your browser hold only preferences (color format, target gamut, contrast targets, legacy support), never token data.
- Swatches are drawn on `<canvas>`, and every area showing file content is masked from usability-recording tools. Color values, names and structure stay out of recordings.
- **Check it yourself:** open your browser's developer tools, go to the Network tab, and load a file. Nothing is sent.
- **Full isolation:** clone this repository and run the strict build. It has no usability recording, and works offline from a file on disk.

## Run it

Requires Node.js 20 or later.

```bash
npm install
npm run dev            # development server at http://localhost:5173
npm test               # unit tests
npm run build          # hosted build → dist/index.html
npm run build:strict   # strict build → dist-strict/index.html (no usability recording; open it straight from disk, offline)
```

## Project layout

Plain TypeScript with native custom elements, no framework. Vite is used only to build.

```
src/json/      lossless JSON parser/serializer (keeps key order and formatting byte-for-byte)
src/model/     token model: collection, $type inheritance, $extends, alias and $ref resolution, Tokens Studio sets
src/validate/  DTCG 2025.10 rules (structure, types, values, references, metadata) with suggested fixes
src/legacy/    Tokens Studio / Style Dictionary v3 ↔ DTCG conversion
src/color/     Color.js bridge: DTCG colors, OKLCH analysis, display formats, gamut mapping
src/palette/   tier-1 detection, palettes and step order, scale checks
src/contrast/  WCAG 2.2 / APCA levels, pass ranges, step distance, cross-palette parity
src/state/     store, settings, undoable edits and fixes
src/io/        loading (file, drop, URL) and export
src/ui/        custom elements
tests/         Vitest suites and fixture token files
```
