import { key, parse, receives } from '../lib/regions.js';
import { NS, stroke, cssId } from './diagram.js';
import { regionFill } from '../lib/palette.js';
import { definePattern, hasPattern } from './glyphs.js';
import { abbreviate, shortLabels } from '../lib/abbrev.js';
import { clusterOf, isGroupRoom, label, named } from '../lib/cluster.js';
import { WALLS, heightOf, ribbons, shade, wallRuns } from './relief.js';
import { boxAround, cullTo, viewBoxOf } from './cull.js';

/**
 * What a subject is called on the map. A group's own conversation is the
 * outline round the group, so it is called by the group's name; everything
 * inside is called what it is called outside.
 */
const called = (subject) => (isGroupRoom(subject) ? clusterOf(subject) : label(subject));

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

/** The highest point on a set of loops, or null for none. */
function topOf(loops) {
  let best = null;
  for (const loop of loops ?? []) {
    for (const [x, y] of loop) if (!best || y < best.y) best = { x, y };
  }
  return best;
}

/**
 * Loops as path data, remembered for each list of loops. In relief the map is
 * drawn again for every frame it is turned, and the ground it is drawn from
 * does not turn: writing every outline out again each time was a sixth of
 * what a frame of orbiting cost.
 */
const paths = new WeakMap();
const pathOf = (loops) => {
  let d = paths.get(loops);
  if (d === undefined) {
    d = loops.map((loop) => `M${loop.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L')}Z`).join(' ');
    paths.set(loops, d);
  }
  return d;
};

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

/**
 * Draw the atlas: flat, or — given a `relief` view from `public/relief.js` —
 * with every room standing as tall as it is lively.
 */
