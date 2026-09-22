/**
 * Wearing a scheme, and choosing one.
 *
 * `lib/scheme.js` knows what a scheme is and works out its colours; this is
 * the part with a page in it. It writes the answer onto the root element,
 * remembers the choice in this browser, and runs the sheet somebody chooses
 * from.
 *
 * Kept in this browser and sent nowhere. How somebody likes their screen is
 * nobody else's business, the server has no use for it, and a preference that
 * travelled would be one more thing that tells two visits apart.
 */

import { setPaper } from '../lib/palette.js';
import {
  HOUSE, PROPERTIES, SCHEMES, paperOf, readChoice, schemeNamed, styleOf, tidy, tokensOf, wheelOf,
} from '../lib/scheme.js';

/** Where the choice is kept. The script in the page's head reads it too. */
export const KEY = 'eulerchat.appearance';

/** What is being worn: `system`, a seeded id, or `custom` — and the recipe somebody made, if any. */
const choice = { scheme: 'system', recipe: null, custom: null };

/** Put a recipe on the page, or take whatever is there off again. */
function wear(recipe) {
  const root = document.documentElement;
  if (!root?.style) return;

  if (!recipe) {
    // Back to the stylesheet, which follows the system by itself.
    for (const property of PROPERTIES) root.style.removeProperty(property);
    setPaper(null);
    return;
  }
  for (const [property, value] of Object.entries(styleOf(recipe))) {
    root.style.setProperty(property, value);
  }
  // The subject colours are read against the panel, and the panel just moved.
  setPaper(paperOf(recipe));
}

/**
 * What is kept: the choice, and what the choice came to.
 *
 * `worn` is the finished answer, every property as it is written on the page.
 * It is not needed to know what somebody chose — the choice alone says that —
 * but this script arrives last, after everything it imports, and until it
 * runs the page is painted in the stylesheet's theme. Somebody who chose
 * `Black` on a light system saw a white page on every load. The script in the
 * page's head copies `worn` onto the page before anything is drawn, without
 * having to know how a scheme is worked out.
 */
function remember() {
  const worn = choice.recipe ? styleOf(choice.recipe) : null;
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: 1, scheme: choice.scheme, custom: choice.custom, worn }));
  } catch {
    /* a private window: the scheme lasts as long as the page, which is fine */
  }
}

/** Read the choice back, and wear it. Nothing is written. */
function load() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    /* unreadable: the system's own theme is a perfectly good answer */
  }
  Object.assign(choice, readChoice(saved));
  wear(choice.recipe);
  return saved;
}

/**
 * Wear whatever this browser wore last time.
 *
 * Called before anything is drawn, so the map's first frame already has its
 * colours solved against the right paper and nothing has to be drawn twice.
 *
 * The snapshot the head script paints from is brought up to date here if it
 * has fallen behind — `Sepia` retuned in a later version is still called
 * `sepia`, and the next load should not flash the old one before the new.
 */
export function restoreAppearance() {
  const saved = load();
  const worn = choice.recipe ? styleOf(choice.recipe) : null;
  if (saved && JSON.stringify(saved.worn ?? null) !== JSON.stringify(worn)) remember();
  return choice.scheme;
}

/** The name to say for what is being worn, after "Theme" in the header. */
function nameOf(scheme) {
  if (scheme === 'system') return 'System';
  if (scheme === 'custom') return 'Your own';
  return schemeNamed(scheme)?.name ?? '';
}

/**
 * The recipe the sliders show.
 *
 * With nothing chosen there is no recipe, but the sliders have to sit
 * somewhere — so they sit on the seeded scheme nearest the built-in theme in
 * force, and touching one starts from there instead of from nowhere.
 */
function shown() {
  if (choice.recipe) return choice.recipe;
  const dark = globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches;
  return schemeNamed(dark ? 'ink' : 'paper').recipe;
}

