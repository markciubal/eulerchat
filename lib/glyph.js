/**
 * A second way of telling one subject from another.
 *
 * Colour alone cannot do it. Hues come from a hash of the name, a catalogue
 * of a few hundred names into 360 degrees collides by the pigeonhole
 * principle long before the hash is at fault, and somebody who cannot
 * separate two hues at all is left with no channel whatever. So every subject
 * also gets a pattern, drawn from a different hash than its hue — independent
 * channels, so two subjects that landed on the same colour are very unlikely
 * to have landed on the same texture as well.
 *
 * What is here is geometry generated from a name: lines, dots, arcs, at
 * angles and spacings that fall out of a hash. It is the same kind of thing
 * the map is, and the same kind of thing the invitation square is — a drawing
 * of data, made of shapes. It is not a picture of anything and there is
 * nothing to recognise in it.
 *
 * THE SCHEME THAT ANSWERS FOR EVERY NAME. A little palette for `art` and a
 * little note for `music` are prettier, and `emblem.js` draws them — for the
 * fields the hierarchy knows, and for everything that sits beneath one. This
 * file used to argue that such a table was ruled out altogether, because it is
 * useless the moment somebody creates a subject nobody has drawn yet. The
 * objection was sound and the conclusion was too strong: a curated table
 * cannot be the whole answer, and it does not have to be. A catalogue where
 * anyone can add a name needs something that works for the names that do not
 * exist yet, and this is it. An emblem is worn where there is one; a pattern
 * is what every other subject wears, and no subject goes without.
 */

import { label } from './cluster.js';

/**
 * A hash of the name, seeded away from the one the hue uses.
 *
 * Deliberately not the same number. If pattern and colour came from one hash
 * then two subjects sharing a hue would share a texture too, and the second
 * channel would tell you nothing the first had not already failed to.
 */
function hash(subject) {
  let h = 0x811c9dc5 ^ 0x5bf03635;
  // The subject's own name, not the group's: inside a group art is still art,
  // and wears art's pattern as it wears art's colour. See `lib/cluster.js`.
  const text = label(String(subject ?? ''));
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/**
 * The families, in the order a hash picks them.
 *
 * `plain` is first and is not a mistake: the commonest texture should be no
 * texture, or a wall of busy little squares is what a rail of thirty subjects
 * becomes. Roughly one subject in eight is left alone.
 */
export const FAMILIES = ['plain', 'stripes', 'dots', 'grid', 'chevron', 'rings', 'checks'];

/**
 * How many quarter-turns actually change what a family looks like.
 *
 * Turning a ring does nothing, and `bars` were stripes already turned — so a
 * first cut of this had four angles for every family and counted sixty-three
 * distinct patterns when it had nowhere near that many. Rotation is a
 * variation for the families it varies, and the ones it does not get their
 * second parameter somewhere it shows.
 */
const TURNS = { stripes: 4, chevron: 4, grid: 2, checks: 2, dots: 1, rings: 1, plain: 1 };

/** Which pattern a subject wears, how it is turned, and how close together. */
export function glyphOf(subject) {
  const h = hash(subject);
  const family = FAMILIES[h % FAMILIES.length];
  const turns = TURNS[family];
  const spare = Math.floor(h / FAMILIES.length);
  return {
    family,
    angle: (spare % turns) * (180 / turns),
    dense: Math.floor(spare / turns) % 2 === 1,
    // Only where turning is no use: it gives those families a second
    // parameter rather than leaving them with one.
    scale: turns === 1 ? 0.7 + 0.3 * (Math.floor(spare / 2) % 3) : 1,
  };
}

/**
 * Where a subject's tiling starts, as fractions of a tile.
 *
 * Only matters to a tile with something in the middle of it. Stripes slid
 * sideways are the same stripes, but two subjects sown with the same emblem at
 * the same spacing would land every mark exactly on its twin wherever they
 * overlap, and the room where they meet would look like either of them alone.
 * Started from different corners, the two interleave instead.
 */
export function phaseOf(subject) {
  const h = hash(subject);
  return { x: ((h >>> 5) % 8) / 8, y: ((h >>> 9) % 8) / 8 };
}

/**
 * What a pattern actually looks like, as a string.
 *
 * Two subjects with the same signature are drawn identically; two with
 * different ones are not. This is what to count when asking how many distinct
 * patterns there are, rather than counting the parameters — some of which do
 * nothing for some families.
 */
export const signature = (subject) => {
  const { family, angle, dense, scale } = glyphOf(subject);
  return `${family}/${angle}/${dense ? 'd' : 'l'}/${scale.toFixed(2)}`;
};

/**
 * The shapes that make one tile of a subject's pattern, on a `size` square.
 *
 * Returned as plain descriptions rather than as nodes, so the same tile can
 * become an element in a browser, a `<pattern>` on the map, or a string in a
 * file, without three functions that can disagree about what a subject looks
 * like.
 *
 * @returns {Array<{shape: 'line'|'circle'|'rect'|'path', [key: string]: unknown}>}
 */
export function tile(subject, size = 12) {
  const { family, dense, scale } = glyphOf(subject);
  const step = (dense ? size / 4 : size / 2) * scale;
  const thick = Math.max(0.6, size / 14);
  const out = [];

  if (family === 'stripes') {
    for (let at = step / 2; at < size; at += step) {
      out.push({ shape: 'line', x1: at, y1: 0, x2: at, y2: size, width: thick });
    }
  } else if (family === 'grid') {
    for (let at = step / 2; at < size; at += step) {
      out.push({ shape: 'line', x1: at, y1: 0, x2: at, y2: size, width: thick });
      out.push({ shape: 'line', x1: 0, y1: at, x2: size, y2: at, width: thick });
    }
  } else if (family === 'dots' || family === 'checks') {
    const r = step / (family === 'dots' ? 4.5 : 3);
    for (let y = step / 2; y < size; y += step) {
      for (let x = step / 2; x < size; x += step) {
        out.push(
          family === 'dots'
            ? { shape: 'circle', cx: x, cy: y, r }
            : { shape: 'rect', x: x - r, y: y - r, w: r * 2, h: r * 2 },
        );
      }
    }
  } else if (family === 'chevron') {
    for (let y = step / 2; y <= size + step; y += step) {
      out.push({
        shape: 'path',
        d: `M0 ${round(y)} L${round(size / 2)} ${round(y - step / 2)} L${round(size)} ${round(y)}`,
        width: thick,
      });
    }
  } else if (family === 'rings') {
    const mid = size / 2;
    for (let r = step / 2; r < size; r += step) {
      out.push({ shape: 'circle', cx: mid, cy: mid, r: round(r), hollow: true, width: thick });
    }
  }

  return out;
}

const round = (n) => Math.round(n * 100) / 100;

/** A stable id for a subject's pattern, safe to put in an SVG `url(#...)`. */
export const patternId = (subject, prefix = 'pat') =>
  `${prefix}-${String(subject).replace(/[^a-z0-9]/gi, '_')}-${hash(subject) % 4096}`;
