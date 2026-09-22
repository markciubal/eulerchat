import { NS, stroke } from './diagram.js';
import { fitTo } from './minimap.js';

/**
 * The explorer, played small on the buttons that open it.
 *
 * "Explore all interests" is a promise about a sheet most people have never
 * seen, and the words alone do not say what is on it or what can be done
 * there. So a pointer resting on either button gets a card that shows it:
 * every interest as a dot, a flight in to one neighbourhood where the names
 * come up, a pointer picking one, and on to somewhere else. It is the overview
 * the minimap already draws, so nothing is fetched to show it.
 *
 * Only for a pointer that can rest. The card says nothing a screen reader
 * needs — the button's own name is the whole of what pressing it does — so it
 * is hidden from them, and it never takes the pointer, so it cannot get
 * between somebody and whatever they were reaching for underneath it.
 */

/** How long a pointer rests on the button before the card comes, in ms. */
const REST = 350;

/** How much closer than the whole of it each stop on the tour is. */
const CLOSER = 4.5;

/** How much of the zoom the dots take part in; see `GROWTH` in the explorer. */
const GROWTH = 0.4;

/**
 * Sizes on the screen, in pixels. The dots' are at the whole view: a
 * thousand of them in a card this size, and any bigger they ran together
 * into one solid band.
 */
const FONT = 10;
const DOT = { least: 0.7, most: 3 };

/** How long one flight takes, in ms. */
const FLIGHT = 900;

/** Fewer interests than this and there is nowhere to go. */
const ENOUGH = 6;

/**
 * Where the tour stops: the interests this person holds first, then the
 * busiest, each far enough from the others that the next stop is somewhere
 * else and not the same neighbourhood again. Only the classified ones, since
 * the ring round the outside is everything nobody has placed yet, and there
 * are no neighbours there to name.
 *
 * @param {Array<{id: string, n: number, x: number, y: number, known?: boolean}>} subjects
 * @param {{held?: Set<string>, stops?: number, apart?: number}} [options]
 */
export function tourOf(subjects, { held = new Set(), stops = 3, apart = 0 } = {}) {
  const ranked = subjects
    .filter((s) => s.known !== false)
    .sort(
      (a, b) =>
        Number(held.has(b.id)) - Number(held.has(a.id)) || b.n - a.n || a.id.localeCompare(b.id),
    );
  const chosen = [];
  for (const s of ranked) {
    if (chosen.length >= stops) break;
    if (chosen.every((c) => Math.hypot(c.x - s.x, c.y - s.y) >= apart)) chosen.push(s);
  }
  return chosen;
}

/**
 * The names to write at one stop: the stop's own, then its busiest
 * neighbours, as many as fit inside the view without landing on each other.
 * Each name sits just above its dot, the way the explorer writes them.
 *
 * Widths are guessed from the length of the name, since nothing is measured
 * before it is drawn. The guess is generous, so two names it lets through are
 * two names that do not touch.
 *
 * @param {Array<{id: string, n: number, x: number, y: number}>} subjects
 * @param {{id: string, x: number, y: number}} at  the stop, always named
 * @param {{x: number, y: number, width: number, height: number}} view
 * @param {{font: number, radius?: (s: object) => number, most?: number}} options
 * @returns {Array<{id: string, x: number, y: number}>}  y is the baseline
 */
export function labelsNear(subjects, at, view, { font, radius = () => 0, most = 5 }) {
  const inside = (s) =>
    s.x > view.x && s.x < view.x + view.width && s.y > view.y && s.y < view.y + view.height;
  const ranked = subjects
    .filter((s) => s.id !== at.id && inside(s))
    .sort(
      (a, b) =>
        b.n - a.n || Math.hypot(a.x - at.x, a.y - at.y) - Math.hypot(b.x - at.x, b.y - at.y),
    );

  const placed = [];
  const boxes = [];
  for (const s of [at, ...ranked]) {
    if (placed.length >= most) break;
    const y = s.y - radius(s) - font * 0.35;
    const half = (s.id.length * font * 0.56) / 2;
    const box = { left: s.x - half, right: s.x + half, top: y - font * 0.9, bottom: y + font * 0.25 };
    const fits =
      box.left >= view.x &&
      box.right <= view.x + view.width &&
      box.top >= view.y &&
      box.bottom <= view.y + view.height;
    if (!fits && s !== at) continue;
    const hits = boxes.some(
      (b) => b.left < box.right && box.left < b.right && b.top < box.bottom && box.top < b.bottom,
    );
    if (hits) continue;
    boxes.push(box);
    placed.push({ id: s.id, x: s.x, y });
  }
  return placed;
}

/**
 * Run the card.
 *
 * @param {Document} doc
 * @param {object} hooks
 * @param {() => ({subjects: Array} | null)} hooks.overview  what the minimap draws
 * @param {() => Set<string>} hooks.held  interests held, as the catalogue names them
 */
