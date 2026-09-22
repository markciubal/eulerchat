/**
 * What a subject is about, drawn.
 *
 * `glyph.js` argued against exactly this, and half of the argument was right.
 * A table of little pictures cannot answer for a catalogue anyone can add a
 * name to: the moment somebody creates a subject nobody has drawn, the scheme
 * has nothing to say. That is still true, and it is why the patterns stay.
 *
 * The half that was wrong is that it had to be one or the other. The catalogue
 * is not a flat list of names; it is a hierarchy, and the hierarchy has a
 * layer that is small, closed and already curated by hand — the divisions and
 * the fields beneath them. Ninety-four names. That is a table somebody can draw,
 * and everything below it inherits: `entomology` has no emblem of its own and
 * does not need one, because it sits under `biology` and wears that. A subject
 * the hierarchy has never heard of gets no emblem at all and falls through to
 * its pattern, which is the scheme that answers for every name and still does.
 *
 * What an emblem adds is the thing a pattern cannot: it says where you are.
 * Stripes and rings tell two subjects apart and tell you nothing about either.
 * A flask says chemistry before the label has been read, and a map whose
 * ground is sown with flasks here and hourglasses there reads the way a
 * printed map does, with its reeds for marsh and its little trees for forest —
 * area symbols are about the oldest trick cartography has.
 *
 * DRAWN, NOT LOADED. Every emblem is geometry in this file, in the same shape
 * vocabulary the pattern tiles use, on a 24-unit square. There is no image
 * file, no icon font and no emoji behind any of it, and the words-only rule
 * for what people say to each other is untouched.
 */

import { knowledge } from './knowledge.js';

const round = (n) => Math.round(n * 100) / 100;

// --- the vocabulary ---------------------------------------------------------
//
// The same shapes `tile` returns, so one function draws both. A `line` here is
// a stroked path rather than a segment, because most of these need a curve.

const WIDTH = 2;

const line = (d, width = WIDTH) => ({ shape: 'path', d, width });
const mass = (d) => ({ shape: 'path', d, solid: true });
const ring = (cx, cy, r, width = WIDTH) => ({ shape: 'circle', cx, cy, r, hollow: true, width });
const disc = (cx, cy, r) => ({ shape: 'circle', cx, cy, r });
const box = (x, y, w, h, rx = 0) => ({ shape: 'rect', x, y, w, h, rx });
const frame = (x, y, w, h, rx = 0, width = WIDTH) => ({
  shape: 'rect', x, y, w, h, rx, hollow: true, width,
});

/**
 * A circle as a sub-path. Masses are filled even-odd, so appending one of
 * these to a mass cuts a hole in it — which is how a die gets its pips when
 * the only ink is white.
 */