export function renderAtlas(svg, view, { relief = null } = {}) {
  if (relief) return renderRelief(svg, view, relief);
  const doc = svg.ownerDocument;
  const el = (name, attrs = {}) => {
    const node = doc.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  };

  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const { curves, extent, subscription = [] } = view;
  const territories = new Map();
  const grounds = new Map();
  if (!curves?.length) return { territories, grounds };

  const pad = extent * 0.05;
  svg.setAttribute(
    'viewBox',
    `${-extent / 2 - pad} ${-extent / 2 - pad} ${extent + pad * 2} ${extent + pad * 2}`,
  );
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const held = new Set(subscription);

  // The rooms themselves, each on its own ground.
  //
  // The colour used to be an accident: translucent subject territories were
  // laid over one another and whatever the blend produced where they crossed
  // was the room. That made a room's colour a function of how many shapes
  // happened to overlap there rather than of what the room is, and it could
  // not carry anything of its own. Each room is now a filled shape, coloured
  // by its subjects and shaded by how busy it is.
  const rooms = new Map((view.rooms ?? []).map((r) => [r.key, r]));
  // Measured among the rooms drawn, not those only listed beside the map.
  const peak = Math.max(1, ...[...rooms.values()].filter((r) => !r.offMap).map((r) => r.stats?.perMinute ?? 0));

  for (const zone of view.zones ?? []) {
    if (!zone.loops?.length) continue;
    const ground = el('path', {
      d: pathOf(zone.loops),
      'fill-rule': 'evenodd',
      fill: regionFill(zone.subjects),
      'fill-opacity': heat(rooms.get(zone.key)?.stats, peak).toFixed(3),
      // Faint where they are not in it yet: one tap from its way in.
      class: `zone-ground${rooms.get(zone.key)?.member === false ? ' away' : ''}`,
      'data-room': cssId(zone.key),
      // The room itself, as it is written everywhere else: what a pointer
      // over this ground is pointing at. See `hit` in public/app.js.
      'data-zone': zone.key,
    });
    grounds.set(zone.key, ground);
    svg.append(ground);
  }

  // What each subject wears, laid over the rooms it takes in.
  //
  // This is the second channel, and the reason for it is that the first one
  // cannot be trusted on its own: hues come from a hash of the name, so two
  // subjects on screen together can land close enough to be the same colour,
  // and for anybody who cannot separate those hues at all they always are.
  // A subject the hierarchy can place is sown with its field's emblem, which
  // also says what kind of ground this is; one it cannot place gets a pattern
  // from a different hash than its hue, so a pair that collided on colour is
  // very unlikely to collide again here.
  //
  // Faint on purpose. It is there to be noticed, not to be read.
  const defs = el('defs');
  svg.append(defs);
  for (const curve of curves) {
    // Not the group's outline. It is laid over every room in the group, and
    // sown with a pattern it would cover all of them in the same one.
    if (isGroupRoom(curve.subject) || !hasPattern(curve.subject)) continue;
    const id = definePattern(doc, defs, curve.subject);
    svg.append(
      el('path', {
        d: pathOf(curve.loops),
        'fill-rule': 'evenodd',
        fill: `url(#${id})`,
        class: 'texture',
        'data-subject': cssId(curve.subject),
      }),
    );
  }

  // The subjects, as outlines over the rooms. A room says how busy it is; an
  // outline says which subjects it belongs to, and it keeps full strength so
  // that answer stays readable however quiet the ground beneath it.
  //
  // A group's own conversation is held by everybody holding anything in the
  // group, so its ground is every room in the group put together, and its
  // outline goes round all of them: it is drawn as the group's frame rather
  // than as one more interest. What is inside the frame is laid out as the
  // world outside is, since each interest in a group is anchored where its
  // twin outside is, and wears its colour.
  //
  // The frame is drawn last. Its edge is also the outer edge of whichever
  // rooms lie along it, and drawn first it was painted over by theirs, so the
  // line round the group came and went.
  const framesLast = [...curves].sort((a, b) => isGroupRoom(a.subject) - isGroupRoom(b.subject));
  for (const curve of framesLast) {
    const frame = isGroupRoom(curve.subject);
    const patch = el('path', {
      d: pathOf(curve.loops),
      'fill-rule': 'evenodd',
      fill: 'none',
      stroke: stroke(curve.subject),
      class: `territory${frame ? ' group-frame' : ''}${held.has(curve.subject) ? ' mine' : ''}`,
      'data-subject': cssId(curve.subject),
    });
    territories.set(curve.subject, patch);
    svg.append(patch);
  }

  for (const curve of curves) {
    const frame = isGroupRoom(curve.subject);
    // The group's name goes on its outline, at the top, like the name on the
    // edge of a folder: in the middle it sat on the rooms it wraps and read as
    // one of them. It is also the way into the group's own conversation,
    // which often has no ground of its own to be clicked.
    const at = frame ? topOf(curve.loops) ?? curve.anchor : curve.anchor;
    const text = el('text', {
      x: at.x,
      y: at.y,
      class: `atlas-label${frame ? ' group-name' : ''}${held.has(curve.subject) ? ' mine' : ''}`,
      'data-subject': cssId(curve.subject),
      ...(frame ? { 'data-room': curve.subject } : {}),
    });
    text.textContent = called(curve.subject);
    // A subject in two pieces is drawn in two pieces; say so rather than
    // letting it read as two different subjects that happen to share a colour.
    if (curve.components > 1) text.textContent += ` (${curve.components} parts)`;
    svg.append(text);
  }

  // The overlaps, named. They are the most interesting ground on the map and
  // were the only part of it left unlabelled, because the full names will not
  // fit in the space where subjects meet. Initials do: `mu + p + ma` for
  // music, philosophy and math, each shortened only as far as it can be
  // without becoming ambiguous among what is on screen.
  const labels = shortLabels(curves.map((c) => label(c.subject)));
  const written = [];

  for (const zone of view.zones ?? []) {
    // Counted without the group's own conversation: inside a group, the room
    // where art meets the outline is art's own room, named by art's label,
    // not an overlap to be spelled out.
    const says = named(zone.subjects);
    if (says.length < 2) continue;

    const spot = el('g', { class: 'zone-label', 'data-room': zone.key, 'data-zone': zone.key });
    const full = `${says.join(' and ')} · ${zone.population} here`;

    const title = doc.createElementNS(NS, 'title');
    title.textContent = full;

    const text = el('text', { x: zone.x, y: zone.y });
    text.textContent = abbreviate(says, labels);

    spot.append(title, text);
    spot.dataset.full = full;
    svg.append(spot);

    written.push({
      text,
      short: abbreviate(says, labels),
      long: says.join(' + '),
      room: zone.room ?? 0,
      size: 15,
    });
  }

  for (const curve of curves) {
    written.push({
      text: svg.querySelector(`text[data-subject="${cssId(curve.subject)}"]`),
      short: called(curve.subject),
      long: called(curve.subject),
      room: curve.anchor.room ?? 0,
      size: 20,
    });
  }

  return { territories, grounds, labels, written: written.filter((w) => w.text) };
}

