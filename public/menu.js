/**
 * A menu of what can be done with whatever was pressed: opened by the right
 * button, a long press, or the keyboard's menu key, where the browser would
 * otherwise put its own.
 *
 * What is in it is up to whoever opens it, as sections of items, so the map,
 * the list of chats and All interests each say what they offer and anything
 * added later is one more section. It is a menu in the ARIA sense: the first
 * item has the focus, the arrows go up and down it, Escape shuts it and puts
 * the focus back where it was, and choosing anything shuts it before doing
 * that thing, so whatever it does can open something else.
 *
 * It shuts on its own when anything else is pressed, the page scrolls or
 * resizes, or the window loses the focus: a menu left floating over a map
 * that has moved under it names the wrong thing.
 */

const NS = 'http://www.w3.org/2000/svg';

/** How far, in pixels, it keeps from the edges of the window. */
const MARGIN = 8;

/**
 * @typedef {object} MenuItem
 * @property {string} label
 * @property {string} [detail]  a second, quieter line
 * @property {string} [icon]  a name in the page's icon sprite
 * @property {() => void} [run]
 * @property {boolean} [disabled]
 * @property {boolean} [checked]  for an item that is on or off
 *
 * @typedef {object} MenuSection
 * @property {string} [heading]
 * @property {MenuItem[]} items
 */

/**
 * @param {Document} [doc]
 */
export function contextMenu(doc = document) {
  let el = null;
  let returnTo = null;
  const win = doc.defaultView;

  const shutOutside = (evt) => {
    if (el && !el.contains(evt.target)) close({ restore: false });
  };
  const shutQuietly = () => close({ restore: false });

  function iconFor(name) {
    const svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const use = doc.createElementNS(NS, 'use');
    use.setAttribute('href', `#icon-${name}`);
    svg.append(use);
    return svg;
  }

  function itemFor(item) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'menu-item';
    b.tabIndex = -1;
    if (item.checked === undefined) b.setAttribute('role', 'menuitem');
    else {
      b.setAttribute('role', 'menuitemcheckbox');
      b.setAttribute('aria-checked', String(Boolean(item.checked)));
    }
    if (item.icon) b.append(iconFor(item.icon));
    const words = doc.createElement('span');
    words.className = 'menu-words';
    const label = doc.createElement('span');
    label.className = 'menu-label';
    label.textContent = item.label;
    words.append(label);
    if (item.detail) {
      const detail = doc.createElement('span');
      detail.className = 'menu-detail';
      detail.textContent = item.detail;
      words.append(detail);
    }
    b.append(words);
    if (item.disabled) {
      b.setAttribute('aria-disabled', 'true');
    } else {
      b.addEventListener('click', () => {
        close();
        item.run?.();
      });
    }
    return b;
  }

  const items = () => [...(el?.querySelectorAll('.menu-item') ?? [])];
  const usable = () => items().filter((b) => b.getAttribute('aria-disabled') !== 'true');

  function step(by) {
    const list = usable();
    if (!list.length) return;
    const at = list.indexOf(doc.activeElement);
    const next = at < 0 ? (by > 0 ? 0 : list.length - 1) : (at + by + list.length) % list.length;
    list[next].focus();
  }

  function onKey(evt) {
    const moves = { ArrowDown: 1, ArrowUp: -1 };
    if (evt.key in moves) {
      evt.preventDefault();
      step(moves[evt.key]);
    } else if (evt.key === 'Home' || evt.key === 'End') {
      evt.preventDefault();
      const list = usable();
      list[evt.key === 'Home' ? 0 : list.length - 1]?.focus();
    } else if (evt.key === 'Escape') {
      evt.preventDefault();
      evt.stopPropagation();
      close();
    } else if (evt.key === 'Tab') {
      evt.preventDefault();
      close();
    }
  }

  /**
   * Open it at a point of the window, over everything.
   *
   * `within` is where it goes in the page: a modal dialog, when it is opened
   * from one, since everything outside an open modal dialog is inert and a
   * menu there could be seen and not pressed.
   *
   * @param {{x: number, y: number, title?: string, sections: MenuSection[], returnTo?: Element | null, within?: Element | null}} options
   */
  function open({ x, y, title = '', sections, returnTo: back = null, within = null }) {
    close({ restore: false });
    const filled = sections.filter((s) => s.items.length);
    if (!filled.length) return;
    returnTo = back ?? doc.activeElement;

    el = doc.createElement('div');
    el.className = 'context-menu';
    el.setAttribute('role', 'menu');
    el.tabIndex = -1;
    if (title) el.setAttribute('aria-label', title);
    if (title) {
      const head = doc.createElement('p');
      head.className = 'menu-title';
      head.setAttribute('role', 'presentation');
      head.textContent = title;
      el.append(head);
    }
    for (const section of filled) {
      const group = doc.createElement('div');
      group.className = 'menu-section';
      group.setAttribute('role', 'group');
      if (section.heading) {
        group.setAttribute('aria-label', section.heading);
        const heading = doc.createElement('p');
        heading.className = 'menu-heading';
        heading.setAttribute('role', 'presentation');
        heading.textContent = section.heading;
        group.append(heading);
      }
      for (const item of section.items) group.append(itemFor(item));
      el.append(group);
    }
    el.addEventListener('keydown', onKey);
    // Its own presses are its own: none of them reach the map beneath.
    el.addEventListener('contextmenu', (evt) => evt.preventDefault());
    (within ?? doc.body).append(el);
    place(x, y);

    doc.addEventListener('pointerdown', shutOutside, true);
    win?.addEventListener('resize', shutQuietly);
    win?.addEventListener('blur', shutQuietly);
    doc.addEventListener('scroll', shutQuietly, true);
    doc.addEventListener('wheel', shutOutside, { capture: true, passive: true });
    (usable()[0] ?? el).focus();
  }

  /** Where it goes: at the point, or turned back from any edge it would cross. */
  function place(x, y) {
    const width = win?.innerWidth ?? 0;
    const height = win?.innerHeight ?? 0;
    const box = el.getBoundingClientRect?.() ?? { width: 0, height: 0 };
    let left = x;
    let top = y;
    if (width && left + box.width > width - MARGIN) left = Math.max(MARGIN, x - box.width);
    if (height && top + box.height > height - MARGIN) top = Math.max(MARGIN, Math.min(y - box.height, height - box.height - MARGIN));
    el.style.left = `${Math.max(MARGIN, left)}px`;
    el.style.top = `${Math.max(MARGIN, top)}px`;
  }

  function close({ restore = true } = {}) {
    if (!el) return;
    doc.removeEventListener('pointerdown', shutOutside, true);
    win?.removeEventListener('resize', shutQuietly);
    win?.removeEventListener('blur', shutQuietly);
    doc.removeEventListener('scroll', shutQuietly, true);
    doc.removeEventListener('wheel', shutOutside, { capture: true });
    el.remove();
    el = null;
    if (restore) returnTo?.focus?.();
    returnTo = null;
  }

  return {
    open,
    close,
    get isOpen() {
      return Boolean(el);
    },
    get element() {
      return el;
    },
  };
}
