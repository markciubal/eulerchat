/**
 * Moving, zooming and orbiting a drawing by hand: one set of gestures for the
 * map and for All interests, the same with a mouse, a pen, a trackpad or
 * fingers.
 *
 *   one finger, or the mouse, dragged        moves it
 *   two fingers dragged                      orbit it: across turns it, up and
 *                                            down tilts it, twisted turns it
 *                                            (move it, where there is nothing
 *                                            to orbit: flat)
 *   two fingers pinched                      zooms
 *   right button, or Shift, dragged          orbits it, for a mouse, which has
 *                                            one pointer to do both with; the
 *                                            middle button moves it
 *   two fingers on a trackpad                scrolled, orbit it (flat, move
 *                                            it); pinched, zoom
 *   a mouse wheel                            zooms
 *   double tap or double click               zoom in, there (with Shift, out)
 *   two-finger tap                           zoom out
 *   a tap                                    whatever the drawing does with one
 *
 * Getting about is the thing done most, so it is the one finger; turning the
 * drawing to see behind something is the second hand's job, as it is on a
 * phone's maps.
 *
 * Two fingers are either orbiting or pinching, and which is decided once, a
 * little way into the gesture, from what they have done most: spread apart or
 * drawn together, it is a pinch; moved or twisted together, an orbit. Both at
 * once turned the map every time somebody pinched with one finger held still,
 * since that moves the point between them as far as it spreads them.
 *
 * Taps are handled here rather than left to `click`, for two reasons. A drag
 * ends in a click on whatever it let go of, which is not a choice of anything;
 * and on a phone a tap that opens a room also leaves the map, so the first tap
 * of a double tap would take somebody away before the second arrived. Where
 * that matters, a tap waits to be sure it is not the first of two
 * (`waitForDouble`). The `click` that follows any press handled here is
 * claimed (`claims`), so the drawing's own click handler can tell a press it
 * has already had from a click that came some other way — the keyboard, or a
 * test.
 */

/** How far a press may wander, in pixels, and still be a tap. */
const TAP_SLOP = 8;
/** How long, in milliseconds, between the two taps of a double tap. */
export const DOUBLE_GAP = 300;
/** How near, in pixels, the second tap of a double tap has to land. */
const DOUBLE_NEAR = 32;
/** Radians of turn and tilt per pixel dragged, when orbiting. */
const TURN_PER_PX = 0.008;
const TILT_PER_PX = 0.005;
/** How far two fingers may move and still be a tap. */
const TWO_TAP_TRAVEL = 20;
/**
 * How far two fingers move, between them, before it is decided what they are
 * doing: once both have moved, or one has gone twice this far with the other
 * held still. Fingers are reported one at a time, so straight after the first
 * of them moves, two fingers dragged together look exactly like a pinch.
 */
const DECIDE_AFTER = 20;
/** One mouse-wheel notch, as a zoom. */
const NOTCH = 1.18;
/** How long a run of wheel events from a trackpad is taken to be one gesture. */
const TRACKPAD_HOLD = 300;

/**
 * @param {Element} el
 * @param {object} hooks
 * @param {(dx: number, dy: number) => void} [hooks.pan]  in screen pixels
 * @param {(factor: number, clientX: number, clientY: number) => void} [hooks.zoom]
 * @param {(turn: number, tilt: number, anchor: [number, number] | null) => void} [hooks.orbit]
 *   radians; `anchor` is the screen point to keep still, or null for the middle
 * @param {() => boolean} [hooks.canOrbit]  whether there is anything to orbit
 * @param {(tap: {clientX: number, clientY: number, target: Element | null, pointerType: string}) => void} [hooks.tap]
 * @param {(tap: object) => boolean} [hooks.waitForDouble]  hold a tap back until it is sure to be single
 */
