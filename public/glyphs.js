/**
 * Drawing what a subject wears, in a browser.
 *
 * `lib/emblem.js` decides whether a subject has an emblem and what it is made
 * of; `lib/glyph.js` decides the pattern it falls back to when it has none.
 * This turns either into nodes. Two callers: a small standalone square for the
 * lists, and a `<pattern>` the map fills a territory with. Both ask the same
 * question in the same order, so a subject cannot look like one thing in the
 * rail and another on the map.
 */

import { EMBLEM_SIZE, emblem } from '../lib/emblem.js';
import { glyphOf, patternId, phaseOf, tile } from '../lib/glyph.js';
import { stroke } from '../lib/palette.js';

const NS = 'http://www.w3.org/2000/svg';

/** One shape of a tile or an emblem, as a node. `ink` is what it is drawn in. */
function shapeNode(doc, shape, ink) {
  const node = doc.createElementNS(NS, shape.shape === 'path' ? 'path' : shape.shape);
  const set = (k, v) => node.setAttribute(k, String(v));
  const outline = () => {
    set('fill', 'none'); set('stroke', ink); set('stroke-width', shape.width);
    set('stroke-linecap', 'round'); set('stroke-linejoin', 'round');
  };

  if (shape.shape === 'line') {
    set('x1', shape.x1); set('y1', shape.y1); set('x2', shape.x2); set('y2', shape.y2);
    outline();
  } else if (shape.shape === 'circle') {
    set('cx', shape.cx); set('cy', shape.cy); set('r', shape.r);
    if (shape.hollow) outline();
    else set('fill', ink);
  } else if (shape.shape === 'rect') {
    set('x', shape.x); set('y', shape.y); set('width', shape.w); set('height', shape.h);
    if (shape.rx) set('rx', shape.rx);
    if (shape.hollow) outline();
    else set('fill', ink);
  } else {
    set('d', shape.d);
    if (shape.solid) {
      // Even-odd, so a sub-path inside a mass is a hole in it. With one ink
      // there is no other way to put pips on a die.
      set('fill', ink); set('fill-rule', 'evenodd');
    } else outline();
  }
  return node;
}

/** An emblem's shapes, moved and scaled from their 24-unit square to `side`. */
function emblemNode(doc, shapes, x, y, side, ink) {
  const g = doc.createElementNS(NS, 'g');
  g.setAttribute('transform', `translate(${round(x)} ${round(y)}) scale(${round(side / EMBLEM_SIZE)})`);
  for (const shape of shapes) g.append(shapeNode(doc, shape, ink));
  return g;
}

const round = (n) => Math.round(n * 1000) / 1000;

/**
 * A subject as a small square: its colour, with its emblem or pattern over it.
 *
 * Drawn in white rather than in a second colour. A contrasting ink would be a
 * third thing to keep legible against both themes and every hue; brightening
 * what is already there cannot clash with anything. An emblem gets the white
 * at full strength because it is there to be read; a pattern is only there to
 * be told apart, and stays faint.
 */
export function glyphSwatch(doc, subject, size = 18) {
  const svg = doc.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('class', 'glyph');
  // Decoration beside a name that is already there in words.
  svg.setAttribute('aria-hidden', 'true');

  const ground = doc.createElementNS(NS, 'rect');
  ground.setAttribute('x', '0');
  ground.setAttribute('y', '0');
  ground.setAttribute('width', String(size));
  ground.setAttribute('height', String(size));
  ground.setAttribute('rx', String(size / 4));
  ground.setAttribute('fill', stroke(subject));
  svg.append(ground);

  const drawn = emblem(subject);
  if (drawn) {
    // A margin, or a frame drawn to the edge of its square reads as a border
    // on the swatch rather than as something inside it.
    const inset = size * 0.14;
    svg.append(emblemNode(doc, drawn, inset, inset, size - inset * 2, '#ffffff'));
    return svg;
  }

  const marks = doc.createElementNS(NS, 'g');
  marks.setAttribute('opacity', '0.7');
  for (const shape of tile(subject, size)) marks.append(shapeNode(doc, shape, '#ffffff'));
  svg.append(marks);

  return svg;
}

/**
 * The same thing as something the map can fill a shape with.
 *
 * Added to a `<defs>` once per subject per render; the caller fills with
 * `url(#id)`. The tile is given in user units because the map is, so a
 * pattern keeps its size against the drawing rather than against the screen —
 * which is what makes it survive being zoomed into.
 *
 * An emblem is sown the way a printed map sows its marsh: two to a tile, the
 * second half a step across and down, so the ground reads as scattered with
 * them rather than ruled into columns. Every subject in a field wears the
 * field's emblem, so the spacing is taken from the subject's own hash — two
 * siblings that also landed on one hue still differ in how thickly they are
 * sown, which is as much of the second channel as survives inside a field.
 */
export function definePattern(doc, defs, subject, size = 34) {
  const id = patternId(subject);
  if (defs.querySelector(`#${id}`)) return id;

  const pattern = doc.createElementNS(NS, 'pattern');
  pattern.setAttribute('id', id);
  pattern.setAttribute('patternUnits', 'userSpaceOnUse');

  // `currentColor`, inherited from the map, which the stylesheet sets to the
  // theme's ink. Drawn in the subject's own colour it was invisible — the
  // same hue as the ground it sits on, which is the one colour it cannot be
  // and still be seen. Ink shows on a pale fill and on a dark one.
  const drawn = emblem(subject);
  const { angle, dense } = glyphOf(subject);
  const side = drawn ? size * (dense ? 2.1 : 2.7) : size;
  pattern.setAttribute('width', String(round(side)));
  pattern.setAttribute('height', String(round(side)));

  if (drawn) {
    const phase = phaseOf(subject);
    pattern.setAttribute('x', String(round(phase.x * side)));
    pattern.setAttribute('y', String(round(phase.y * side)));

    const each = size * 0.7;
    const edge = (side / 2 - each) / 2;
    pattern.append(emblemNode(doc, drawn, edge, edge, each, 'currentColor'));
    pattern.append(emblemNode(doc, drawn, edge + side / 2, edge + side / 2, each, 'currentColor'));
  } else {
    if (angle) pattern.setAttribute('patternTransform', `rotate(${angle})`);
    for (const shape of tile(subject, size)) {
      pattern.append(shapeNode(doc, shape, 'currentColor'));
    }
  }
  defs.append(pattern);
  return id;
}

/** Whether a subject has anything to fill with; `plain` is a real answer. */
export const hasPattern = (subject) =>
  emblem(subject) !== null || glyphOf(subject).family !== 'plain';
