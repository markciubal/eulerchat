import { key, parse, receives } from '../lib/regions.js';
import { blend, cssId, hue, regionFill, stroke } from '../lib/palette.js';

// Re-exported so the browser modules have one import site for colour.
export { blend, cssId, hue, regionFill, stroke };

export const NS = 'http://www.w3.org/2000/svg';

/**
 * The set of circles containing a point *is* the region, and the region is the
 * room. This is the whole spatial conceit and it is four lines: there is no
 * table mapping places to rooms, because a place already is one.
 *
 * It is also the same predicate the layout auditor samples with, so what a
 * click selects and what the solver believes it drew cannot disagree.
 */
export function regionAt(circles, x, y) {
  const inside = circles
    .filter((c) => (x - c.x) ** 2 + (y - c.y) ** 2 <= c.r * c.r)
    .map((c) => c.id);
  return inside.length ? key(inside) : null;
}

/**
 * Which drawn regions a selected room actually covers.
 *
 * Regions are drawn exclusively — the fill for `art` is art minus everything
 * else — but delivery is by containment, so a post to `art` reaches the whole
 * art circle including the parts shared with philosophy and music. Lighting
 * only the exclusive sliver would show partition semantics over a product that
 * routes by containment, and the single-subject rooms would look far smaller
 * than they are.
 *
 * The predicate is `receives` itself, so the lit area is exactly the audience:
 * the region receives what the selected room sends.
 */
export function scopeOf(roomKeys, selected) {
  if (!selected) return new Set();
  const tags = parse(selected);
  return new Set(roomKeys.filter((k) => receives(parse(k), tags)));
}


/**
 * Draw the diagram into `svg`.
 *
 * Returns the fill element per region so the caller can light one up without
 * re-rendering, and the viewBox so hit-testing can share the same user space.
 */
export function renderDiagram(svg, diagram) {
  const doc = svg.ownerDocument;
  const el = (name, attrs = {}) => {
    const node = doc.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  };

  const { circles, bounds, rooms, subscription = [], suggested = [] } = diagram;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const fills = new Map();

  if (!circles.length) return { fills, viewBox: null };

  const pad = 34;
  const vb = {
    x: bounds.minX - pad,
    y: bounds.minY - pad,
    w: Math.max(bounds.width + pad * 2, 1),
    h: Math.max(bounds.height + pad * 2, 1),
  };
  svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const defs = el('defs');
  for (const c of circles) {
    const clip = el('clipPath', { id: `clip-${cssId(c.id)}` });
    clip.append(el('circle', { cx: c.x, cy: c.y, r: c.r }));
    defs.append(clip);
  }

  // Every drawn region is an occupied one: `rooms` comes straight from the
  // census, so nothing here exists merely because two shapes happen to cross.
  for (const room of rooms) {
    const mask = el('mask', {
      id: `mask-${cssId(room.key)}`,
      maskUnits: 'userSpaceOnUse',
      x: vb.x,
      y: vb.y,
      width: vb.w,
      height: vb.h,
    });
    mask.append(el('rect', { x: vb.x, y: vb.y, width: vb.w, height: vb.h, fill: 'white' }));
    for (const c of circles) {
      if (!room.subjects.includes(c.id)) {
        mask.append(el('circle', { cx: c.x, cy: c.y, r: c.r, fill: 'black' }));
      }
    }
    defs.append(mask);
  }
  svg.append(defs);

  // A region is the intersection of its own circles — nested clips, which
  // compose by intersection — minus every circle it excludes, via the mask.
  for (const room of rooms) {
    const fill = el('rect', {
      x: vb.x,
      y: vb.y,
      width: vb.w,
      height: vb.h,
      fill: regionFill(room.subjects),
      class: 'region-fill',
      opacity: 0.16,
    });
    fills.set(room.key, fill);

    let node = fill;
    for (const subject of room.subjects) {
      const wrap = el('g', { 'clip-path': `url(#clip-${cssId(subject)})` });
      wrap.append(node);
      node = wrap;
    }
    const masked = el('g', { mask: `url(#mask-${cssId(room.key)})` });
    masked.append(node);
    svg.append(masked);
  }

  const held = new Set(subscription);
  const proposed = new Set(suggested);
  for (const c of circles) {
    svg.append(
      el('circle', {
        cx: c.x,
        cy: c.y,
        r: c.r,
        stroke: stroke(c.id),
        class: `ring${held.has(c.id) ? ' mine' : ''}${proposed.has(c.id) ? ' suggested' : ''}`,
      }),
    );
  }

  // Labels ride the outer edge, away from the crowded middle where the
  // intersections are.
  const cx = circles.reduce((s, c) => s + c.x, 0) / circles.length;
  const cy = circles.reduce((s, c) => s + c.y, 0) / circles.length;
  for (const c of circles) {
    let dx = c.x - cx;
    let dy = c.y - cy;
    const len = Math.hypot(dx, dy);
    if (circles.length === 1 || len < 1e-6) {
      dx = 0;
      dy = -1;
    } else {
      dx /= len;
      dy /= len;
    }
    const lx = c.x + dx * c.r * 0.66;
    const ly = c.y + dy * c.r * 0.66;

    const label = el('text', { x: lx, y: ly, class: 'label' });
    label.textContent = c.id;
    const count = el('text', { x: lx, y: ly + 14, class: 'label-count' });
    count.textContent = String(c.population);
    svg.append(label, count);
  }

  return { fills, viewBox: vb };
}