export function gestures(el, hooks = {}) {
  const pointers = new Map();
  let mode = null;
  let moved = 0;
  let pressTarget = null;
  let pressButton = 0;
  let two = null;
  let lastTap = null;
  let waiting = null;
  let claimedUntil = 0;
  let twoFingers = false;
  let trackpadUntil = 0;

  const now = () => Date.now();
  const canOrbit = () => Boolean(hooks.canOrbit?.());

  const pairOf = () => {
    const [a, b] = [...pointers.values()];
    return {
      mid: [(a.x + b.x) / 2, (a.y + b.y) / 2],
      dist: Math.hypot(b.x - a.x, b.y - a.y),
      angle: Math.atan2(b.y - a.y, b.x - a.x),
    };
  };

  /** How far round two fingers have twisted, the short way. */
  const twisted = (from, to) => {
    let turn = to - from;
    if (turn > Math.PI) turn -= Math.PI * 2;
    if (turn < -Math.PI) turn += Math.PI * 2;
    return turn;
  };

  /** Moved across and up, as a turn and a tilt: the front follows the hand round. */
  const orbitBy = (dx, dy, anchor) => hooks.orbit?.(-dx * TURN_PER_PX, -dy * TILT_PER_PX, anchor);

  el.addEventListener('pointerdown', (evt) => {
    if (evt.button > 2) return;
    if (!pointers.size) {
      moved = 0;
      twoFingers = false;
      pressTarget = evt.target ?? null;
      pressButton = evt.button ?? 0;
    }
    pointers.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });
    el.setPointerCapture?.(evt.pointerId);

    if (pointers.size === 1) {
      // A mouse's right button, or Shift, orbits it, where it can be orbited
      // at all; everything else moves it.
      const orbiting = (evt.button === 2 || (evt.button === 0 && evt.shiftKey)) && canOrbit();
      mode = orbiting ? 'orbit' : 'pan';
    } else if (pointers.size === 2) {
      twoFingers = true;
      const start = pairOf();
      two = { start, last: start, at: now(), travel: 0, movers: new Set() };
      // Flat, two fingers only ever move it and pinch it, so there is nothing
      // to decide between.
      mode = canOrbit() ? 'deciding' : 'getabout';
    }
  });

  el.addEventListener('pointermove', (evt) => {
    const p = pointers.get(evt.pointerId);
    if (!p) return;
    const dx = evt.clientX - p.x;
    const dy = evt.clientY - p.y;
    p.x = evt.clientX;
    p.y = evt.clientY;
    moved += Math.abs(dx) + Math.abs(dy);

    if (pointers.size === 1) {
      if (mode === 'orbit') orbitBy(dx, dy, null);
      else if (mode === 'pan') hooks.pan?.(dx, dy);
      return;
    }
    if (pointers.size !== 2 || !two) return;

    const next = pairOf();
    two.travel += Math.abs(dx) + Math.abs(dy);
    two.movers.add(evt.pointerId);
    if (mode === 'deciding') {
      const enough = two.travel >= DECIDE_AFTER && (two.movers.size === 2 || two.travel >= DECIDE_AFTER * 2);
      if (!enough) return;
      // Spread or drawn together more than moved or twisted: a pinch. The
      // twist counted as the distance the fingertips went round.
      const spread = Math.abs(next.dist - two.start.dist);
      const went = Math.hypot(next.mid[0] - two.start.mid[0], next.mid[1] - two.start.mid[1]);
      const round = (Math.abs(twisted(two.start.angle, next.angle)) * two.start.dist) / 2;
      mode = spread > went + round ? 'pinch' : 'orbit';
      // What they did while it was being decided counts too.
      two.last = two.start;
    }

    const last = two.last;
    two.last = next;
    if (mode === 'orbit') {
      // Moved together, it goes round as one finger's drag would take it;
      // twisted, it turns with them. About the point between them.
      orbitBy(next.mid[0] - last.mid[0], next.mid[1] - last.mid[1], next.mid);
      const twist = twisted(last.angle, next.angle);
      if (Math.abs(twist) > 1e-4) hooks.orbit?.(twist, 0, next.mid);
      return;
    }
    // A pinch zooms about the point between them; flat, they also move it.
    if (mode === 'getabout') hooks.pan?.(next.mid[0] - last.mid[0], next.mid[1] - last.mid[1]);
    if (last.dist > 0 && next.dist > 0) hooks.zoom?.(next.dist / last.dist, next.mid[0], next.mid[1]);
  });

  const end = (evt) => {
    if (!pointers.has(evt.pointerId)) return;
    const wasTwo = pointers.size === 2;
    const pair = wasTwo ? pairOf() : null;
    pointers.delete(evt.pointerId);
    el.releasePointerCapture?.(evt.pointerId);
    claimedUntil = now() + 600;

    if (wasTwo) {
      // Two fingers down and up again without going anywhere: zoom out.
      if (evt.type === 'pointerup' && two && now() - two.at < 300 && two.travel < TWO_TAP_TRAVEL) {
        hooks.zoom?.(0.5, pair.mid[0], pair.mid[1]);
      }
      two = null;
      // The finger still down does nothing until it is lifted too: taking
      // one finger off an orbit is not asking to start moving the map.
      mode = 'lifting';
      return;
    }
    if (pointers.size) return;

    // Only the plain press of a finger or the main button is a tap: the
    // other buttons are somebody turning the map, or reaching for a menu.
    const tapped = evt.type === 'pointerup' && !twoFingers && moved <= TAP_SLOP && pressButton === 0;
    mode = null;
    if (!tapped) {
      lastTap = null;
      return;
    }

    const tap = {
      clientX: evt.clientX,
      clientY: evt.clientY,
      target: pressTarget,
      pointerType: evt.pointerType ?? 'mouse',
      shiftKey: Boolean(evt.shiftKey),
    };
    const at = now();
    if (lastTap && at - lastTap.at < DOUBLE_GAP && Math.hypot(tap.clientX - lastTap.x, tap.clientY - lastTap.y) < DOUBLE_NEAR) {
      // The second of two: zoom, and the first — if it was held back —
      // never happens.
      clearTimeout(waiting);
      waiting = null;
      lastTap = null;
      zoomSmoothly(tap.shiftKey ? 0.5 : 2, tap.clientX, tap.clientY);
      return;
    }
    lastTap = { x: tap.clientX, y: tap.clientY, at };
    if (hooks.waitForDouble?.(tap)) {
      clearTimeout(waiting);
      waiting = setTimeout(() => {
        waiting = null;
        hooks.tap?.(tap);
      }, DOUBLE_GAP);
    } else {
      hooks.tap?.(tap);
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);

  // The right button turns it, so it does not also open the browser's menu.
  el.addEventListener('contextmenu', (evt) => evt.preventDefault());

  /**
   * The wheel, which is three different things. A trackpad pinch arrives as
   * a wheel with Ctrl held (every browser does this), and zooms. Two fingers
   * scrolled on a trackpad arrive as small, smooth, often sideways deltas,
   * and orbit it, as the same two fingers do on a screen — or move it, flat.
   * A mouse wheel arrives in whole notches, and zooms a notch at a time, as it
   * does on every other map. Which is which is guessed from the deltas, and a
   * trackpad, once recognised, is taken to be one for the rest of its run.
   */
  el.addEventListener(
    'wheel',
    (evt) => {
      evt.preventDefault();
      const unit = evt.deltaMode === 1 ? 16 : evt.deltaMode === 2 ? 400 : 1;
      const dx = evt.deltaX * unit;
      const dy = evt.deltaY * unit;
      if (evt.ctrlKey) {
        hooks.zoom?.(Math.exp(-dy * 0.01), evt.clientX, evt.clientY);
        return;
      }
      const smooth = evt.deltaMode === 0 && (evt.deltaX !== 0 || Math.abs(evt.deltaY) < 40);
      if (smooth || now() < trackpadUntil) {
        trackpadUntil = now() + TRACKPAD_HOLD;
        // A scroll's deltas go the opposite way to the fingers making it.
        if (canOrbit()) orbitBy(-dx, -dy, null);
        else hooks.pan?.(-dx, -dy);
        return;
      }
      if (dy) hooks.zoom?.(dy < 0 ? NOTCH : 1 / NOTCH, evt.clientX, evt.clientY);
    },
    { passive: false },
  );

  /**
   * A double tap's zoom, over a fifth of a second rather than at once, so the
   * eye can follow where it went. At once where there is no animation frame.
   */
  function zoomSmoothly(factor, x, y) {
    const frame = globalThis.requestAnimationFrame;
    if (!frame) {
      hooks.zoom?.(factor, x, y);
      return;
    }
    const steps = 8;
    const each = factor ** (1 / steps);
    let done = 0;
    const step = () => {
      hooks.zoom?.(each, x, y);
      if (++done < steps) frame(step);
    };
    frame(step);
  }

  return {
    /** Whether a `click` just now was the end of a press already handled here. */
    claims: () => now() < claimedUntil,
  };
}
