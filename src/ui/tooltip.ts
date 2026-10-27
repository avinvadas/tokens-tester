/**
 * Hover and focus tooltips for any element with a `data-tip` attribute.
 *
 * Tip text should be fixed explanatory wording (what an indicator means).
 * `data-tip` is a DOM attribute, so a tip that names tokens or values must sit
 * on a masked element; the bubble itself is always masked.
 *
 * One shared bubble is shown as a manual popover, so it sits in the top layer
 * and stays visible above the modal curve editor.
 */

import { masked } from './dom';

const SHOW_DELAY = 250;
const GAP = 8;

let bubble: HTMLDivElement | undefined;
let target: HTMLElement | undefined;
let timer: number | undefined;

function ensureBubble(): HTMLDivElement {
  if (bubble) return bubble;
  bubble = masked(document.createElement('div'));
  bubble.id = 'tt-tooltip';
  bubble.className = 'tooltip';
  bubble.setAttribute('role', 'tooltip');
  bubble.setAttribute('popover', 'manual');
  document.body.append(bubble);
  return bubble;
}

function tipTarget(e: Event): HTMLElement | undefined {
  const el = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-tip]') : null;
  return el && el.dataset.tip ? el : undefined;
}

function show(el: HTMLElement) {
  const b = ensureBubble();
  target = el;
  b.textContent = el.dataset.tip ?? '';
  // Re-show so the bubble is the newest top-layer element (above an open dialog).
  if (b.matches(':popover-open')) b.hidePopover();
  b.showPopover();
  el.setAttribute('aria-describedby', b.id);
  place(el, b);
}

function hide() {
  window.clearTimeout(timer);
  timer = undefined;
  target?.removeAttribute('aria-describedby');
  target = undefined;
  if (bubble?.matches(':popover-open')) bubble.hidePopover();
}

/** Above the element if there is room, otherwise below; kept inside the viewport. */
function place(el: HTMLElement, b: HTMLElement) {
  const r = el.getBoundingClientRect();
  const t = b.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  let top = r.top - t.height - GAP;
  if (top < GAP) top = r.bottom + GAP;
  const left = Math.min(Math.max(GAP, r.left + r.width / 2 - t.width / 2), vw - t.width - GAP);
  b.style.top = `${Math.round(top)}px`;
  b.style.left = `${Math.round(left)}px`;
}

export function installTooltips() {
  document.addEventListener('pointerover', (e) => {
    const el = tipTarget(e);
    if (el === target) return;
    hide();
    if (!el) return;
    target = el;
    timer = window.setTimeout(() => el.isConnected && show(el), SHOW_DELAY);
  });
  document.addEventListener('pointerout', (e) => {
    const to = e.relatedTarget instanceof Element ? e.relatedTarget.closest('[data-tip]') : null;
    if (target && to !== target) hide();
  });
  document.addEventListener('focusin', (e) => {
    const el = tipTarget(e);
    if (el && el.matches(':focus-visible')) show(el);
    else hide();
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('pointerdown', hide);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && target) hide();
  });
  window.addEventListener('scroll', hide, true);
}