/** How tall the liveliest room stands, and a silent one, as shares of the map. */
export const TALLEST = 0.16;
export const FLOOR = 0.02;

/** How many bands the tallest room is built from; see `renderRelief`. */
const BANDS = 36;

/** The corners of the box round a set of loops. */
function boxOf(loops) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const loop of loops ?? []) {
    for (const [x, y] of loop) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}

const meets = (p, q) => p.minX <= q.maxX && q.minX <= p.maxX && p.minY <= q.maxY && q.minY <= p.maxY;

/**
 * The atlas in relief. Every room is raised by how lively it has been lately
 * against the liveliest on the platform (`room.activity`, from the server),
 * and its top is the flat map's drawing of it — its colour, the emblems of
 * the subjects it belongs to, and the edges of those subjects' outlines —
 * cut to its own shape and lifted there. The walls underneath are the room's
 * colour, lighter or darker by which way they face.
 *
 * Built from the ground up: at each height a room's top stands at, the tops
 * of the rooms that stop there, then a stretch of wall up to the next such
 * height for each room that goes on up. See `public/relief.js` for why that
 * order needs no other sorting. Which of a room's walls face the viewer is
 * worked out once, and raised to each height a stretch needs.
 *
 * Returns what the flat drawing does, except that a subject's outline is now
 * one piece per room it runs along, so `territories` holds lists; and how
 * high the tallest room stands, for fitting the view round it.
 */
