/**
 * Colour, with no DOM in it.
 *
 * Lived in the browser bundle until the SVG writer needed the same hues; two
 * copies of "what colour is philosophy" is two answers waiting to disagree.
 *
 * Two properties are load-bearing and everything here is built around them.
 *
 * DETERMINISM. The same subject name gives the same colour on every reload,
 * in every view, on the server and in the browser. The map is meant to be a
 * place people build a memory of, so a scheme that picked colours to
 * maximise contrast among whatever is currently on screen - the obvious way
 * to kill collisions outright - is exactly wrong: a subject would change
 * colour as its neighbours came and went.
 *
 * LEGIBILITY IN BOTH THEMES. Colours are emitted as hex, not as a CSS
 * `oklch()`, so that rasterisers and any consumer of `lib/svg.js` keep
 * working - and each one is solved to a fixed perceptual lightness rather
 * than a fixed HSL lightness, which is not the same thing at all. See
 * `LUMINANCE` below for why that matters.
 */

import { inner, label } from './cluster.js';

/**
 * The name a colour belongs to: the subject's own, not the group it is in.
 *
 * A group is a copy of the world outside it, and `kite-fox-9/art` is art. It
 * used to hash as a name of its own, so the same interest turned up in a
 * group wearing a stranger's colour — and a colour picked for art did nothing
 * for it.
 */
const own = (subject) => label(String(subject ?? ''));

