import './styles.css';
import { readDropped } from './io/load';
import { redo, store, undo } from './state/app';
import { TTFiles } from './ui/files';
import { TTIssues } from './ui/issues';
import { ingest, TTLoader } from './ui/loader';
import { TTPalettes } from './ui/palettes';
import { TTSettings } from './ui/settings';
import { TTThemes } from './ui/themes';
import { TTTokens } from './ui/tokens';
import { installTooltips } from './ui/tooltip';

customElements.define('tt-loader', TTLoader);
customElements.define('tt-files', TTFiles);
customElements.define('tt-issues', TTIssues);
customElements.define('tt-tokens', TTTokens);
customElements.define('tt-settings', TTSettings);
customElements.define('tt-palettes', TTPalettes);
customElements.define('tt-themes', TTThemes);
installTooltips();

store.select(
  (s) => s.files.length > 0,
  (has) => document.body.classList.toggle('has-files', has),
);

// Accept files dropped anywhere on the page.
const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;
let depth = 0;
document.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  depth++;
  document.body.classList.add('dragging');
});
document.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (--depth <= 0) {
    depth = 0;
    document.body.classList.remove('dragging');
  }
});
document.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
document.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  depth = 0;
  document.body.classList.remove('dragging');
  if (e.dataTransfer?.files.length) void ingest(readDropped(e.dataTransfer));
});

document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
  const el = e.target as HTMLElement | null;
  if (el?.closest('input, textarea, select, [contenteditable]')) return;
  e.preventDefault();
  if (e.shiftKey) redo();
  else undo();
});

const label = document.getElementById('build-label');
if (label) label.textContent = __STRICT__ ? 'Strict build: no usability recording, works offline.' : 'Hosted build.';
