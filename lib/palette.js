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

/** The hash. Unchanged: every subject keeps the hue it has always had. */
function fnv(subject) {
  let h = 2166136261;
  for (let i = 0; i < String(subject).length; i++) {
    h ^= String(subject).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** Stable hue per subject, so a subject keeps its colour across reloads. */
export const hue = (subject) => fnv(subject) % 360;

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
const tierOf = (subject) => LUMINANCE[Math.floor(fnv(subject) / 360) % LUMINANCE.length];

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

function atLuminance(h, target, chroma = 0.13) {
  // Pure and deterministic, so remembering the answer is free. It is a search
  // rather than a formula, and a busy view asks for the same handful of
  // colours on every redraw.
  const asked = `${h.toFixed(2)}:${target.toFixed(4)}:${chroma.toFixed(4)}`;
  const known = solved.get(asked);
  if (known !== undefined) return known;

  const answer = solve(h, target, chroma);
  // A catalogue is capped well below this; the bound is only here so that a
  // pathological caller cannot grow it without limit.
  if (solved.size < 8192) solved.set(asked, answer);
  return answer;
}

function solve(h, target, chroma) {
  const rad = (h * Math.PI) / 180;

  for (let c = chroma; c >= 0; c -= 0.01) {
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

/** A subject's own colour: its hue, at the brightness its tier gives it. */
export const stroke = (subject) => atLuminance(hue(subject), tierOf(subject));

/**
 * The colour of a room.
 *
 * Darkens with the number of subjects, because a deeper overlap is a more
 * specific place and should read as one. Chroma is scaled by how much its
 * subjects agreed on a direction, so two opposite hues give a neutral rather
 * than a confident wrong answer.
 */
export const regionFill = (subjects) => {
  const list = [...subjects];
  const depth = Math.min(list.length, 4);
  return atLuminance(
    blend(list),
    Math.max(0.12, 0.3 - depth * 0.045),
    0.14 * coherence(list),
  );
};

/** SVG ids have to survive subject names like "film noir". */
export const cssId = (s) => String(s).replace(/[^a-z0-9]/gi, '_');

/** Text going into markup rather than into a DOM node. */
export const escape = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