function renderRelief(svg, view, relief) {
  const doc = svg.ownerDocument;
  const el = (name, attrs = {}) => {
    const node = doc.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  };

  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const { curves, extent, subscription = [] } = view;
  const territories = new Map();
  const grounds = new Map();
  if (!curves?.length) return { territories, grounds, written: [], raised: 0 };

  const held = new Set(subscription);
  const rooms = new Map((view.rooms ?? []).map((r) => [r.key, r]));
  const peak = Math.max(1, ...[...rooms.values()].filter((r) => !r.offMap).map((r) => r.stats?.perMinute ?? 0));
  const band = (extent * TALLEST) / BANDS;
  const levelOf = (key) =>
    Math.max(1, Math.round(heightOf(rooms.get(key)?.activity, extent * TALLEST, extent * FLOOR) / band));

  const defs = el('defs');
  svg.append(defs);

  // Every outline once, to be laid on each room top it crosses.
  const shapes = curves.map((curve, i) => {
    const id = `relief-curve-${i}`;
    defs.append(el('path', { id, d: pathOf(curve.loops), 'fill-rule': 'evenodd' }));
    const frame = isGroupRoom(curve.subject);
    return {
      curve,
      id,
      frame,
      box: boxOf(curve.loops),
      pattern: !frame && hasPattern(curve.subject) ? definePattern(doc, defs, curve.subject) : null,
    };
  });

  const raised = (view.zones ?? [])
    .filter((zone) => zone.loops?.length)
    .map((zone, i) => {
      const id = `relief-zone-${i}`;
      defs.append(el('path', { id, d: pathOf(zone.loops), 'fill-rule': 'evenodd' }));
      const clip = el('clipPath', { id: `${id}-clip` });
      clip.append(el('use', { href: `#${id}` }));
      defs.append(clip);

      const colour = regionFill(zone.subjects);
      const level = levelOf(zone.key);
      const box = boxOf(zone.loops);
      const corners = [[box.minX, box.minY], [box.maxX, box.minY], [box.minX, box.maxY], [box.maxX, box.maxY]];
      return {
        zone,
        id,
        colour,
        level,
        box,
        depth: relief.depth(zone.x, zone.y),
        // Its walls that face the viewer, raised to each height they are
        // needed at by `wallsOf`, and remembered by height.
        runs: wallRuns(zone.loops, relief),
        walls: new Map(),
        // All of it that is drawn, walls and top, and the box round it from the
        // floor to its top, for keeping it off the screen when it is off the
        // view; see `cullRelief`.
        seen: { box: boxAround(relief.at, corners, [0, level * band]), nodes: [] },
      };
    });

  // A room's walls, `bands` high, defined once and used by reference
  // wherever a stretch of that height is needed. Reaching a shade past the
  // top, as every band did, so nothing stacked on them leaves a seam.
  const wallsOf = (room, bands) => {
    let wallId = room.walls.get(bands);
    if (!wallId) {
      wallId = `${room.id}-walls-${bands}`;
      const walls = ribbons(room.runs, relief, bands * band, (bands + 0.15) * band);
      const strip = el('g', { id: wallId });
      for (const kind of ['lit', 'side', 'shade']) {
        if (walls[kind]) strip.append(el('path', { d: walls[kind], fill: shade(room.colour, WALLS[kind]), class: 'wall' }));
      }
      defs.append(strip);
      room.walls.set(bands, wallId);
    }
    return wallId;
  };
  const byKey = new Map(raised.map((r) => [r.zone.key, r]));

  // The floor. Only the group's frame is drawn on it: it goes round every
  // room in the group, so it is the line along their feet.
  const floor = el('g', { class: 'relief-floor', transform: relief.matrix(0) });
  svg.append(floor);
  for (const shape of shapes.filter((s) => s.frame)) {
    const patch = el('path', {
      d: pathOf(shape.curve.loops),
      'fill-rule': 'evenodd',
      fill: 'none',
      stroke: stroke(shape.curve.subject),
      class: `territory group-frame${held.has(shape.curve.subject) ? ' mine' : ''}`,
      'data-subject': cssId(shape.curve.subject),
    });
    territories.set(shape.curve.subject, [patch]);
    floor.append(patch);
  }

  const top = (room) => {
    const { zone, id, colour, level, box } = room;
    const at = el('g', {
      class: 'relief-top',
      transform: relief.matrix(level * band),
      'clip-path': `url(#${id}-clip)`,
      'data-zone': zone.key,
    });
    // Solid underneath, so the room's own colour can keep saying how busy it
    // is by how strongly it is laid on, as it does flat, without the walls
    // behind showing through.
    at.append(el('use', { href: `#${id}`, class: 'relief-base' }));
    const ground = el('use', {
      href: `#${id}`,
      fill: colour,
      'fill-opacity': heat(rooms.get(zone.key)?.stats, peak).toFixed(3),
      class: `zone-ground${rooms.get(zone.key)?.member === false ? ' away' : ''}`,
      'data-room': cssId(zone.key),
      'data-zone': zone.key,
    });
    grounds.set(zone.key, ground);
    at.append(ground);

    const near = shapes.filter((s) => !s.frame && meets(s.box, box));
    for (const shape of near) {
      if (!shape.pattern || !zone.subjects.includes(shape.curve.subject)) continue;
      at.append(
        el('use', {
          href: `#${shape.id}`,
          fill: `url(#${shape.pattern})`,
          class: 'texture',
          'data-subject': cssId(shape.curve.subject),
        }),
      );
    }
    for (const shape of near) {
      const subject = shape.curve.subject;
      const edge = el('use', {
        href: `#${shape.id}`,
        fill: 'none',
        stroke: stroke(subject),
        class: `territory${held.has(subject) ? ' mine' : ''}`,
        'data-subject': cssId(subject),
      });
      if (!territories.has(subject)) territories.set(subject, []);
      territories.get(subject).push(edge);
      at.append(edge);
    }
    return at;
  };

  // From the floor up, stopping only at the heights where some room's top
  // is. Between one of those and the next nothing else is drawn, so each
  // room's wall across that stretch is one shape rather than a band for every
  // level in it: the same walls, in the same order against everything else,
  // in a fraction of the shapes. Every band had been a shape of its own to
  // rasterise, and they were most of what moving the map cost.
  const scene = el('g', { class: 'relief' });
  svg.append(scene);
  const backFirst = [...raised].sort((p, q) => p.depth - q.depth);
  const highest = Math.max(0, ...raised.map((r) => r.level));
  const stops = [...new Set([0, ...raised.map((r) => r.level)])].sort((a, b) => a - b);
  stops.forEach((level, i) => {
    for (const room of backFirst) {
      if (room.level !== level) continue;
      const lid = top(room);
      room.seen.nodes.push(lid);
      scene.append(lid);
    }
    const next = stops[i + 1];
    if (next === undefined) return;
    for (const room of backFirst) {
      if (room.level <= level) continue;
      const wall = el('use', {
        href: `#${wallsOf(room, next - level)}`,
        transform: `translate(0 ${(-level * band * relief.lift).toFixed(2)})`,
        'data-zone': room.zone.key,
      });
      room.seen.nodes.push(wall);
      scene.append(wall);
    }
  });

  // Names last, standing upright over everything at the height of whatever
  // they name, so a tall room in front never hides what is behind it.
  const heightAt = (x, y) => (byKey.get(zoneAt(curves, x, y))?.level ?? 0) * band;
  const labels = shortLabels(curves.map((c) => label(c.subject)));
  const written = [];

  for (const { curve, frame } of shapes) {
    let at;
    if (frame) {
      // On the frame, at whichever point of it is highest on the screen.
      for (const loop of curve.loops) {
        for (const [gx, gy] of loop) {
          const p = relief.at(gx, gy, 0);
          if (!at || p[1] < at[1]) at = p;
        }
      }
    }
    const [x, y] = at ?? relief.at(curve.anchor.x, curve.anchor.y, heightAt(curve.anchor.x, curve.anchor.y));
    const text = el('text', {
      x: x.toFixed(1),
      y: y.toFixed(1),
      class: `atlas-label${frame ? ' group-name' : ''}${held.has(curve.subject) ? ' mine' : ''}`,
      'data-subject': cssId(curve.subject),
      ...(frame ? { 'data-room': curve.subject } : {}),
    });
    text.textContent = called(curve.subject);
    if (curve.components > 1) text.textContent += ` (${curve.components} parts)`;
    svg.append(text);
    written.push({ text, short: called(curve.subject), long: called(curve.subject), room: curve.anchor.room ?? 0, size: 20 });
  }

  for (const { zone, level } of raised) {
    const says = named(zone.subjects);
    if (says.length < 2) continue;
    const [x, y] = relief.at(zone.x, zone.y, level * band);
    const spot = el('g', { class: 'zone-label', 'data-room': zone.key, 'data-zone': zone.key });
    const full = `${says.join(' and ')} · ${zone.population} here`;
    const title = doc.createElementNS(NS, 'title');
    title.textContent = full;
    const text = el('text', { x: x.toFixed(1), y: y.toFixed(1) });
    text.textContent = abbreviate(says, labels);
    spot.append(title, text);
    spot.dataset.full = full;
    svg.append(spot);
    written.push({ text, short: abbreviate(says, labels), long: says.join(' + '), room: zone.room ?? 0, size: 15 });
  }

  return { territories, grounds, labels, written, raised: highest * band, cull: raised.map((r) => r.seen) };
}