/** A scheme in miniature: a page, a panel on it, two lines of text and a button. */
function preview(doc, tokens, corners) {
  const page = doc.createElement('span');
  page.className = 'scheme-page';
  page.style.background = tokens.bg;

  const panel = doc.createElement('span');
  panel.className = 'scheme-panel';
  panel.style.background = tokens.panel;
  panel.style.borderColor = tokens.line;
  panel.style.borderRadius = `${Math.round(corners * 0.6)}px`;

  for (const [name, colour] of [['ink', tokens.ink], ['muted', tokens.muted], ['accent', tokens.accent]]) {
    const bar = doc.createElement('span');
    bar.className = `scheme-bar scheme-${name}`;
    bar.style.background = colour;
    if (name === 'accent') bar.style.borderRadius = corners < 4 ? `${corners}px` : '999px';
    panel.append(bar);
  }
  page.append(panel);
  return page;
}

/**
 * Run the sheet.
 *
 * `onChange` is called when the choice settles — a card pressed, a slider let
 * go — and not on every frame of a drag: the page recolours as the slider
 * moves because that is one write to the root element, but whoever is
 * listening is going to redraw a map.
 *
 * @param {Document} doc
 * @param {{onChange?: () => void}} [options]
 */
export function mountAppearance(doc, { onChange } = {}) {
  const $ = (id) => doc.getElementById(id);
  const sheet = $('appearance');
  const list = $('schemes');
  const form = $('adjust');
  // Every label that opens the sheet: the one in the header, and the one in
  // Settings for a header with no room for it. Found by what they control,
  // so a third needs no change here.
  const openers = [...doc.querySelectorAll('button[aria-controls="appearance"]')];
  if (!sheet || !list || !form || !openers.length) return;
  /** The one that opened the sheet, which is where focus goes back to. */
  let opener = openers[0];

  const cards = new Map();

  function card(id, name, build) {
    const li = doc.createElement('li');
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'scheme';
    const label = doc.createElement('span');
    label.className = 'scheme-name';
    label.textContent = name;
    button.append(build(), label);
    button.addEventListener('click', () => choose(id));
    li.append(button);
    cards.set(id, { li, button });
    return li;
  }

  function drawCards() {
    list.textContent = '';
    cards.clear();

    // First, and drawn as both of the things it can turn out to be.
    list.append(card('system', 'Match system', () => {
      const both = doc.createElement('span');
      both.className = 'scheme-both';
      both.append(preview(doc, HOUSE.light, 10), preview(doc, HOUSE.dark, 10));
      return both;
    }));

    if (choice.custom) {
      list.append(card('custom', 'Your own', () => preview(doc, tokensOf(choice.custom), choice.custom.corners)));
    }
    for (const scheme of SCHEMES) {
      list.append(card(scheme.id, scheme.name, () => preview(doc, tokensOf(scheme.recipe), scheme.recipe.corners)));
    }
    mark();
  }

  function mark() {
    for (const [id, { button }] of cards) {
      button.setAttribute('aria-pressed', String(id === choice.scheme));
    }
    for (const now of doc.querySelectorAll('.theme-now')) now.textContent = nameOf(choice.scheme);
  }

  /** Set the sliders to a recipe, and paint the two hue tracks with real answers. */
  function show(recipe) {
    for (const input of form.querySelectorAll('[name="mode"]')) input.checked = input.value === recipe.mode;
    for (const name of ['tint', 'wash', 'paper', 'accent', 'corners']) {
      const control = form.querySelector(`[name="${name}"]`);
      if (control) control.value = String(recipe[name]);
    }
    // By option rather than by `value`, which is not writable on a select
    // everywhere this has to run. Only the one that matches is touched:
    // choosing it unchooses the rest, and writing `false` to each of the
    // others is not reliably a no-op everywhere either.
    const face = [...form.querySelectorAll('[name="face"] option')].find((o) => o.value === recipe.face);
    if (face) face.selected = true;
    const strong = form.querySelector('[name="strong"]');
    if (strong) strong.checked = recipe.strong;

    const track = `linear-gradient(to right, ${wheelOf(recipe).join(', ')})`;
    for (const hue of form.querySelectorAll('.hue')) hue.style.background = track;
  }

  function choose(id) {
    if (id === 'custom' && !choice.custom) return;
    choice.scheme = id;
    choice.recipe = id === 'system' ? null : id === 'custom' ? choice.custom : schemeNamed(id).recipe;
    wear(choice.recipe);
    remember();
    show(shown());
    mark();
    onChange?.();
  }

  /** What the form says, as a recipe. */
  function read() {
    const value = (name) => form.querySelector(`[name="${name}"]`)?.value;
    // The properties, read one by one, rather than `:checked` and a select's
    // `value` — which are the same thing in a browser and are not in every
    // DOM this runs against.
    const picked = (selector) => [...form.querySelectorAll(selector)].find((n) => n.checked || n.selected)?.value;
    return tidy({
      mode: picked('[name="mode"]'),
      face: picked('[name="face"] option'),
      tint: value('tint'),
      wash: value('wash'),
      paper: value('paper'),
      accent: value('accent'),
      corners: value('corners'),
      strong: form.querySelector('[name="strong"]')?.checked === true,
    });
  }

  // Touching anything makes the scheme somebody's own. It starts from whatever
  // the sliders were showing, so adjusting `Sepia` is adjusting Sepia.
  function adjust(settled) {
    choice.custom = read();
    choice.scheme = 'custom';
    choice.recipe = choice.custom;
    wear(choice.recipe);
    if (!settled) return;

    remember();
    // The card for it appears the first time there is something to put on it,
    // and is redrawn after that because it is a picture of the recipe. Asked
    // of the list rather than of the recipe: a drag fires `input` before it
    // fires `change`, so by the time it settles there is always a recipe.
    const mine = cards.get('custom');
    if (mine) mine.li.replaceWith(card('custom', 'Your own', () => preview(doc, tokensOf(choice.custom), choice.custom.corners)));
    else drawCards();
    show(choice.custom);
    mark();
    onChange?.();
  }

  form.addEventListener('input', () => adjust(false));
  form.addEventListener('change', () => adjust(true));
  form.addEventListener('submit', (evt) => evt.preventDefault());

  const expanded = (open) => {
    for (const each of openers) each.setAttribute('aria-expanded', String(open && each === opener));
  };

  const close = () => {
    if (typeof sheet.close === 'function' && sheet.open) sheet.close();
    else sheet.removeAttribute('open');
    expanded(false);
    opener.focus?.();
  };

  expanded(false);
  for (const each of openers) {
    each.addEventListener('click', () => {
      opener = each;
      drawCards();
      show(shown());
      // Not `showModal`: a modal makes everything behind it inert and puts a
      // backdrop over it, and everything behind it is what is being chosen.
      if (typeof sheet.show === 'function') sheet.show();
      else sheet.setAttribute('open', '');
      expanded(true);
      cards.get(choice.scheme)?.button.focus?.();
    });
  }
  $('appearance-close')?.addEventListener('click', close);
  // A non-modal dialog does not get Escape for free.
  sheet.addEventListener('keydown', (evt) => {
    if (evt.key !== 'Escape') return;
    evt.preventDefault();
    close();
  });

  // Another tab chose something. Without this each tab wore whatever it last
  // read, and adjusting a slider in the stale one wrote its old `custom` over
  // the one just made in the other. Read, never written: two tabs running
  // different versions would otherwise answer each other forever.
  doc.defaultView?.addEventListener?.('storage', (evt) => {
    // A key of null is storage being cleared, which is a choice too.
    if (evt.key !== KEY && evt.key !== null) return;
    load();
    if (sheet.open || sheet.hasAttribute('open')) {
      drawCards();
      show(shown());
    }
    mark();
    onChange?.();
  });

  mark();
}
