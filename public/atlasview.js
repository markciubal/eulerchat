import { key, parse, receives } from '../lib/regions.js';
import { NS, stroke, cssId } from './diagram.js';
import { abbreviate, shortLabels } from '../lib/abbrev.js';

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
      // Plain alpha averages colours, so two opposite hues overlap into grey —
      // the room where two subjects meet ends up looking switched off.
      // Multiplying darkens instead, which is how overlap ought to read.
      style: 'mix-blend-mode: multiply',
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
      'data-subject': cssId(curve.subject),
    });
    label.textContent = curve.subject;
    // A subject in two pieces is drawn in two pieces; say so rather than
    // letting it read as two different subjects that happen to share a colour.
    if (curve.components > 1) label.textContent += ` (${curve.components} parts)`;
    svg.append(label);
  }

  // The overlaps, named. They are the most interesting ground on the map and
  // were the only part of it left unlabelled, because the full names will not
  // fit in the space where subjects meet. Initials do: `mu + p + ma` for
  // music, philosophy and math, each shortened only as far as it can be
  // without becoming ambiguous among what is on screen.
  const labels = shortLabels(curves.map((c) => c.subject));
  const written = [];

  for (const zone of view.zones ?? []) {
    if (zone.subjects.length < 2) continue;

    const spot = el('g', { class: 'zone-label', 'data-room': zone.key });
    const full = `${zone.subjects.join(' ∩ ')} · ${zone.population} here`;

    const title = doc.createElementNS(NS, 'title');
    title.textContent = full;

    const text = el('text', { x: zone.x, y: zone.y });
    text.textContent = abbreviate(zone.subjects, labels);

    spot.append(title, text);
    spot.dataset.full = full;
    svg.append(spot);

    written.push({
      text,
      short: abbreviate(zone.subjects, labels),
      long: zone.subjects.join(' ∩ '),
      room: zone.room ?? 0,
      size: 15,
    });
  }

  for (const curve of curves) {
    written.push({
      text: svg.querySelector(`text[data-subject="${cssId(curve.subject)}"]`),
      short: curve.subject,
      long: curve.subject,
      room: curve.anchor.room ?? 0,
      size: 20,
    });
  }

  return { territories, labels, written: written.filter((w) => w.text) };
}

/**
 * Spell the labels out as far as they will go at this zoom.
 *
 * The short forms exist only because the full names do not fit where subjects
 * meet — so once there is room for the real thing, the real thing is what
 * should be there. Two parts to that. Text has to hold a constant size on
 * screen, which means its size in map units has to shrink as the map grows
 * under it; and then it fits, or it does not, against the room the zone
 * actually has — which the layout worked out when it decided where to put the
 * label and now hands over.
 *
 * `getComputedTextLength` is the honest measure and only a browser has it, so
 * headlessly this estimates instead. The estimate is only ever used to decide
 * between two spellings of the same thing.
 */
export function relabel(written, scale) {
  for (const label of written) {
    const size = label.size / Math.max(scale, 1e-6);
    label.text.setAttribute('font-size', size.toFixed(2));

    const widthOf = (value) => {
      label.text.textContent = value;
      const measured = label.text.getComputedTextLength?.();
      return Number.isFinite(measured) && measured > 0 ? measured : value.length * size * 0.55;
    };

    // Room is a radius; a label laid across the middle of it has twice that.
    const fits = label.long !== label.short && widthOf(label.long) <= label.room * 1.9;
    label.text.textContent = fits ? label.long : label.short;
  }
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
