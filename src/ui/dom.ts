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
  'pin-filled':
    '<path d="M15.113 3.21l.094 .083l5.5 5.5a1 1 0 0 1 -1.175 1.59l-3.172 3.171l-1.424 3.797a1 1 0 0 1 -.158 .277l-.07 .08l-1.5 1.5a1 1 0 0 1 -1.32 .082l-.095 -.083l-2.793 -2.792l-3.793 3.792a1 1 0 0 1 -1.497 -1.32l.083 -.094l3.792 -3.793l-2.792 -2.793a1 1 0 0 1 -.083 -1.32l.083 -.094l1.5 -1.5a1 1 0 0 1 .258 -.187l.098 -.042l3.796 -1.425l3.171 -3.17a1 1 0 0 1 1.497 -1.26z"/>',
  curve: '<path d="M6.5 17.5c5 0 5 -11 11 -11"/><circle cx="4.5" cy="17.5" r="2"/><circle cx="19.5" cy="6.5" r="2"/>',
  'chevron-down': '<path d="M6 9l6 6l6 -6"/>',
  copy: '<path d="M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667z"/><path d="M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1"/>',
  check: '<path d="M5 12l5 5l10 -10"/>',
} as const;

export function icon(name: keyof typeof ICONS): SVGSVGElement {
  const t = document.createElement('template');
  // Filled variants are drawn as solid shapes, the rest as strokes.
  const paint = name.endsWith('-filled') ? 'fill="currentColor" stroke="none"' : 'fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"';
  t.innerHTML = `<svg class="icon" viewBox="0 0 24 24" width="16" height="16" ${paint} aria-hidden="true">${ICONS[name]}</svg>`;
  return t.content.firstElementChild as SVGSVGElement;
}

/**
 * A pin toggle: a filled pin at full strength when on, a faint outline when off. `label` names
 * the step (token data, so the caller keeps it inside masked content).
 */
export function pinButton(on: boolean, label: string, tip: string, onToggle: () => void): HTMLButtonElement {
  const b = h(
    'button',
    { type: 'button', class: `pin-btn${on ? ' on' : ''}`, 'aria-pressed': String(on), 'aria-label': `${on ? 'Unpin' : 'Pin'} ${label}`, 'data-tip': tip },
    icon(on ? 'pin-filled' : 'pin'),
  ) as HTMLButtonElement;
  // Inside rows that react to pointer and click themselves (scrub strips, copyable units).
  b.addEventListener('pointerdown', (e) => e.stopPropagation());
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onToggle();
  });
  return b;
}
