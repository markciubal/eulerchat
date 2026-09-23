/**
 * A short tour of the place, for somebody who has just arrived.
 *
 * A ring goes round whatever is being talked about, and a card stands beside
 * it saying what it is. The arrow is the Tour button's own icon in the header:
 * it turns to face the pointer, wherever the pointer is, so the way in is a
 * little arrow watching the hand that might press it. Once the tour is running
 * it faces whatever the step is about instead, which is the same gesture doing
 * the thing it was drawn for.
 *
 * The aiming and the wiggle are two elements, one inside the other: the outer
 * one is turned, the inner one wiggles about its own middle. One element doing
 * both would have the animation fight the aim every frame.
 *
 * It points rather than blocks. Nothing is covered, nothing is made inert, and
 * every step is a thing that is really on the screen — a tour that talks about
 * a button somebody cannot see is a tour that is lying.
 */

/** How far the arrow swings round towards where it is looking, per frame. */
const EASE = 0.25;

/**
 * Which way the nib is drawn, as an offset applied to every aim.
 *
 * The path's tip is its top-left corner, so the arrow is drawn facing up and
 * to the left: a bearing of 225°, where this first assumed 315°. Half a turn
 * out, which is why it pointed away from what it was watching. Measured in a
 * browser rather than reasoned about — the tip lands within a degree of the
 * pointer at this value, and 90° off it at three quarters.
 */
const DRAWN_AT = 135;

/** The turn that stands the arrow straight up: a quarter turn from due east. */
const STRAIGHT_UP = DRAWN_AT - 90;

/** Where the card sits beside the ring, and how close it may come to an edge. */
const GAP = 14;
const MARGIN = 10;

/**
 * @param {Document} doc
 * @param {object} options
 * @param {Array<object> | (() => Array<object>)} options.steps  each `{at, title, say, before?}`;
 *   `at` finds what the step is about, each time it is shown, since the page
 *   moves under it, and `before` opens whatever has to be open for that to
 *   exist. A function is called as the tour starts, so what it shows can
 *   depend on what is on the screen by then.
 * @param {() => void} [options.opening]  called as it starts
 * @param {() => void} [options.done]  called when it is finished or stopped
 * @param {Element} [options.nib]  what turns to face things; the Tour button's
 *   own icon by default
 * @param {boolean} [options.watching=true]  whether the arrow follows the pointer
 *   while the tour is not running; see `watch`
 */
