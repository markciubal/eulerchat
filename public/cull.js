/**
 * Which of the things drawn are in view, without asking the page.
 *
 * A browser will lay out, style, paint and rasterise everything in an SVG,
 * whether or not the viewBox shows it. Zoomed in on All interests, that was a
 * thousand columns worked on for every frame so that sixty of them could be
 * seen. So everything that can be culled carries a box round it, worked out
 * from the same numbers that placed it, and the view is a box too.
 *
 * Two boxes whose sides run the same way are apart exactly when one lies
 * wholly to the left, the right, above or below the other: four comparisons,
 * with no geometry and nothing measured. Anything not apart from the view is
 * drawn, and anything apart from it is not. The boxes are generous, so the
 * test can only ever keep something that turns out to be just out of sight,
 * never drop something that is in it.
 */

/**
 * @typedef {{x0: number, y0: number, x1: number, y1: number}} Box
 */

/** Whether two boxes share any point: neither is wholly to one side of the other. */
export const overlaps = (a, b) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;

/**
 * A viewBox as a box, grown by a margin on every side: a little of what is
 * just off the edge is kept, so that a drag reveals something already drawn
 * rather than a gap that fills in a frame later.
 *
 * @param {{x: number, y: number, width: number, height: number}} view
 * @param {number} [mx]  in the view's own units
 * @param {number} [my]
 * @returns {Box}
 */
export function viewBoxOf(view, mx = 0, my = mx) {
  return { x0: view.x - mx, y0: view.y - my, x1: view.x + view.width + mx, y1: view.y + view.height + my };
}

/**
 * The box round some points, each at some heights, once a view has laid them
 * out: the corners of a patch of ground and how tall it stands, say. A view
 * that turns and tilts is a straight-line map, so the box round where the
 * corners land holds everything between them.
 *
 * @param {(x: number, y: number, h?: number) => [number, number]} at  where a point lands
 * @param {Array<[number, number]>} points
 * @param {number[]} [heights]
 * @returns {Box}
 */
export function boxAround(at, points, heights = [0]) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of points) {
    for (const h of heights) {
      const [X, Y] = at(x, y, h);
      if (X < x0) x0 = X;
      if (Y < y0) y0 = Y;
      if (X > x1) x1 = X;
      if (Y > y1) y1 = Y;
    }
  }
  return { x0, y0, x1, y1 };
}

/**
 * Show what is in view and hide what is not, touching only what changed.
 *
 * Each part is `{ box, nodes, on }`. `on` is remembered between calls, and a
 * part that has never been culled counts as shown, which is how it was drawn.
 * So a drag that keeps everything where it was writes nothing at all, and one
 * that brings a column into view writes to that column alone. Hiding is a
 * class, never taking nodes out: what is drawn stays drawn, and only whether
 * it is painted changes.
 *
 * @param {Array<{box: Box, nodes: Element[], on?: boolean}>} parts
 * @param {Box} view
 * @param {(part: object, on: boolean) => void} [changed]  told of each part that came or went
 * @returns {number}  how many are in view
 */
export function cullTo(parts, view, changed) {
  let shown = 0;
  for (const part of parts) {
    const on = overlaps(part.box, view);
    if (on) shown += 1;
    if ((part.on ?? true) === on) continue;
    part.on = on;
    for (const node of part.nodes) node.classList.toggle('culled', !on);
    changed?.(part, on);
  }
  return shown;
}
