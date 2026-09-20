import { key, parse, receives } from '../lib/regions.js';
import { NS, stroke, cssId } from './diagram.js';

/**
 * Rendering for the routed-boundary atlas.
 *
 * Nothing here may assume a shape has a centre and a radius. Territories
 * arrive as sets of closed loops, are filled with the even-odd rule so a loop
 * inside a loop reads as a hole, and a subject that ended up in two patches is
 * simply drawn as two patches.
 *
 * There are no separate zone shapes. A zone *is* the ground where territories
 * overlap, so translucent fills produce it for free: where two subjects cross,
 * the colour doubles, and that darker patch is the two-subject room.
 */

const pathOf = (loops) =>
  loops
    .map((loop) => `M${loop.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L')}Z`)
    .join(' ');

/**
 * Which subjects cover a point — and therefore which room it is.
 *
 * The circle map's trick, carried over intact: the address is not stored
 * anywhere, it is read off the ground. Ray casting with the even-odd rule, so
 * a point inside a hole correctly counts as outside.
 */
export function zoneAt(curves, x, y) {
  const inside = [];

  for (const curve of curves) {
    let crossings = 0;
    for (const loop of curve.loops) {
      for (let i = 0; i < loop.length; i++) {
        const [ax, ay] = loop[i];
        const [bx, by] = loop[(i + 1) % loop.length];
        if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) crossings++;
      }
    }
    if (crossings % 2 === 1) inside.push(curve.subject);
  }
  return inside.length ? key(inside) : null;
}

export function renderAtlas(svg, view) {
  const doc = svg.ownerDocument;
  const el = (name, attrs = {}) => {
    const node = doc.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  };

  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const { curves, extent, subscription = [] } = view;
  const territories = new Map();
  if (!curves?.length) return { territories };

  const pad = extent * 0.05;
  svg.setAttribute(
    'viewBox',
    `${-extent / 2 - pad} ${-extent / 2 - pad} ${extent + pad * 2} ${extent + pad * 2}`,
  );
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const held = new Set(subscription);

  for (const curve of curves) {
    const patch = el('path', {
      d: pathOf(curve.loops),
      'fill-rule': 'evenodd',
      fill: stroke(curve.subject),
      stroke: stroke(curve.subject),
      class: `territory${held.has(curve.subject) ? ' mine' : ''}`,
      'data-subject': cssId(curve.subject),
    });
    territories.set(curve.subject, patch);
    svg.append(patch);
  }

  for (const curve of curves) {
    const label = el('text', {
      x: curve.anchor.x,
      y: curve.anchor.y,
      class: `atlas-label${held.has(curve.subject) ? ' mine' : ''}`,
    });
    label.textContent = curve.subject;
    // A subject in two pieces is drawn in two pieces; say so rather than
    // letting it read as two different subjects that happen to share a colour.
    if (curve.components > 1) label.textContent += ` (${curve.components} parts)`;
    svg.append(label);
  }

  return { territories };
}

/**
 * Light the territories that a selected room reaches.
 *
 * The same predicate as delivery, as on the circle map: a subject is lit when
 * the room's subjects are all contained in — no, when the room is posted to,
 * everyone holding all of it hears, so the lit ground is the intersection of
 * exactly those subjects.
 */
export function paintAtlas(territories, selected) {
  const tags = selected ? parse(selected) : [];
  for (const [subject, node] of territories) {
    const lit = tags.length > 0 && tags.includes(subject);
    node.classList.toggle('lit', lit);
  }
  return tags.length > 0 && receives(tags, tags);
}