export function mountTour(doc, { steps, opening = () => {}, done = () => {}, nib = null, watching = true }) {
  const $ = (id) => doc.getElementById(id);
  const layer = $('tour');
  const ring = $('tour-ring');
  const arrow = nib ?? $('tour-nib');
  const card = $('tour-card');
  if (!layer || !ring || !arrow || !card) return null;

  const win = doc.defaultView;
  let walk = [];
  let at = -1;
  /** What the arrow faces: a point on the screen, or nothing to face yet. */
  let facing = null;
  let frame = null;
  /** Where it is turned now and where it is turning to, in degrees. */
  const aim = { turned: STRAIGHT_UP, want: STRAIGHT_UP };
  /** Whether it watches the pointer when it has nothing else to point at. */
  let watches = watching !== false;

  // Movement is a decision about somebody else's screen. Asked to keep still,
  // the arrow neither swings nor wiggles, and the tour is the same tour.
  const still = () => Boolean(win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  const boxOf = (el) => el?.getBoundingClientRect?.() ?? null;
  const middle = (box) => ({ x: box.left + box.width / 2, y: box.top + box.height / 2 });

  /**
   * Where the ring and the card have to live to be pressable.
   *
   * Everything outside an open modal dialog is inert, so a tour that talks
   * about All interests while All interests is open has to stand inside it or
   * be a picture of a tour.
   */
  // By the property rather than the attribute: a dialog opened with
  // `showModal` carries both, one opened by hand carries only the property,
  // and this has to be right in either.
  const host = () => [...doc.querySelectorAll('dialog')].filter((sheet) => sheet.open).at(-1) ?? doc.body;

  /** Draw the ring round what this step is about, and put the card beside it. */
  function place() {
    const step = walk[at];
    const target = step?.at?.() ?? null;
    const box = boxOf(target);
    const width = win?.innerWidth ?? 0;
    const height = win?.innerHeight ?? 0;

    if (!box || (!box.width && !box.height)) {
      // Nothing to point at — a button this screen does not have, say. The
      // card stands in the middle and says its piece anyway.
      ring.hidden = true;
      card.style.left = `${Math.max(MARGIN, width / 2 - (boxOf(card)?.width ?? 280) / 2)}px`;
      card.style.top = `${Math.max(MARGIN, height / 2 - (boxOf(card)?.height ?? 160) / 2)}px`;
      face(null);
      return;
    }

    ring.hidden = false;
    ring.style.left = `${box.left - 6}px`;
    ring.style.top = `${box.top - 6}px`;
    ring.style.width = `${box.width + 12}px`;
    ring.style.height = `${box.height + 12}px`;
    face(middle(box));

    // Under it where there is room, over it otherwise, and never off an edge.
    // Something as big as the whole map has no outside worth standing in, so
    // the card goes inside it, low down, where it covers the drawing rather
    // than the buttons along the top of it.
    const cardBox = boxOf(card) ?? { width: 280, height: 160 };
    const huge = box.height > height * 0.55;
    const below = box.bottom + GAP;
    const above = box.top - GAP - cardBox.height;
    const top = huge
      ? Math.max(MARGIN, box.bottom - cardBox.height - GAP * 3)
      : below + cardBox.height < height - MARGIN
        ? below
        : Math.max(MARGIN, above);
    const left = Math.min(
      Math.max(MARGIN, box.left + box.width / 2 - cardBox.width / 2),
      Math.max(MARGIN, width - cardBox.width - MARGIN),
    );
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  /** Face a point on the screen, or nothing, and start turning that way. */
  function face(spot) {
    facing = spot;
    const from = boxOf(arrow);
    if (!from || !spot) return;
    const me = middle(from);
    point((Math.atan2(spot.y - me.y, spot.x - me.x) * 180) / Math.PI + DRAWN_AT);
  }

  /** Turn to a heading, the short way round, and stop there. */
  function point(want) {
    aim.want = want;
    // Never the long way to get next door.
    while (aim.want - aim.turned > 180) aim.turned += 360;
    while (aim.turned - aim.want > 180) aim.turned -= 360;
    if (still()) {
      aim.turned = aim.want;
      draw();
      return;
    }
    ask();
  }

  /**
   * Whether the arrow watches the pointer when the tour is not running.
   *
   * Somebody who has pressed the button has been asked; an arrow that goes on
   * following their hand after that is a shop assistant who will not leave
   * them alone. Off, it stands straight up and stays there — still a cursor,
   * still wiggling, no longer watching. The page remembers which it is, and
   * pressing the button again brings it back.
   */
  function watch(on) {
    watches = Boolean(on);
    if (!watches) {
      facing = null;
      point(STRAIGHT_UP);
    }
  }

  const draw = () => {
    arrow.style.transform = `rotate(${aim.turned.toFixed(1)}deg)`;
  };

  /** One frame of the swing. */
  function swing() {
    frame = null;
    aim.turned += (aim.want - aim.turned) * EASE;
    draw();
    if (Math.abs(aim.want - aim.turned) > 0.2) ask();
  }

  function ask() {
    if (frame !== null) return;
    frame = win?.requestAnimationFrame ? win.requestAnimationFrame(swing) : null;
    if (frame === null) swing();
  }

  /**
   * The pointer moved. Off duty that is what the arrow watches — the button
   * looking at the hand that might press it. On the tour it has something to
   * point at already, and following the hand as well would be a compass that
   * cannot make its mind up.
   */
  function follow(evt) {
    if (!layer.hidden || !watches) return;
    face({ x: evt.clientX, y: evt.clientY });
  }

  function show(next) {
    at = Math.max(0, Math.min(walk.length - 1, next));
    const current = walk[at];
    current.before?.();
    // A step may have opened a modal dialog, and everything outside one is
    // inert: the tour goes inside whatever is open, or back to the page.
    const where = host();
    if (layer.parentElement !== where) where.append(layer);
    $('tour-step').textContent = `${at + 1} of ${walk.length}`;
    $('tour-title').textContent = current.title;
    $('tour-say').textContent = current.say;
    $('tour-back').disabled = at === 0;
    $('tour-next').textContent = at === walk.length - 1 ? 'Done' : 'Next';
    // Measured after the words are in, or the card is placed by its last size.
    place();
    card.focus?.({ preventScroll: true });
  }

  function start() {
    walk = (typeof steps === 'function' ? steps() : steps) ?? [];
    if (!walk.length) return;
    opening();
    layer.hidden = false;
    win?.addEventListener('resize', place);
    win?.addEventListener('scroll', place, true);
    doc.addEventListener('keydown', onKey);
    show(0);
  }

  function stop() {
    if (layer.hidden) return;
    layer.hidden = true;
    win?.removeEventListener('resize', place);
    win?.removeEventListener('scroll', place, true);
    doc.removeEventListener('keydown', onKey);
    if (frame !== null) win?.cancelAnimationFrame?.(frame);
    frame = null;
    at = -1;
    walk = [];
    if (layer.parentElement !== doc.body) doc.body.append(layer);
    // Back to watching the pointer, or back to standing up straight.
    if (!watches) point(STRAIGHT_UP);
    done();
  }

  function onKey(evt) {
    if (evt.key === 'Escape') {
      evt.preventDefault();
      stop();
    } else if (evt.key === 'ArrowRight') {
      onwards();
    } else if (evt.key === 'ArrowLeft') {
      show(at - 1);
    }
  }

  const onwards = () => (at >= walk.length - 1 ? stop() : show(at + 1));

  $('tour-next').addEventListener('click', onwards);
  $('tour-back').addEventListener('click', () => show(at - 1));
  $('tour-stop').addEventListener('click', stop);
  doc.addEventListener('pointermove', follow);
  // Standing up straight to begin with, rather than with no turn written at
  // all: where it is pointing should be a thing the page can be asked.
  draw();

  return {
    start,
    stop,
    watch,
    get watching() {
      return watches;
    },
    get isOn() {
      return !layer.hidden;
    },
    get at() {
      return at;
    },
    /** Which way the arrow is turned, in degrees. */
    get turned() {
      return aim.turned;
    },
  };
}
