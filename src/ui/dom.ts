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
