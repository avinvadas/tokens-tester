import type { ColorInfo, Gamut } from '../color/format';
import { paintAll, swatchCanvas } from './canvas';
import { h, icon, masked } from './dom';

/**
 * A single-choice list whose options lead with a color thumbnail, which a
 * native <select> cannot show. The button shows the chosen option; the list
 * opens as a popover under it. Keyboard: Enter, Space or the arrows open it;
 * the arrows, Home and End move; Enter or Space picks; Escape closes.
 */

export interface SwatchOption {
  value: string;
  label: string;
  /** Secondary text after the label, such as a lightness. */
  meta?: string;
  info: ColorInfo;
  disabled?: boolean;
}

export interface SwatchGroup {
  label: string;
  options: SwatchOption[];
}

export function swatchSelect(opts: {
  label: string;
  groups: SwatchGroup[];
  value: string;
  gamut: Gamut;
  /** Shown on the button when no option matches `value`. */
  fallback?: { label: string; info: ColorInfo };
  onPick: (value: string) => void;
}): HTMLElement {
  const all = opts.groups.flatMap((g) => g.options);
  const chosen = all.find((o) => o.value === opts.value);
  const shown = chosen ?? opts.fallback;
  const empty = !all.length;

  const face = (o: { label: string; meta?: string; info: ColorInfo }) => [
    swatchCanvas(o.info, opts.gamut, false),
    h('span', { class: 'ss-label' }, o.label),
    o.meta ? h('span', { class: 'ss-meta' }, o.meta) : null,
  ];

  const id = `ss-${Math.random().toString(36).slice(2, 8)}`;
  const button = h(
    'button',
    { type: 'button', class: 'ss-button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-controls': id, 'aria-label': opts.label, disabled: empty },
    shown ? face(shown) : null,
    empty ? null : h('span', { class: 'ss-chevron', 'aria-hidden': 'true' }, icon('chevron-down')),
  ) as HTMLButtonElement;

  const items: HTMLElement[] = [];
  const list = h(
    'div',
    { id, class: 'ss-list', role: 'listbox', 'aria-label': opts.label, popover: 'auto', tabindex: '-1' },
    opts.groups.map((g) =>
      h(
        'div',
        { role: 'group', 'aria-label': g.label, class: 'ss-group' },
        h('div', { class: 'ss-group-label', 'aria-hidden': 'true' }, g.label),
        g.options.map((o) => {
          const el = h(
            'div',
            {
              role: 'option',
              class: 'ss-option',
              tabindex: '-1',
              'data-value': o.value,
              'aria-selected': String(o.value === opts.value),
              'aria-disabled': o.disabled ? 'true' : null,
            },
            face(o),
          );
          if (!o.disabled) {
            el.addEventListener('click', () => pick(o.value));
            items.push(el);
          }
          return el;
        }),
      ),
    ),
  );

  function pick(value: string) {
    list.hidePopover();
    button.focus();
    if (value === opts.value) return;
    opts.onPick(value);
    // Picking redraws the controls; keep focus on this control's new button.
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`.ss-button[aria-label="${CSS.escape(opts.label)}"]`)?.focus());
  }

  function open() {
    if (empty) return;
    list.showPopover();
  }

  function place() {
    const r = button.getBoundingClientRect();
    list.style.minWidth = `${r.width}px`;
    const below = window.innerHeight - r.bottom;
    const height = Math.min(list.scrollHeight, 320);
    const top = below >= height + 8 || below >= r.top ? r.bottom + 4 : r.top - 4 - height;
    list.style.top = `${Math.max(8, top)}px`;
    list.style.left = `${Math.min(r.left, window.innerWidth - list.offsetWidth - 8)}px`;
  }

  list.addEventListener('toggle', (e) => {
    const isOpen = (e as ToggleEvent).newState === 'open';
    button.setAttribute('aria-expanded', String(isOpen));
    if (!isOpen) return;
    place();
    paintAll(list);
    const current = items.find((el) => el.dataset.value === opts.value) ?? items[0];
    current?.focus();
    current?.scrollIntoView({ block: 'nearest' });
  });

  button.addEventListener('click', open);
  button.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
      e.preventDefault();
      open();
    }
  });
  list.addEventListener('keydown', (e) => {
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => {
      const el = items[Math.max(0, Math.min(items.length - 1, i))];
      el?.focus();
      el?.scrollIntoView({ block: 'nearest' });
    };
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if ((e.key === 'Enter' || e.key === ' ') && at >= 0) pick(items[at]!.dataset.value!);
    else if (e.key === 'Tab') list.hidePopover();
    else return;
    e.preventDefault();
  });

  return h('span', { class: 'swatch-select' }, masked(button), masked(list));
}
