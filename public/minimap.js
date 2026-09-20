import { NS, stroke } from './diagram.js';

/**
 * The whole map, small, and where you are in it.
 *
 * A view can only draw a handful of subjects legibly, so it is always a
 * neighbourhood — which leaves someone with no idea what else exists or
 * whereabouts they are among it. The minimap is the other half: every subject
 * at its place in the knowledge hierarchy, the ones they hold picked out, and
 * a frame around the patch their interests actually occupy.
 *
 * Drawn in hierarchy coordinates rather than the atlas's, which is what makes
 * it stable — the overview is the same picture for everyone, and only the
 * highlighting differs.
 */

/**
 * Set `svg`'s viewBox so `points` are framed with exactly `pad` screen pixels
 * of margin, whatever the zoom.
 *
 * Padding given in pixels cannot simply be added to a viewBox, because the
 * viewBox is in user units and the scale between them is what is being solved
 * for — widening the box to make room shrinks the very margin it was widening
 * for. So the scale is derived first from the pixels actually available, and
 * the box follows from it.
 */
export function fitTo(svg, points, pad = 20) {
  const box = svg.getBoundingClientRect?.() ?? { width: 0, height: 0 };
  const W = box.width || 600;
  const H = box.height || 600;
  if (!points.length) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  // A single point has no extent to fit; give it something to sit in.
  const content = { w: Math.max(maxX - minX, 1e-6), h: Math.max(maxY - minY, 1e-6) };
  const usableW = Math.max(1, W - pad * 2);
  const usableH = Math.max(1, H - pad * 2);
  const scale = Math.min(usableW / content.w, usableH / content.h);

  const width = W / scale;
  const height = H / scale;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const view = { x: cx - width / 2, y: cy - height / 2, width, height };

  svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.width} ${view.height}`);
  // The box already accounts for the element's own aspect, so stretching it
  // again here would undo the padding that was just solved for.
  svg.setAttribute('preserveAspectRatio', 'none');
  return view;
}

/** Every point along every loop, for fitting to a set of territories. */
export function pointsOf(curves, subjects) {
  const wanted = subjects?.length ? new Set(subjects) : null;
  const points = [];
  for (const curve of curves) {
    if (wanted && !wanted.has(curve.subject)) continue;
    for (const loop of curve.loops) points.push(...loop);
  }
  return points;
}

export function renderMinimap(svg, overview, { mine = [], pad = 20 } = {}) {
  const doc = svg.ownerDocument;
  const el = (name, attrs = {}) => {
    const node = doc.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  };

  while (svg.firstChild) svg.removeChild(svg.firstChild);
  if (!overview?.subjects?.length) return null;

  const held = new Set(mine);
  const extent = overview.extent ?? 1000;
  const span = extent / 2;
  svg.setAttribute('viewBox', `${-span} ${-span} ${extent} ${extent}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const biggest = Math.max(1, ...overview.subjects.map((s) => s.n));

  // Everything, faintly. Area carries population here as it does everywhere
  // else, so a glance at the minimap is a glance at where the people are.
  const all = el('g');
  for (const subject of overview.subjects) {
    const r = Math.max(1.6, Math.sqrt(subject.n / biggest) * 13);
    all.append(
      el('circle', {
        cx: subject.x,
        cy: subject.y,
        r,
        fill: stroke(subject.id),
        'fill-opacity': held.has(subject.id) ? 0.95 : subject.known ? 0.3 : 0.16,
        class: held.has(subject.id) ? 'dot mine' : 'dot',
      }),
    );
  }
  svg.append(all);

  // The frame: the patch of the map their own interests occupy.
  const ours = overview.subjects.filter((s) => held.has(s.id));
  if (!ours.length) return null;

  const xs = ours.map((s) => s.x);
  const ys = ours.map((s) => s.y);
  const margin = extent * 0.04;
  const frame = {
    x: Math.min(...xs) - margin,
    y: Math.min(...ys) - margin,
    width: Math.max(...xs) - Math.min(...xs) + margin * 2,
    height: Math.max(...ys) - Math.min(...ys) + margin * 2,
  };
  svg.append(el('rect', { ...frame, rx: 10, class: 'here' }));
  void pad;
  return frame;
}