/**
 * Keep the rooms of a map in relief that are out of view off the screen, and
 * put back those that come into it; see `public/cull.js`. A room's box holds
 * everything it draws, from its walls' feet to its top, so it is culled only
 * when none of it could be seen. A tenth of the view is kept on every side,
 * so a drag brings on what was already there.
 *
 * @param {Array<{box: object, nodes: Element[], on?: boolean}>} parts  from `renderAtlas`
 * @param {{x: number, y: number, width: number, height: number}} view  the viewBox
 * @returns {number}  how many rooms are in view
 */
export function cullRelief(parts, view) {
  if (!parts?.length || !view) return 0;
  return cullTo(parts, viewBoxOf(view, view.width * 0.1, view.height * 0.1));
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
  // Which lettering the labels are in, asked once and only if something has
  // to be measured: a width measured in one typeface is no use in another.
  let face = null;
  const faceOf = () =>
    (face ??= written.length ? (globalThis.getComputedStyle?.(written[0].text)?.fontFamily ?? '') : '');
  for (const label of written) {
    const size = label.size / Math.max(scale, 1e-6);
    const at = size.toFixed(2);
    // Both, and the inline style is the one that does anything in a browser:
    // a presentation attribute has no specificity at all, so the stylesheet's
    // `.atlas-label` and `.zone-label text` rules beat it and the labels held
    // whatever size the CSS said however far the map was zoomed. The attribute
    // stays for rasterisers, which never apply the stylesheet.
    if (label.at !== at) {
      label.text.setAttribute('font-size', at);
      label.text.style.fontSize = `${at}px`;
      label.at = at;
    }

    // Room is a radius; a label laid across the middle of it has twice that.
    const fits = label.long !== label.short && longWidth(label, size, faceOf) * size <= label.room * 1.9;
    const spelled = fits ? label.long : label.short;
    // Written only when it changes. Every pan and every zoom used to write
    // every label twice over — once to measure, once to settle — so a map
    // nobody had changed was never still, and each write had the page lay
    // the whole drawing out again on the spot.
    if (label.text.textContent !== spelled) label.text.textContent = spelled;
  }
}