export function mountPeek(doc, hooks) {
  const card = doc.getElementById('explore-peek');
  const svg = doc.getElementById('explore-peek-map');
  const say = doc.getElementById('explore-peek-say');
  if (!card || !svg || !say) return null;

  const win = doc.defaultView ?? globalThis;
  const now = () => win.performance?.now?.() ?? Date.now();
  const frame = (fn) => (win.requestAnimationFrame ? win.requestAnimationFrame(fn) : setTimeout(fn, 16));
  const calm = () => Boolean(win.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const el = (name, attrs = {}) => {
    const node = doc.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  };
  const size = () => {
    const box = svg.getBoundingClientRect?.();
    return box?.width ? box : { width: 232, height: 150 };
  };

  // What was drawn, and from what: drawn again only when either changes.
  let drawn = null;
  let drawnFor = '';
  let whole = null;
  let steps = [];
  let dots = null;
  let names = null;
  let ring = null;
  let cursor = null;
  let hand = null;
  const radii = new Map();

  let view = null;
  let at = null;
  let waiting = null;
  // Bumped to stop whatever is playing: every timer and frame checks it, so
  // a card hidden mid-flight does not carry on underneath.
  let run = 0;

  // --- the drawing -------------------------------------------------------------

  /** The whole sheet as a centre and a width, which is what a flight moves. */
  const centred = (box) => ({ cx: box.x + box.width / 2, cy: box.y + box.height / 2, width: box.width });

  /** A view as the box it covers, for the view it is and the one the names fit in. */
  function boxOf(v) {
    const { width, height } = size();
    const h = v.width * (height / width);
    return { x: v.cx - v.width / 2, y: v.cy - h / 2, width: v.width, height: h };
  }

  /** The share of their size on the sheet the dots are drawn at, at this view. */
  const growthAt = (v) => Math.min(1, (whole.width / v.width) ** (GROWTH - 1));

  function draw(overview, held) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const subjects = overview.subjects;
    whole = centred(fitTo(svg, subjects.map((s) => [s.x, s.y]), 10));
    const scale = size().width / whole.width;
    const biggest = Math.max(1, ...subjects.map((s) => s.n));

    // Area for how many hold it, as everywhere else. The radius is on the
    // sheet but chosen in pixels at the whole view; as it zooms, `--k` shrinks
    // it, once for all of them, so they draw apart instead of staying a knot.
    dots = el('g', { class: 'peek-dots' });
    radii.clear();
    for (const s of subjects) {
      const r = (DOT.least + Math.sqrt(s.n / biggest) * (DOT.most - DOT.least)) / scale;
      const dot = el('circle', { cx: s.x, cy: s.y, r: r.toFixed(2), fill: stroke(s.id) });
      if (held.has(s.id)) dot.classList.add('mine');
      dot.style.setProperty('--r', `${r.toFixed(2)}px`);
      dots.append(dot);
      radii.set(s.id, r);
    }

    names = el('g', { class: 'peek-names' });
    ring = el('circle', { class: 'peek-ring' });
    // The pointer that picks. The outer group is what glides, in sheet units;
    // the inner one puts the arrow's tip on the dot at a size in pixels.
    cursor = el('g', { class: 'peek-cursor' });
    hand = el('g');
    hand.append(el('path', { d: 'M0 0 L0 13 L3.4 9.9 L5.8 15.2 L8 14.2 L5.7 9 L10.2 9 Z' }));
    cursor.append(hand);
    svg.append(dots, ring, names, cursor);

    // All of it; in to the first stop, where the names come up and one is
    // picked; then across to the others. Then out again, and round.
    const tour = tourOf(subjects, { held, stops: 3, apart: whole.width * 0.25 });
    steps = [{ to: whole, say: 'Every interest, placed by subject', hold: 1300 }];
    tour.forEach((s, i) => {
      const to = { cx: s.x, cy: s.y, width: whole.width / CLOSER };
      steps.push({ to, stop: s, say: i === 0 ? 'Zoom in and the names appear' : 'Drag to look around', hold: 1500 });
      if (i === 0) steps.push({ pick: s, say: 'Pick one to join it', hold: 1900 });
    });
  }

  function look(v) {
    view = v;
    const box = boxOf(v);
    svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.width} ${box.height}`);
    dots.style.setProperty('--k', growthAt(v).toFixed(3));
  }

  /** Write the names at a stop, and bring them up. */
  function label(stop) {
    while (names.firstChild) names.removeChild(names.firstChild);
    const scale = size().width / view.width;
    const k = growthAt(view);
    const font = FONT / scale;
    const written = labelsNear(drawn.subjects, stop, boxOf(view), {
      font,
      radius: (s) => (radii.get(s.id) ?? 0) * k,
    });
    names.setAttribute('font-size', font.toFixed(2));
    names.setAttribute('stroke-width', (3 / scale).toFixed(2));
    for (const { id, x, y } of written) {
      const text = el('text', { x, y, 'data-id': id });
      text.textContent = id;
      names.append(text);
    }
    frame(() => names.classList.add('shown'));
  }

  /** The pointer glides in, and the dot it lands on is picked. */
  function pick(stop, gen) {
    const scale = size().width / view.width;
    const unit = 1 / scale;
    const r = (radii.get(stop.id) ?? 0) * growthAt(view);
    ring.setAttribute('cx', stop.x);
    ring.setAttribute('cy', stop.y);
    ring.setAttribute('r', (r + 3 * unit).toFixed(2));
    ring.setAttribute('stroke-width', (2 * unit).toFixed(2));

    hand.setAttribute('transform', `translate(${stop.x} ${stop.y}) scale(${unit.toFixed(4)})`);
    cursor.style.setProperty('--gx', `${(40 * unit).toFixed(2)}px`);
    cursor.style.setProperty('--gy', `${(30 * unit).toFixed(2)}px`);
    cursor.classList.add('shown');
    setTimeout(() => {
      if (gen !== run) return;
      ring.classList.add('pulsing');
      // Found by walking rather than by selector: a name is whatever somebody
      // typed, quotes and all.
      [...names.children].find((t) => t.getAttribute('data-id') === stop.id)?.classList.add('picked');
    }, calm() ? 0 : 650);
  }

  /** Put away whatever the last pick left out. */
  function settle() {
    cursor.classList.remove('shown');
    ring.classList.remove('pulsing');
    for (const text of names.querySelectorAll('.picked')) text.classList.remove('picked');
  }

  /**
   * From where it is to `to`. The width moves by ratio rather than by
   * difference, so a zoom reads as even all the way in, and a long way
   * across lifts out a little on the way, the way a map app does, so the
   * move reads as going somewhere else rather than as a smear.
   */
  function fly(to, gen, done) {
    const from = view;
    if (calm() || (from.cx === to.cx && from.cy === to.cy && from.width === to.width)) {
      look(to);
      done();
      return;
    }
    const start = now();
    const far = Math.hypot(to.cx - from.cx, to.cy - from.cy) / Math.max(from.width, to.width);
    const lift = Math.min(1.2, far * 0.35);
    const tick = () => {
      if (gen !== run) return;
      const t = Math.min(1, (now() - start) / FLIGHT);
      const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      look({
        cx: from.cx + (to.cx - from.cx) * e,
        cy: from.cy + (to.cy - from.cy) * e,
        width: from.width * (to.width / from.width) ** e * (1 + lift * Math.sin(Math.PI * e)),
      });
      if (t < 1) frame(tick);
      else done();
    };
    frame(tick);
  }

  function play(i, gen) {
    if (gen !== run) return;
    // The button went while the card was up — the View menu closed under it,
    // say — and the card would be left describing nothing.
    if (!at || at.isConnected === false || at.getClientRects?.().length === 0) {
      hide();
      return;
    }
    const step = steps[i % steps.length];
    const next = () => setTimeout(() => play(i + 1, gen), step.hold);
    say.textContent = step.say;
    settle();
    if (step.pick) {
      pick(step.pick, gen);
      next();
      return;
    }
    names.classList.remove('shown');
    fly(step.to, gen, () => {
      if (gen !== run) return;
      if (step.stop) label(step.stop);
      next();
    });
  }

  // --- showing it --------------------------------------------------------------

  /** Under the button, or over it where there is no room under; never off the page. */
  function place(button) {
    const b = button.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    const W = win.innerWidth || 1280;
    const H = win.innerHeight || 800;
    let top = b.bottom + 8;
    if (top + c.height > H - 8) top = Math.max(8, b.top - 8 - c.height);
    const left = Math.min(Math.max(8, b.left), W - c.width - 8);
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
  }

  function show(button) {
    const overview = hooks.overview();
    if (!overview?.subjects || overview.subjects.length < ENOUGH) return;
    at = button;
    // Shown before it is drawn: the drawing is framed to its own size, and
    // there is no size to frame to while it is hidden.
    card.hidden = false;
    place(button);
    const held = hooks.held();
    const key = [...held].sort().join('\n');
    if (overview !== drawn || key !== drawnFor) {
      drawn = overview;
      drawnFor = key;
      draw(overview, held);
    }
    run += 1;
    look(whole);
    // From the top, with nothing left over from the last time it was shown.
    names.classList.remove('shown');
    while (names.firstChild) names.removeChild(names.firstChild);
    play(0, run);
  }

  function hide() {
    clearTimeout(waiting);
    run += 1;
    at = null;
    card.hidden = true;
  }

  for (const button of doc.querySelectorAll('.explore-open')) {
    button.addEventListener('pointerenter', (evt) => {
      // A finger does not rest, and a press is already on its way in.
      if (evt.pointerType === 'touch') return;
      clearTimeout(waiting);
      waiting = setTimeout(() => show(button), REST);
    });
    button.addEventListener('pointerleave', hide);
    button.addEventListener('pointerdown', hide);
  }

  return {
    show,
    hide,
    get showing() {
      return !card.hidden;
    },
  };
}