/** The hash. Unchanged: every subject keeps the hue it has always had. */
function fnv(subject) {
  const text = own(subject);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/**
 * Colours somebody has picked by hand.
 *
 * Empty everywhere except in a browser where somebody has chosen one, and
 * that is the whole design: the server never sets one, so what it draws and
 * what it hands to anybody else is still the colour the name gives. A choice
 * made here is seen by the person who made it and by nobody else.
 *
 * It is a hue rather than a colour. Lightness is solved per hue so that every
 * subject reads at the same strength on both themes, and letting a hand-picked
 * colour set its own would be handing somebody the one control that can make
 * their map illegible.
 */
const chosen = new Map();

/** Pick a hue for a subject, or pass null to go back to the one it was given. */
export function setHue(subject, degrees) {
  const name = own(subject);
  if (degrees === null || degrees === undefined || !Number.isFinite(Number(degrees))) {
    chosen.delete(name);
    return null;
  }
  const wheel = ((Number(degrees) % 360) + 360) % 360;
  chosen.set(name, wheel);
  return wheel;
}

/** Every hue picked by hand, for whatever is keeping them. */
export const chosenHues = () => Object.fromEntries(chosen);

/** Whether this subject wears a colour somebody chose rather than the one it was given. */
export const isChosen = (subject) => chosen.has(own(subject));

/** Stable hue per subject, so a subject keeps its colour across reloads. */
export const hue = (subject) => chosen.get(own(subject)) ?? fnv(subject) % 360;

/** The hue a subject would have had, ignoring anything chosen for it. */
export const givenHue = (subject) => fnv(subject) % 360;

/**
 * How much light a colour throws, as a fraction, which is what decides
 * whether it can be seen against a background.
 *
 * A window rather than a value, because the two themes pull in opposite
 * directions: anything at or above 0.14 clears 3:1 against the dark panel,
 * and anything at or below 0.30 clears 3:1 against white. Every subject
 * colour is solved into that window, so one palette serves both themes and
 * neither needs a branch.
 *
 * The three steps are what separate two subjects that landed on neighbouring
 * hues. The hue wheel alone was not enough - a catalogue of a few hundred
 * names into 360 hues collides by the pigeonhole principle long before the
 * hash is at fault - so a second, independent slice of the same hash picks
 * one of these. Same input, same tier, forever.
 */
const LUMINANCE = [0.155, 0.215, 0.29];
let tiers = LUMINANCE;
const tierOf = (subject) => tiers[Math.floor(fnv(subject) / 360) % tiers.length];

/**
 * How dark a dark panel may be and still have the window above mean what it
 * says: the dimmest tier at 3:1 against it. The panel both built-in themes
 * draw the map on is inside this, and `scheme.js` holds every dark scheme to
 * it rather than moving the colours, because moving them up would cost the
 * white drawn on top of them the 3:1 it has.
 */
export const DARKEST_PAPER = (LUMINANCE[0] + 0.05) / 3 - 0.05;

/**
 * Say what the colours are being read against.
 *
 * The window was worked out against two papers, white and the dark panel, and
 * a person can now choose a third. A cream or a pale green throws less light
 * than white does, so the brightest tier stops clearing 3:1 against it — and
 * rather than forbid tinted paper, the tiers all come down together by exactly
 * as much as it takes. Hue is what says which subject is which and it does not
 * move; lightness was only ever there for legibility, and this is legibility.
 *
 * Like a hue picked by hand, this is set in a browser by the person looking
 * and nowhere else. The server never calls it, so what it draws is unchanged.
 *
 * @param {number|null} luminance  of the panel the map sits on; null for the built-in themes
 * @returns {number[]} the tiers now in force
 */
export function setPaper(luminance) {
  tiers = LUMINANCE;
  // A dark paper is held to `DARKEST_PAPER` by whoever made it; see above.
  if (!Number.isFinite(luminance) || luminance < 0.5) return tiers;

  const ceiling = (Math.min(1, luminance) + 0.05) / 3 - 0.05;
  const over = LUMINANCE[LUMINANCE.length - 1] - ceiling;
  if (over > 0) tiers = LUMINANCE.map((tier) => Math.round((tier - over) * 1e4) / 1e4);
  return tiers;
}

/** Circular mean, so an overlap is tinted by everything that forms it. */
export function blend(subjects) {
  let x = 0;
  let y = 0;
  for (const s of subjects) {
    const a = (hue(s) * Math.PI) / 180;
    x += Math.cos(a);
    y += Math.sin(a);
  }
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * How much agreement there was in that mean, from 0 to 1.
 *
 * A circular mean of two opposite hues is meaningless - the vectors cancel,
 * and the angle that comes out is whatever the rounding left behind. Art sits
 * at 306 degrees and philosophy at 122, so their "average" was 34: an orange
 * that neither of them is, and one that a genuinely orange third subject in
 * the same view would also wear. Measuring the agreement lets the answer say
 * how much it should be believed, and a room whose subjects point in opposite
 * directions resolves to a neutral instead of inventing a colour.
 */
export function coherence(subjects) {
  const list = [...subjects];
  if (!list.length) return 0;
  let x = 0;
  let y = 0;
  for (const s of list) {
    const a = (hue(s) * Math.PI) / 180;
    x += Math.cos(a);
    y += Math.sin(a);
  }
  return Math.hypot(x, y) / list.length;
}

// --- colour arithmetic ------------------------------------------------------
//
// OKLab to sRGB, and nothing else. About thirty lines of pure arithmetic so
// that this file keeps its promise of having no dependencies.

const srgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** OKLab to linear sRGB. The published matrices, unmodified. */
function oklabToLinear(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** What the eye gets, in the terms a contrast ratio is defined in. */
const luminanceOf = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const inGamut = (rgb) => rgb.every((c) => c >= -1e-4 && c <= 1 + 1e-4);

const hex = (rgb) =>
  `#${rgb
    .map((c) => Math.round(Math.min(1, Math.max(0, srgb(c))) * 255).toString(16).padStart(2, '0'))
    .join('')}`;

/**
 * The colour at this hue with this much light in it.
 *
 * Solved rather than stated. A fixed HSL lightness is not a fixed brightness:
 * `hsl(h 58% 47%)` ranges over a factor of seven in actual luminance as the
 * hue goes round, which is why yellow subjects washed out on the light theme
 * and blue ones disappeared on the dark one. Binary search on OKLab's
 * lightness gets the requested luminance at any hue; chroma then comes down
 * until the result is a colour a screen can actually show, which is what
 * keeps the vivid hues from clipping.
 */
const solved = new Map();

function atLuminance(h, target, chroma = 0.13, step = 0.01) {
  // Pure and deterministic, so remembering the answer is free. It is a search
  // rather than a formula, and a busy view asks for the same handful of
  // colours on every redraw.
  const asked = `${h.toFixed(2)}:${target.toFixed(5)}:${chroma.toFixed(4)}:${step}`;
  const known = solved.get(asked);
  if (known !== undefined) return known;

  const answer = solve(h, target, chroma, step);
  // A catalogue is capped well below this; the bound is only here so that a
  // pathological caller cannot grow it without limit.
  if (solved.size < 8192) solved.set(asked, answer);
  return answer;
}

function solve(h, target, chroma, step) {
  const rad = (h * Math.PI) / 180;

  for (let c = chroma; c >= 0; c -= step) {
    const a = Math.cos(rad) * c;
    const b = Math.sin(rad) * c;
    let lo = 0;
    let hi = 1;
    let rgb = null;

    // Luminance rises monotonically with L at a fixed chroma, so twenty
    // halvings put it well inside a rounding step of an 8-bit channel.
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      rgb = oklabToLinear(mid, a, b);
      if (luminanceOf(rgb) < target) lo = mid;
      else hi = mid;
    }
    if (rgb && inGamut(rgb)) return hex(rgb);
  }
  // Grey at the requested luminance: the one colour always available.
  const g = target <= 0.0031308 * 12.92 ? target / 12.92 : ((target + 0.055) / 1.055) ** 2.4;
  return hex([g, g, g]);
}

/**
 * The colour at a hue that throws exactly this much light, as hex.
 *
 * The same search every subject colour comes out of, for anything else that
 * wants a colour stated by what it has to be legible against rather than by
 * what it happens to look like — which is how `scheme.js` makes a whole
 * interface. `step` is how finely chroma gives way when the colour asked for
 * is one no screen can show; the tints on a near-white surface are small
 * enough that the default would step straight over them.
 */
export const colourAt = (h, target, chroma, step) => atLuminance(h, target, chroma, step);

/** How much light a `#rrggbb` throws, from 0 to 1. */
export function luminance(colour) {
  const text = String(colour).replace('#', '');
  const linear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return luminanceOf([0, 2, 4].map((at) => linear(parseInt(text.slice(at, at + 2), 16) / 255)));
}

/** The contrast ratio between two colours, from 1 to 21, whichever way round. */
export function contrast(a, b) {
  const [dim, bright] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (bright + 0.05) / (dim + 0.05);
}

/** A subject's own colour: its hue, at the brightness its tier gives it. */
export const stroke = (subject) => atLuminance(hue(subject), tierOf(subject));

/**
 * The colour of one of a numbered set — the communities All interests can be
 * coloured by; see `lib/communities.js`.
 *
 * A name's colour comes from its hash, which is right when the names have
 * nothing to do with each other and wrong here: two communities drawn side by
 * side want to look unalike, whatever they are called. So the hues are dealt
 * round the wheel by the golden angle, which keeps each as far as it can be
 * from the ones before it, and the tiers cycle underneath for the same reason
 * they do for subjects — the wheel alone runs out. Through the same window as
 * every other colour here, so both themes are served without a branch.
 */
export const communityColour = (n) => atLuminance((n * 137.508) % 360, tiers[n % tiers.length]);

/**
 * The colour of a room: vivid, and the same brightness whatever its hue.
 *
 * Saturation is high on purpose — a room is a place, and the fills are what
 * tell one apart from the next at a glance. Lightness is not fixed with it,
 * though, because a fixed HSL lightness is not a fixed brightness: at `L 50%`
 * a yellow throws seven times the light a blue does, which is why the yellow
 * subjects washed out on the light theme and the blue ones disappeared on the
 * dark one. The lightness is solved per hue instead, so every room reads at
 * the same strength and only the hue changes.
 *
 * Saturation falls away when a room's subjects point in opposite directions
 * on the wheel. Their circular mean is meaningless then — art at 306 degrees
 * and philosophy at 122 average to 34, an orange neither of them is — so
 * rather than state that vividly, the colour drains toward neutral in
 * proportion to how little its subjects agreed.
 */
export function regionFill(subjects) {
  // Without the group's own conversation, which is in every room inside the
  // group because it is what wraps them. Blended in, it tinted every room in
  // the group the same way, and art inside the group stopped looking like art.
  const list = inner(subjects);
  const agreement = coherence(list);
  const saturation = 0.3 + 0.62 * agreement;
  // A deeper overlap is a more specific place, and reads as one by sitting a
  // little darker than the rooms it is cut from.
  const depth = Math.min(list.length, 4);
  return hslAtLuminance(blend(list), saturation, Math.max(0.16, 0.34 - depth * 0.05));
}

/**
 * `hsl(h s% l%)` with the lightness solved so the result throws a given
 * amount of light, rather than stated and left to mean different things at
 * different hues.
 */
function hslAtLuminance(h, saturation, target) {
  const asked = `hsl:${h.toFixed(2)}:${saturation.toFixed(3)}:${target.toFixed(4)}`;
  const known = solved.get(asked);
  if (known !== undefined) return known;

  let lo = 0;
  let hi = 1;
  let out = '#000000';
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    const rgb = hslToLinear(h, saturation, mid);
    if (luminanceOf(rgb) < target) lo = mid;
    else hi = mid;
    out = hex(rgb);
  }
  if (solved.size < 8192) solved.set(asked, out);
  return out;
}

/** HSL to linear sRGB, so its luminance can be measured. */
function hslToLinear(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  // Undo the transfer function, because luminance is defined on linear light.
  const linear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return [linear(r + m), linear(g + m), linear(b + m)];
}

/** SVG ids have to survive subject names like "film noir". */
export const cssId = (s) => String(s).replace(/[^a-z0-9]/gi, '_');

/** Text going into markup rather than into a DOM node. */
export const escape = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