/**
 * How wide a label's long form is for each unit of its size. Measured once,
 * since text grows exactly with its size, and remembered on the label; where
 * it cannot be measured (headless, or not on screen yet) estimated from its
 * length, and asked again next time.
 *
 * Remembered past the label, too, by what it says and how it is set. In
 * relief the map is drawn again for every frame it is turned, every label
 * with it, and each new label measured itself: a write, a read, and the page
 * made to lay the whole drawing out on the spot, a dozen times a frame.
 */
const widths = new Map();
function longWidth(label, size, faceOf = () => '') {
  if (label.perUnit) return label.perUnit;
  const key = `${faceOf()}|${label.text.getAttribute('class') ?? ''}|${label.size}|${label.long}`;
  const known = widths.get(key);
  if (known) {
    label.perUnit = known;
    return known;
  }
  const was = label.text.textContent;
  label.text.textContent = label.long;
  const measured = label.text.getComputedTextLength?.();
  label.text.textContent = was;
  if (Number.isFinite(measured) && measured > 0) {
    label.perUnit = measured / size;
    widths.set(key, label.perUnit);
    return label.perUnit;
  }
  return label.long.length * 0.55;
}

/**
 * Light the territories that a selected room reaches.
 *
 * The same predicate as delivery, as on the circle map: a subject is lit when
 * the room's subjects are all contained in — no, when the room is posted to,
 * everyone holding all of it hears, so the lit ground is the intersection of
 * exactly those subjects.
 */
/**
 * How strongly a room is drawn: how busy it is, from quiet to talking.
 *
 * Measured against the busiest room in the same view rather than against an
 * absolute number of messages, because "busy" only means anything next to the
 * rooms beside it — five a minute is a lot in a place of eight people and
 * nothing in a place of eight hundred.
 *
 * The floor is the important part. A room nobody has spoken in yet is the
 * whole premise of this place, and fading it to nothing would hide the rooms
 * most in need of somebody arriving. Quiet is faint; quiet is never invisible.
 */
export const QUIET = 0.14;
export const LOUD = 0.55;

export function heat(stats, peak = 1) {
  const rate = stats?.perMinute ?? 0;
  if (!rate) return QUIET;
  // The square root, so the difference between silent and occasional shows as
  // clearly as the difference between busy and busier.
  const share = Math.min(1, Math.sqrt(rate / Math.max(peak, 1e-9)));
  return QUIET + (LOUD - QUIET) * share;
}

/**
 * Light the room being read, and the subjects it belongs to.
 *
 * The selected room used to be shown by raising its opacity, which is no
 * longer free: opacity says how busy a room is, and two meanings on one
 * channel is one of them being wrong. Selection is a ring instead.
 */
export function paintAtlas(territories, selected, grounds) {
  const tags = selected ? parse(selected) : [];
  // One outline per subject flat, one piece per room it runs along in relief.
  for (const [subject, nodes] of territories) {
    for (const node of [].concat(nodes)) node.classList.toggle('lit', tags.length > 0 && tags.includes(subject));
  }
  for (const [key, node] of grounds ?? []) {
    node.classList.toggle('on', key === selected);
  }
  return tags.length > 0 && receives(tags, tags);
}
