/**
 * DOM helpers. Token files are untrusted input, so nothing from them is ever
 * written as HTML: `h()` sets text with text nodes and attributes with
 * setAttribute, never innerHTML.
 */

export type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'value' && 'value' in el) (el as HTMLInputElement).value = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

/**
 * Exclude an element's content from usability recordings (Hotjar, Clarity).
 * Every region that shows anything from the user's files must be masked.
 */
export function masked<T extends HTMLElement>(el: T): T {
  el.setAttribute('data-hj-suppress', '');
  el.setAttribute('data-clarity-mask', 'true');
  return el;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Stroke icons (Tabler, MIT). Fixed markup, never built from file data. */
const ICONS = {
  eye: '<path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0"/><path d="M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6"/>',
  'eye-off':
    '<path d="M10.585 10.587a2 2 0 0 0 2.829 2.828"/><path d="M16.681 16.673a8.717 8.717 0 0 1 -4.681 1.327c-3.6 0 -6.6 -2 -9 -6c1.272 -2.12 2.712 -3.678 4.32 -4.674m2.86 -1.146a9.055 9.055 0 0 1 1.82 -.18c3.6 0 6.6 2 9 6c-.666 1.11 -1.379 2.067 -2.138 2.87"/><path d="M3 3l18 18"/>',
  pin: '<path d="M15 4.5l-4 4l-4 1.5l-1.5 1.5l7 7l1.5 -1.5l1.5 -4l4 -4"/><path d="M9 15l-4.5 4.5"/><path d="M14.5 4l5.5 5.5"/>',
  curve: '<path d="M6.5 17.5c5 0 5 -11 11 -11"/><circle cx="4.5" cy="17.5" r="2"/><circle cx="19.5" cy="6.5" r="2"/>',
  'chevron-down': '<path d="M6 9l6 6l6 -6"/>',
} as const;

export function icon(name: keyof typeof ICONS): SVGSVGElement {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return t.content.firstElementChild as SVGSVGElement;
}