const hole = (cx, cy, r) =>
  `M${round(cx - r)} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;

/** A gear, because nobody should type sixty-four coordinates by hand. */
function cog(cx, cy, teeth, outer, root, bore) {
  const step = (Math.PI * 2) / teeth;
  const points = [];
  for (let i = 0; i < teeth; i++) {
    for (const [r, lean] of [[root, -0.27], [outer, -0.16], [outer, 0.16], [root, 0.27]]) {
      const a = (i + lean) * step - Math.PI / 2;
      points.push(`${round(cx + Math.cos(a) * r)} ${round(cy + Math.sin(a) * r)}`);
    }
  }
  return `M${points.join('L')}Z${hole(cx, cy, bore)}`;
}

/** A rectangle with bites out of every edge: the outline of a postage stamp. */
function perforated(x, y, w, h, across, down, r = 1) {
  const gapX = round((w - across * 2 * r) / (across + 1));
  const gapY = round((h - down * 2 * r) / (down + 1));
  // Travelling clockwise, sweep 0 turns the arc inward on every edge.
  const edge = (n, straight, bite) => `${`${straight}${bite}`.repeat(n)}${straight}`;
  return [
    `M${x} ${y}`,
    edge(across, `h${gapX}`, `a${r} ${r} 0 0 0 ${2 * r} 0`),
    edge(down, `v${gapY}`, `a${r} ${r} 0 0 0 0 ${2 * r}`),
    edge(across, `h${-gapX}`, `a${r} ${r} 0 0 0 ${-2 * r} 0`),
    edge(down, `v${-gapY}`, `a${r} ${r} 0 0 0 0 ${-2 * r}`),
    'Z',
  ].join('');
}

/** A star, or a burst: `points` tips at `outer`, the notches between at `inner`. */
function star(cx, cy, points, outer, inner) {
  const step = Math.PI / points;
  const corners = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 ? inner : outer;
    const a = i * step - Math.PI / 2;
    corners.push(`${round(cx + Math.cos(a) * r)} ${round(cy + Math.sin(a) * r)}`);
  }
  return `M${corners.join('L')}Z`;
}

/** A regular polygon, point upward. */
const polygon = (cx, cy, sides, r) => star(cx, cy, sides / 2, r, r);

/** A four-pointed spark, its sides drawn in toward the middle. */
function spark(cx, cy, r) {
  const k = r * 0.14;
  const tips = [[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]];
  const pulls = [[cx + k, cy - k], [cx + k, cy + k], [cx - k, cy + k], [cx - k, cy - k]];
  let d = `M${round(tips[0][0])} ${round(tips[0][1])}`;
  for (let i = 0; i < 4; i++) {
    const [from, to, pull] = [tips[i], tips[(i + 1) % 4], pulls[i]];
    // One pull per side, written as the cubic that draws the same curve.
    const a = [from[0] + ((pull[0] - from[0]) * 2) / 3, from[1] + ((pull[1] - from[1]) * 2) / 3];
    const b = [to[0] + ((pull[0] - to[0]) * 2) / 3, to[1] + ((pull[1] - to[1]) * 2) / 3];
    d += `C${round(a[0])} ${round(a[1])} ${round(b[0])} ${round(b[1])} ${round(to[0])} ${round(to[1])}`;
  }
  return `${d}Z`;
}

/** Short strokes from one circle out to another, one per side of a polygon. */
function spokes(cx, cy, count, from, to) {
  let d = '';
  for (let i = 0; i < count; i++) {
    const a = (i * Math.PI * 2) / count - Math.PI / 2;
    d += `M${round(cx + Math.cos(a) * from)} ${round(cy + Math.sin(a) * from)}`;
    d += `L${round(cx + Math.cos(a) * to)} ${round(cy + Math.sin(a) * to)}`;
  }
  return d;
}

// --- the emblems ------------------------------------------------------------

/**
 * One drawing per division and per field, on a 24 by 24 square.
 *
 * Bold on purpose. The commonest place one of these is seen is a square
 * eighteen pixels across, where a stroke of two units is a pixel and a half
 * and anything finer is a smudge — so each is a silhouette or a few heavy
 * lines, and detail that would not survive the rail was left out at the desk.
 */
export const EMBLEMS = {
  // --- the divisions -------------------------------------------------------

  // A quill.
  humanities: [
    line('M8.5 15.5C6.5 10 11.5 4 20 4C20 12.5 14 17.5 8.5 15.5Z'),
    line('M4 20L15 9'),
  ],

  // A painter's palette, thumb-hole and all.
  arts: [
    mass(
      `M12 3C6.5 3 2.5 7 2.5 12C2.5 17 6.5 21 11.5 21C13.6 21 14.1 19.6 13.4 18.2C12.6 16.6 13.6 15 15.5 15L18 15C20 15 21.5 13.5 21.5 11.5C21.5 6.5 17.5 3 12 3Z${
        hole(7.3, 11.2, 1.5)}${hole(10.6, 7, 1.5)}${hole(15.6, 7.6, 1.5)}${hole(8.4, 16, 1.5)}`,
    ),
  ],

  // Three people.
  'social sciences': [
    disc(12, 7.5, 3.2),
    mass('M5.8 20.5C5.8 15.6 8.4 13 12 13C15.6 13 18.2 15.6 18.2 20.5Z'),
    disc(4.6, 9.4, 2.1),
    disc(19.4, 9.4, 2.1),
    line('M1.6 18.6C1.6 16 2.8 14.4 4.6 13.9', 1.8),
    line('M22.4 18.6C22.4 16 21.2 14.4 19.4 13.9', 1.8),
  ],

  // A microscope.
  'natural sciences': [
    box(7.5, 3.5, 4.5, 10, 1.2),
    line('M6.5 3H13'),
    line('M13 21A6.5 6.5 0 0 0 13 8'),
    line('M5.5 16.5H13'),
    line('M4.5 21H19.5'),
  ],

  // A triangle inscribed in a circle: compass and straightedge.
  'formal sciences': [
    ring(12, 12, 9),
    line('M12 3L19.8 16.5L4.2 16.5Z', 1.8),
  ],

  // A light bulb.
  'applied sciences': [
    line('M9 16.5C9 14.5 6 13 6 9A6 6 0 0 1 18 9C18 13 15 14.5 15 16.5Z'),
    line('M9.5 19.5H14.5'),
    line('M10.8 22H13.2'),
  ],

  // A kite.
  hobbies: [
    line('M12 2.5L18.5 9L12 17.5L5.5 9Z'),
    line('M12 2.5V17.5M5.5 9H18.5', 1.4),
    line('M12 17.5C9 19 15 20.5 12 22.5', 1.6),
  ],

  // A trophy.
  sport: [
    mass('M7 3H17V9C17 12.3 14.8 14.5 12 14.5C9.2 14.5 7 12.3 7 9Z'),
    line('M7 5H4C4 8.5 5.2 10.2 7.6 10.6', 1.8),
    line('M17 5H20C20 8.5 18.8 10.2 16.4 10.6', 1.8),
    line('M12 14.5V18.5'),
    box(7.5, 18.5, 9, 2.6, 0.6),
  ],

  // The mark on a power button.
  technology: [
    line('M7.6 6.4A7.8 7.8 0 1 0 16.4 6.4'),
    line('M12 3V11.5'),
  ],

  // A ticket, torn along the dotted line.
  entertainment: [
    line('M3 6.5H21V10A2 2 0 0 0 21 14V17.5H3V14A2 2 0 0 0 3 10Z'),
    line('M15 8V9.6M15 11.2V12.8M15 14.4V16', 1.4),
  ],

  // The sun coming up on an ordinary day.
  lifestyle: [
    disc(12, 12, 4.2),
    line(spokes(12, 12, 8, 6.8, 9.6)),
  ],

  // A skyline.
  society: [
    box(3, 11, 5.5, 9.5),
    box(9.5, 4, 6, 16.5),
    box(16.5, 8.5, 4.5, 12),
    line('M2 21H22', 1.6),
  ],

  // --- humanities ----------------------------------------------------------

  // An hourglass, most of the way through.
  history: [
    line('M6 3H18M6 21H18'),
    line('M7.5 3C7.5 8.5 12 10 12 12C12 14 7.5 15.5 7.5 21'),
    line('M16.5 3C16.5 8.5 12 10 12 12C12 14 16.5 15.5 16.5 21'),
    mass('M8.6 20.2C9 17.6 11 16.6 12 15C13 16.6 15 17.6 15.4 20.2Z'),
  ],

  // The bust of a philosopher, bearded, on a plinth.
  philosophy: [
    mass(
      'M13.5 2C10.4 2 8.4 3.6 7.9 6L7.5 7.4L8 8L5.9 10.4L7.5 10.9L7.1 11.8C6.3 13 6.4 15.2 7.6 16.6C8.8 16.2 10 15.6 11 15.2V16.6C9 17.2 6.6 18 5.5 19.6H18.5C18.3 18.2 17.2 17 16.2 16.2V14.2C18 12.6 19.2 10.4 19.2 7.6C19.2 4.4 16.9 2 13.5 2Z',
    ),
    box(6.5, 20.5, 11, 2, 0.4),
  ],

  // An open book.
  literature: [
    line('M12 6.5C10 4.8 6.5 4.3 3 4.8V18.8C6.5 18.3 10 18.8 12 20.5C14 18.8 17.5 18.3 21 18.8V4.8C17.5 4.3 14 4.8 12 6.5Z'),
    line('M12 6.5V20.5'),
  ],

  // Speech, with a letter in it.
  linguistics: [
    line('M4.5 3.5H19.5A2 2 0 0 1 21.5 5.5V14.5A2 2 0 0 1 19.5 16.5H11L6.5 20.8V16.5H4.5A2 2 0 0 1 2.5 14.5V5.5A2 2 0 0 1 4.5 3.5Z'),
    line('M8.8 13.5L12 6.5L15.2 13.5M10 11.2H14', 1.8),
  ],

  // An amphora.
  archaeology: [
    mass(
      'M9.5 2.5H14.5V4.2H13.8V6.2C17 7.5 18 11 17 14C16.2 16.6 14 18.5 13.2 20.4H14.8V22H9.2V20.4H10.8C10 18.5 7.8 16.6 7 14C6 11 7 7.5 10.2 6.2V4.2H9.5Z',
    ),
    line('M10 5C6 4.6 4.6 8 6.8 10.8', 1.6),
    line('M14 5C18 4.6 19.4 8 17.2 10.8', 1.6),
  ],

  // The front of a temple.
  classics: [
    mass('M12 2.5L21.5 8.5H2.5Z'),
    line('M6 11V18M10 11V18M14 11V18M18 11V18'),
    line('M3 21H21', 2.4),
  ],

  // A candle. No tradition's own symbol, and at home in most of them.
  'religious studies': [
    mass('M12 2.5C14.2 5.2 15.2 6.6 15.2 8.1A3.2 3.2 0 0 1 8.8 8.1C8.8 6.6 9.8 5.2 12 2.5Z'),
    box(9.3, 12.5, 5.4, 8.5, 0.6),
    line('M6 21.5H18'),
  ],

  // Two people talking, one of them answering.
  languages: [
    line('M3.5 3.5H13.5A1.5 1.5 0 0 1 15 5V10.5A1.5 1.5 0 0 1 13.5 12H8L5 14.8V12H3.5A1.5 1.5 0 0 1 2 10.5V5A1.5 1.5 0 0 1 3.5 3.5Z', 1.8),
    mass('M11 13.6H16.6V9.5H20.5A1.5 1.5 0 0 1 22 11V17A1.5 1.5 0 0 1 20.5 18.5H19V21.3L16 18.5H12.5A1.5 1.5 0 0 1 11 17Z'),
  ],

  // --- arts ----------------------------------------------------------------

  // Picture frames, hung on a wall.
  'visual art': [
    frame(2.5, 6, 12, 14, 0.6),
    line('M5.5 6L8.5 2.8L11.5 6', 1.4),
    mass('M4.6 17.8L8 12.4L10.2 15.6L11.3 14.2L12.6 17.8Z'),
    disc(11, 10.2, 1.2),
    frame(17, 6, 5, 5, 0.4, 1.8),
    frame(17, 13.5, 5, 6.5, 0.4, 1.8),
  ],

  // Two quavers, beamed.
  music: [
    disc(6.8, 18, 3),
    disc(17, 16, 3),
    line('M8.8 18V6M19 16V4'),
    mass('M7.8 4.6L20 2.2V6.2L7.8 8.6Z'),
  ],

  // A mask.
  'performing arts': [
    mass(
      `M4.5 3.5H19.5V11C19.5 16.5 16.2 20.8 12 20.8C7.8 20.8 4.5 16.5 4.5 11Z${
        hole(8.8, 9, 1.7)}${hole(15.2, 9, 1.7)
      }M8 13.4C9.4 17.6 14.6 17.6 16 13.4C13.6 14.8 10.4 14.8 8 13.4Z`,
    ),
  ],

  // A clapperboard.
  film: [
    mass(
      'M2.8 6.4L7.73 5.34L6.57 8.72L3.4 9.4ZM9.84 4.88L13.71 4.04L12.55 7.42L8.68 8.26ZM15.82 3.59L20.4 2.6L21 5.6L14.66 6.97Z',
    ),
    frame(3, 11, 18, 10, 1.2),
    line('M3 14.5H21', 1.4),
  ],

  // A curve between two anchors, with its handles out.
  design: [
    line('M4.5 17.5C4.5 6 19.5 18 19.5 6.5'),
    line('M4.5 17.5V6.5M19.5 6.5V17.5', 1.2),
    box(2.7, 15.7, 3.6, 3.6),
    box(17.7, 4.7, 3.6, 3.6),
    disc(4.5, 5, 1.7),
    disc(19.5, 19, 1.7),
  ],

  // An arch.
  architecture: [
    line('M4 21V11A8 8 0 0 1 20 11V21'),
    line('M8.5 21V12A3.5 3.5 0 0 1 15.5 12V21'),
    line('M2 21.5H22'),
  ],

  // --- social sciences -----------------------------------------------------

  // A hand on a cave wall.
  anthropology: [
    box(7, 11, 10.4, 10, 3.4),
    line('M8.4 12V6.4M11.1 11V3.6M13.9 11V4.2M16.4 12V7', 2.5),
    line('M7.6 16.2L3.8 12.6', 2.5),
  ],

  // People, and what runs between them.
  sociology: [
    line('M12 5.5L5 18M12 5.5L19 18M5 18H19', 1.5),
    disc(12, 5.5, 3),
    disc(5, 18, 3),
    disc(19, 18, 3),
  ],

  // Psi.
  psychology: [
    line('M12 3V21'),
    line('M5 3.5C5 11.5 7 14 12 14C17 14 19 11.5 19 3.5'),
    line('M8.5 21H15.5'),
  ],

  // Supply meeting demand.
  economics: [
    line('M4 3V20H21'),
    line('M7.5 6C9 12.5 13.5 16 19.5 17', 1.8),
    line('M7.5 17C13.5 16 18 12.5 19.5 6', 1.8),
  ],

  // A ballot going into a box.
  'political science': [
    line('M9 12V4H15V12', 1.8),
    line('M10.7 7.8L11.8 9L13.5 6.6', 1.3),
    frame(4, 12.5, 16, 8.5, 1),
    line('M2.5 12.5H21.5', 2.4),
  ],

  // A globe.
  geography: [
    ring(12, 12, 9),
    line('M3 12H21M12 3C7.6 6.4 7.6 17.6 12 21M12 3C16.4 6.4 16.4 17.6 12 21', 1.6),
  ],

  // Scales.
  law: [
    line('M12 3V20.5M7.5 21H16.5M4.5 6.5H19.5'),
    line('M4.5 6.5L2 13M4.5 6.5L7 13M19.5 6.5L17 13M19.5 6.5L22 13', 1.2),
    mass('M1.3 13H7.7A3.2 3.2 0 0 1 1.3 13Z'),
    mass('M16.3 13H22.7A3.2 3.2 0 0 1 16.3 13Z'),
  ],

  // A mortarboard.
  education: [
    mass('M12 4L22.5 9L12 14L1.5 9Z'),
    line('M6.5 12.5V16.5C8.5 19.2 15.5 19.2 17.5 16.5V12.5'),
    line('M21 9.5V15.5', 1.6),
  ],

  // --- natural sciences ----------------------------------------------------

  // An atom.
  physics: [
    disc(12, 12, 2.2),
    line('M2 12A10 4 0 1 0 22 12A10 4 0 1 0 2 12', 1.5),
    line('M7 3.34A10 4 60 1 0 17 20.66A10 4 60 1 0 7 3.34', 1.5),
    line('M17 3.34A10 4 120 1 0 7 20.66A10 4 120 1 0 17 3.34', 1.5),
  ],

  // A conical flask, a third full.
  chemistry: [
    line('M9 3H15M10.2 3V9L4.4 19A1.5 1.5 0 0 0 5.7 21.2H18.3A1.5 1.5 0 0 0 19.6 19L13.8 9V3'),
    mass('M7.3 15.2H16.7L18.9 19.4C19.2 20 18.9 20.4 18.3 20.4H5.7C5.1 20.4 4.8 20 5.1 19.4Z'),
  ],

  // The double helix.
  biology: [
    line('M8 2C8 7 16 7 16 12C16 17 8 17 8 22'),
    line('M16 2C16 7 8 7 8 12C8 17 16 17 16 22'),
    line('M9.4 4.4H14.6M9.4 9.6H14.6M9.4 14.4H14.6M9.4 19.6H14.6', 1.4),
  ],

  // Mountains, and what they are standing on.
  'earth science': [
    mass('M2 15.5L8.5 4.5L12.4 11L15.4 7L22 15.5Z'),
    line('M2 18.6C6 17 9 20.2 12 18.6C15 17 18 20.2 22 18.6', 1.6),
    line('M4 22C7 20.6 9.5 23 12 22C14.5 21 17 23 20 22', 1.6),
  ],

  // A ringed planet.
  astronomy: [
    disc(12, 12.5, 5.4),
    line('M2.13 16.09A10.5 3.2 -20 1 0 21.87 8.91A10.5 3.2 -20 1 0 2.13 16.09', 1.6),
    line('M19.5 2.5V6.5M17.5 4.5H21.5', 1.3),
  ],

  // --- formal sciences -----------------------------------------------------

  // The four operations a calculator leads with.
  mathematics: [
    line('M7 3.8V10.2M3.8 7H10.2', 2.3),
    line('M13.8 7H20.2', 2.3),
    line('M4.7 14.7L9.3 19.3M9.3 14.7L4.7 19.3', 2.3),
    line('M13.8 15.1H20.2M13.8 18.9H20.2', 2.3),
  ],

  // The normal curve.
  statistics: [
    line('M2 18.5C8 18.5 8 4.5 12 4.5C16 4.5 16 18.5 22 18.5'),
    line('M2 21.5H22'),
    line('M12 8.5V18.5M8 15V18.5M16 15V18.5', 1.4),
  ],

  // A terminal, waiting.
  'computer science': [
    frame(2.5, 4, 19, 16, 2),
    line('M6.5 9L10 12L6.5 15'),
    line('M12.5 15.5H17.5'),
  ],

  // --- applied sciences ----------------------------------------------------

  // A gear.
  engineering: [mass(cog(12, 12, 8, 10, 7.4, 3.2))],

  // A heart, and the trace of it beating. The staff and snake came first and
  // at this size it was a dollar sign.
  medicine: [
    line('M12 20.5C5.5 15.5 2.5 12 2.5 8.3C2.5 5.3 4.8 3.2 7.4 3.2C9.3 3.2 11 4.2 12 5.9C13 4.2 14.7 3.2 16.6 3.2C19.2 3.2 21.5 5.3 21.5 8.3C21.5 12 18.5 15.5 12 20.5Z'),
    line('M6.5 11.5H9.4L11 8.4L13.4 14.6L14.9 11.5H17.5', 1.6),
  ],

  // An ear of wheat.
  agriculture: [
    line('M12 22V8'),
    mass('M12 3C10.2 5 10.2 7.2 12 8.8C13.8 7.2 13.8 5 12 3Z'),
    // The grains come in pairs up the stalk, so they are one pair, twice.
    ...[0, 5].flatMap((up) => {
      const y = (n) => round(n - up);
      return [
        mass(`M11.4 ${y(19.5)}C8.4 ${y(18.9)} 7.2 ${y(16.7)} 7.8 ${y(14.5)}C10.4 ${y(15.1)} 11.6 ${y(17.3)} 11.4 ${y(19.5)}Z`),
        mass(`M12.6 ${y(19.5)}C15.6 ${y(18.9)} 16.8 ${y(16.7)} 16.2 ${y(14.5)}C13.6 ${y(15.1)} 12.4 ${y(17.3)} 12.6 ${y(19.5)}Z`),
      ];
    }),
  ],

  // A tree.
  'environmental science': [
    mass('M12 2.5C8.6 2.5 6.6 5 7 7.6C4.4 8.6 3.8 12 6 14.2C8 16.2 10.4 15.6 12 15.6C13.6 15.6 16 16.2 18 14.2C20.2 12 19.6 8.6 17 7.6C17.4 5 15.4 2.5 12 2.5Z'),
    line('M12 14V21.5', 2.4),
    line('M7.5 21.5H16.5'),
  ],

  // A store of records.
  'information science': [
    line('M4 6A8 3 0 0 0 20 6A8 3 0 0 0 4 6'),
    line('M4 6V18A8 3 0 0 0 20 18V6'),
    line('M4 12A8 3 0 0 0 20 12'),
  ],

  // --- hobbies -------------------------------------------------------------

  // Scissors. A threaded needle was the first attempt and read as a pen.
  handcraft: [
    ring(6.5, 18, 3),
    ring(17.5, 18, 3),
    line('M8.4 15.6L18.5 3M15.6 15.6L5.5 3', 2.2),
  ],

  // A pot, with something in it.
  cooking: [
    mass('M4.5 11H19.5V17.2A3.3 3.3 0 0 1 16.2 20.5H7.8A3.3 3.3 0 0 1 4.5 17.2Z'),
    line('M2 12.5H4.5M19.5 12.5H22'),
    line('M9 2.5C8 4 10 5.5 9 7.5M14.5 2.5C13.5 4 15.5 5.5 14.5 7.5', 1.6),
  ],

  // A die, showing five.
  games: [
    mass(
      `M7 3.5H17A3.5 3.5 0 0 1 20.5 7V17A3.5 3.5 0 0 1 17 20.5H7A3.5 3.5 0 0 1 3.5 17V7A3.5 3.5 0 0 1 7 3.5Z${
        hole(8, 8, 1.6)}${hole(16, 8, 1.6)}${hole(12, 12, 1.6)}${hole(8, 16, 1.6)}${hole(16, 16, 1.6)}`,
    ),
  ],

  // A tent.
  outdoors: [
    line('M12 4.5L21.5 20.5H2.5Z'),
    line('M10.4 2.2L12 4.5L13.6 2.2', 1.6),
    mass('M12 11.5L16 20.5H8Z'),
  ],

  // A seedling.
  growing: [
    line('M12 21V10.5'),
    mass('M12 13.5C12 9.5 9 7.2 4.5 7.2C4.5 11.4 7.6 13.5 12 13.5Z'),
    mass('M12 10.5C12 6.8 14.8 4 19.5 4C19.5 8.2 16.4 10.5 12 10.5Z'),
    line('M6 21H18'),
  ],

  // Somebody running.
  movement: [
    disc(14.8, 4.4, 2.3),
    line('M13.6 8.6L10.8 14.2M8 10.2L13.6 8.6L17.2 11.8M10.8 14.2L14.8 17L13.6 21.6M10.8 14.2L8 18H4', 2.2),
  ],

  // A chip, legs and all.
  tinkering: [
    box(7, 7, 10, 10, 1.4),
    line('M10 3.5V7M14 3.5V7M10 17V20.5M14 17V20.5M3.5 10H7M3.5 14H7M17 10H20.5M17 14H20.5', 1.8),
  ],

  // A postage stamp.
  collections: [
    mass(`${perforated(4, 2.5, 16, 19, 4, 5)}M7.4 6.2H16.6V17.8H7.4Z`),
    disc(12, 12, 2.4),
  ],

  // A stretch of keyboard.
  'playing music': [
    frame(2.5, 5.5, 19, 13, 1.2),
    line('M8.8 5.5V18.5M15.2 5.5V18.5', 1.4),
    box(7.1, 5.5, 3.4, 7.5),
    box(13.5, 5.5, 3.4, 7.5),
  ],

  // A pencil.
  writing: [
    line('M4 20L5.4 15.2L16.4 4.2A1.9 1.9 0 0 1 19.1 4.2L19.8 4.9A1.9 1.9 0 0 1 19.8 7.6L8.8 18.6Z'),
    line('M14.2 6.4L17.6 9.8', 1.6),
    mass('M4 20L5 16.6L7.4 19Z'),
  ],

  // A cocktail glass, half full.
  drinks: [
    line('M4 4H20L12 13Z'),
    mass('M7.2 7.6H16.8L12 13Z'),
    line('M12 13V20.5M7.5 20.5H16.5'),
  ],

  // --- sport ---------------------------------------------------------------

  // A ball.
  'team sports': [
    ring(12, 12, 9),
    mass(polygon(12, 12, 5, 3.6)),
    line(spokes(12, 12, 5, 3.6, 8.4), 1.6),
  ],

  // A racket, and the ball coming at it.
  'racket sports': [
    ring(9.5, 9.5, 6.3),
    line('M9.5 3.6V15.4M3.6 9.5H15.4', 1.2),
    line('M14.2 14.2L20.5 20.5', 2.8),
    disc(19.6, 5, 1.9),
  ],

  // A chequered flag.
  motorsport: [
    line('M4.5 2.5V21.5'),
    frame(4.5, 3.5, 15, 10, 0, 1.6),
    box(4.5, 3.5, 5, 5),
    box(14.5, 3.5, 5, 5),
    box(9.5, 8.5, 5, 5),
  ],

  // A boxing glove.
  'combat sports': [
    box(8.5, 3, 12, 13.5, 5),
    box(3.5, 7.5, 4.2, 9, 2.1),
    box(8.5, 18, 12, 3.5, 1),
  ],

  // A stopwatch.
  athletics: [
    ring(12, 13.5, 7.5),
    line('M12 13.5V9'),
    line('M9.5 2.5H14.5M12 2.5V6'),
    line('M18.2 6.3L19.8 4.7', 1.8),
  ],

  // A target.
  'target sports': [
    ring(12, 12, 9),
    ring(12, 12, 5),
    disc(12, 12, 1.8),
  ],

  // A snowflake.
  'winter sports': [
    line('M12 2.5V21.5M3.8 7.25L20.2 16.75M3.8 16.75L20.2 7.25'),
    line('M9.5 4.5L12 7L14.5 4.5M9.5 19.5L12 17L14.5 19.5', 1.6),
  ],

  // Waves.
  'water sports': [
    line('M3 7.5C5 5.17 7 5.17 9 7.5C11 9.83 13 9.83 15 7.5C17 5.17 19 5.17 21 7.5'),
    line('M3 13C5 10.67 7 10.67 9 13C11 15.33 13 15.33 15 13C17 10.67 19 10.67 21 13'),
    line('M3 18.5C5 16.17 7 16.17 9 18.5C11 20.83 13 20.83 15 18.5C17 16.17 19 16.17 21 18.5'),
  ],

  // A medal on its ribbon.
  'following sport': [
    line('M7.5 2.5L12 10.5L16.5 2.5'),
    ring(12, 15.5, 5.5),
    disc(12, 15.5, 1.8),
  ],

  // --- technology ----------------------------------------------------------

  // Angle brackets, and the slash between them.
  programming: [
    line('M8 6.5L2.8 12L8 17.5'),
    line('M16 6.5L21.2 12L16 17.5'),
    line('M13.8 4L10.2 20'),
  ],

  // A spark, and a smaller one.
  'artificial intelligence': [
    mass(spark(10.5, 13.5, 8.5)),
    mass(spark(18.5, 5.5, 3.6)),
  ],

  // A phone.
  gadgets: [
    frame(6.5, 2.5, 11, 19, 2.2),
    line('M10.5 18H13.5', 1.6),
  ],

  // A signal, spreading.
  internet: [
    line('M3 9.8A12.7 12.7 0 0 1 21 9.8'),
    line('M6.3 13.2A8 8 0 0 1 17.7 13.2'),
    line('M9.5 16.6A3.6 3.6 0 0 1 14.5 16.6'),
    disc(12, 19.8, 1.5),
  ],

  // A padlock.
  cybersecurity: [
    mass(
      `M6.5 10.5H17.5A1.5 1.5 0 0 1 19 12V20A1.5 1.5 0 0 1 17.5 21.5H6.5A1.5 1.5 0 0 1 5 20V12A1.5 1.5 0 0 1 6.5 10.5Z${
        hole(12, 15.5, 1.8)}`,
    ),
    line('M8 10.5V7.5A4 4 0 0 1 16 7.5V10.5'),
  ],

  // Layers, one on another.
  'operating systems': [
    line('M12 3L21 7.8L12 12.6L3 7.8Z'),
    line('M3 12.2L12 17L21 12.2'),
    line('M3 16.4L12 21.2L21 16.4'),
  ],

  // A rocket.
  'emerging technology': [
    mass(`M12 2C15.3 4.8 16.5 9 16.5 13V17H7.5V13C7.5 9 8.7 4.8 12 2Z${hole(12, 9.5, 1.9)}`),
    mass('M7.5 12.5L4 16.5V20L7.5 18Z'),
    mass('M16.5 12.5L20 16.5V20L16.5 18Z'),
    line('M12 18.8V22'),
  ],

  // A laptop, open.
  'tech industry': [
    frame(5, 4.5, 14, 10.5, 1.5),
    line('M2.5 18.5H21.5', 2.6),
  ],

  // --- entertainment -------------------------------------------------------

  // A television, aerial up.
  television: [
    frame(3, 7.5, 18, 12, 2),
    line('M7.5 2.5L12 7.5L16.5 2.5', 1.8),
    line('M8 21.8H16', 1.8),
  ],

  // An eye, with the light caught in it.
  'anime and manga': [
    line('M2.5 12.5C6 6.5 18 6.5 21.5 12.5C18 18 6 18 2.5 12.5Z'),
    mass(`${hole(12, 12.3, 4.2)}${hole(13.6, 10.8, 1.4)}`),
    line('M4.2 6.8L5.8 8.8M8.4 4.6L9.2 7', 1.6),
  ],

  // A burst round a word that is being shouted.
  comics: [
    line(star(12, 12, 9, 10, 6.4), 1.8),
    box(11, 7.8, 2, 5.6, 1),
    disc(12, 15.8, 1.2),
  ],

  // A microphone.
  'podcasts and radio': [
    box(9, 2.5, 6, 11.5, 3),
    line('M5.5 10.5A6.5 6.5 0 0 0 18.5 10.5'),
    line('M12 17V21M8.5 21.3H15.5'),
  ],

  // A star.
  'pop culture': [mass(star(12, 12.6, 5, 10, 4.2))],

  // A play button.
  'online video': [
    frame(2.5, 5, 19, 14, 3.5),
    mass('M9.8 8.6L16 12L9.8 15.4Z'),
  ],

  // Somebody laughing.
  comedy: [
    ring(12, 12, 9.5),
    mass('M6.8 12.8H17.2A5.2 5.2 0 0 1 6.8 12.8Z'),
    disc(8.6, 9, 1.3),
    disc(15.4, 9, 1.3),
  ],

  // --- lifestyle -----------------------------------------------------------

  // A house.
  home: [mass('M12 3L21.5 11.5H19V20.5H14V14.5H10V20.5H5V11.5H2.5Z')],

  // A grown-up and a child.
  'family and relationships': [
    disc(8.5, 6, 3),
    mass('M3 21V15.5C3 12.4 5.2 10.5 8.5 10.5C11.8 10.5 14 12.4 14 15.5V21Z'),
    disc(18, 11.8, 2.3),
    mass('M14.8 21V18.6C14.8 16.5 16 15.3 18 15.3C20 15.3 21.2 16.5 21.2 18.6V21Z'),
  ],

  // A banknote.
  money: [
    frame(2.5, 6, 19, 12, 1.5),
    ring(12, 12, 2.8, 1.8),
    disc(6, 12, 1),
    disc(18, 12, 1),
  ],

  // A briefcase.
  work: [
    frame(3, 8, 18, 12.5, 2),
    line('M9 8V6A1.5 1.5 0 0 1 10.5 4.5H13.5A1.5 1.5 0 0 1 15 6V8'),
    line('M3 13.5H21', 1.6),
  ],

  // A lotus.
  wellbeing: [
    mass('M12 4C15.2 8 15.2 13 12 17.5C8.8 13 8.8 8 12 4Z'),
    line('M3 9.5C7.5 9.8 10.8 12.8 12 17.5C7.6 18.2 3.6 15 3 9.5Z', 1.8),
    line('M21 9.5C16.5 9.8 13.2 12.8 12 17.5C16.4 18.2 20.4 15 21 9.5Z', 1.8),
    line('M6 21H18', 1.8),
  ],

  // A paper plane.
  travel: [
    line('M21.5 2.5L2.5 10L9.5 13.2L12.5 21L21.5 2.5Z'),
    line('M9.5 13.2L21.5 2.5', 1.6),
  ],

  // A paw print.
  pets: [
    mass('M12 12C15.4 12 18 15 18 17.7C18 19.9 16.4 20.9 14.6 20.4C13.5 20.1 12.8 19.9 12 19.9C11.2 19.9 10.5 20.1 9.4 20.4C7.6 20.9 6 19.9 6 17.7C6 15 8.6 12 12 12Z'),
    disc(5.2, 10.6, 2),
    disc(9.3, 6.2, 2.2),
    disc(14.7, 6.2, 2.2),
    disc(18.8, 10.6, 2),
  ],

  // A coat hanger.
  style: [
    line('M12 9V7.6A2.3 2.3 0 1 0 9.7 5.3'),
    line('M12 9L21 16.2C22 17 21.4 18.5 20.2 18.5H3.8C2.6 18.5 2 17 3 16.2Z'),
  ],

  // A car, from the side.
  vehicles: [
    mass('M2.5 16.5V13.2L5.8 12.2L8.4 7.5H15.6L18.2 12.2L21.5 13.2V16.5ZM9.5 9.3H14.5L15.9 12H8.1Z'),
    disc(7.2, 17, 2.5),
    disc(16.8, 17, 2.5),
  ],

  // --- society -------------------------------------------------------------

  // A newspaper.
  'current affairs': [
    frame(3, 4, 18, 16.5, 1.5),
    box(6, 7, 12, 3.2, 0.4),
    line('M6 13.5H18M6 17H13.5', 1.5),
  ],

  // A megaphone.
  causes: [
    mass('M3.5 9.5H8L18.5 4.5V19.5L8 14.5H3.5Z'),
    line('M7 15L8.8 20.5', 2.2),
    line('M21.3 9.5V14.5', 1.8),
  ],

  // People sitting in a circle.
  communities: [
    disc(12, 4.2, 2.4),
    disc(19.4, 9.6, 2.4),
    disc(16.6, 18.3, 2.4),
    disc(7.4, 18.3, 2.4),
    disc(4.6, 9.6, 2.4),
    ring(12, 12.2, 2.6, 1.6),
  ],
};

/**
 * What people type when they mean one of the above.
 *
 * Short on purpose. Anything the hierarchy already knows finds its own way up
 * — `jazz` reaches `music` without help — so this is only for the everyday
 * word that is not the catalogue's word: nobody joins `mathematics`, they join
 * `math`.
 */
const ALIASES = {
  art: 'visual art',
  math: 'mathematics',
  maths: 'mathematics',
  stats: 'statistics',
  cs: 'computer science',
  coding: 'programming',
  tech: 'technology',
  ai: 'artificial intelligence',
  security: 'cybersecurity',
  science: 'natural sciences',
  religion: 'religious studies',
  books: 'literature',
  reading: 'literature',
  theater: 'performing arts',
  movies: 'film',
  cinema: 'film',
  tv: 'television',
  news: 'current affairs',
  jobs: 'work',
  family: 'family and relationships',
  food: 'cooking',
  gaming: 'games',
  sports: 'sport',
  fitness: 'movement',
  nature: 'outdoors',
  crafts: 'handcraft',
  diy: 'tinkering',
  health: 'medicine',
  farming: 'agriculture',
  environment: 'environmental science',
};

/** Climb from a name the hierarchy knows to the nearest one that is drawn. */
function climb(name, parents) {
  let at = ALIASES[name] ?? name;
  // Bounded, because a hierarchy baked from somewhere less careful than
  // `knowledge.js` can contain a cycle and this must not be the thing it hangs.
  for (let step = 0; step < 16 && at; step++) {
    if (EMBLEMS[at]) return at;
    at = parents[at];
  }
  return null;
}

/**
 * Which emblem a subject wears: the name of the field or division it is drawn
 * as, or null when the hierarchy cannot place it.
 *
 * The same leniency `resolve` has in the taxonomy, for the same reason. A real
 * catalogue is full of `modern painting` and `history of jazz`, and the
 * longest tail the hierarchy knows wins — so those land where `painting` and
 * `jazz` are. A group's copy of a subject is that subject: `kite-fox-9/art`
 * wears what `art` wears.
 *
 * Null is a real answer and the caller is expected to have something to do
 * with it. Inventing an emblem for a name nothing is known about would be the
 * map lying about where that subject is.
 *
 * @param {string} subject
 * @param {Record<string,string>} [parents]  child -> parent, for a host with a hierarchy of its own
 */
export function emblemOf(subject, parents = knowledge) {
  const text = String(subject ?? '');
  const name = text.slice(text.indexOf('/') + 1).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!name) return null;

  const words = name.split(' ');
  for (let start = 0; start < words.length; start++) {
    const found = climb(words.slice(start).join(' '), parents);
    if (found) return found;
  }
  return null;
}

/** The shapes of a subject's emblem on the 24-unit square, or null. */
export function emblem(subject, parents = knowledge) {
  const name = emblemOf(subject, parents);
  return name ? EMBLEMS[name] : null;
}

/** The side of the square every emblem is drawn on. */
export const EMBLEM_SIZE = 24;
