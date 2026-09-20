/**
 * Where subjects sit, before anybody joins them.
 *
 * The atlas places subjects by shared membership alone: two subjects are drawn
 * near each other when the same people hold both. That is honest about the
 * community and useless as a map. Topology and geometry are drawn as strangers
 * until somebody happens to hold both; a brand new subject has no position at
 * all; and every coordinate shifts as people come and go, which is exactly the
 * instability that makes the atlas a snapshot rather than a surface.
 *
 * A knowledge hierarchy supplies the missing half: a position each subject has
 * by virtue of what it *is*, independent of who turned up. Membership then
 * adjusts rather than determines — the prior anchors, and people bridging two
 * subjects pull them together from there.
 *
 * Laid out radially, because a hierarchy drawn that way has the properties a
 * map wants: siblings adjacent, cousins near, unrelated branches far apart,
 * and the whole of it deterministic.
 */

/** A branch's share of the circle is its share of the leaves beneath it. */
function leafCount(node, children, seen = new Set()) {
  if (seen.has(node)) return 1; // a cycle; treat it as a leaf and move on
  seen.add(node);
  const kids = children.get(node);
  if (!kids?.length) return 1;
  let total = 0;
  for (const kid of kids) total += leafCount(kid, children, seen);
  return total;
}

/**
 * Coordinates for every node of a hierarchy.
 *
 * @param {Record<string,string>} parents  child -> parent; roots simply have no entry
 * @param {object} [options]
 * @param {number} [options.extent=1000]  width of the plane the layout fills
 * @param {number} [options.innerRadius=0.2]  how far the first ring sits from the middle
 * @param {number} [options.outerReach=0.78]  how much of the radius the deepest nodes use
 * @returns {Map<string, {x: number, y: number, depth: number, branch: string}>}
 */
export function radialLayout(parents, options = {}) {
  const { extent = 1000, innerRadius = 0.2, outerReach = 0.78 } = options;

  const children = new Map();
  const everyone = new Set();
  for (const [child, parent] of Object.entries(parents)) {
    everyone.add(child);
    everyone.add(parent);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(child);
  }
  // Sorted, so the same hierarchy always produces the same map.
  for (const kids of children.values()) kids.sort();

  const roots = [...everyone].filter((n) => !(n in parents)).sort();

  // Every node having a parent means the whole thing is a cycle, and returning
  // nothing at all is the wrong answer — Wikipedia's category graph is full of
  // cycles, so a hierarchy baked from one will land here and deserves better
  // than an empty map and no explanation. Break it at a deterministic point
  // and lay out what is there; `place` already refuses to revisit a node.
  if (!roots.length) {
    const widest = [...everyone].sort(
      (a, b) => (children.get(b)?.length ?? 0) - (children.get(a)?.length ?? 0) || a.localeCompare(b),
    )[0];
    if (!widest) return new Map();
    roots.push(widest);
  }

  const depthOf = new Map();
  let deepest = 0;
  const measure = (node, depth, seen) => {
    if (seen.has(node)) return;
    seen.add(node);
    depthOf.set(node, depth);
    deepest = Math.max(deepest, depth);
    for (const kid of children.get(node) ?? []) measure(kid, depth + 1, seen);
  };
  for (const root of roots) measure(root, roots.length > 1 ? 1 : 0, new Set());

  const positions = new Map();
  const span = extent / 2;

  const place = (node, from, to, branch, seen, wedgeIndex = 0) => {
    if (seen.has(node)) return;
    seen.add(node);

    const depth = depthOf.get(node) ?? 0;
    const angle = (from + to) / 2;

    // Depth alone put every leaf on the rim. Real catalogues are mostly leaves
    // at the same depth, so that meant every actual subject strung around the
    // edge of an empty disc, maximally far from each other — which wasted the
    // middle and left the subjects too distant for anything to grow between
    // them. A square root fills the area evenly instead of the circumference,
    // and the band each node may sit in lets siblings spread radially rather
    // than share one arc.
    const t = deepest === 0 ? 0 : depth / deepest;
    const band = innerRadius + (1 - innerRadius) * Math.sqrt(t);
    const spread = ((wedgeIndex % 3) - 1) * 0.07;
    const radius = span * outerReach * Math.min(1, Math.max(innerRadius, band + spread));

    positions.set(node, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      depth,
      branch,
    });

    const kids = children.get(node) ?? [];
    if (!kids.length) return;

    const total = kids.reduce((sum, kid) => sum + leafCount(kid, children), 0) || 1;
    let cursor = from;
    for (const kid of kids) {
      const share = (leafCount(kid, children) / total) * (to - from);
      place(kid, cursor, cursor + share, branch, seen, kids.indexOf(kid));
      cursor += share;
    }
  };

  const seen = new Set();
  const perRoot = (Math.PI * 2) / roots.length;
  roots.forEach((root, i) => place(root, i * perRoot, (i + 1) * perRoot, root, seen));

  return positions;
}

/**
 * Find a subject's place in a hierarchy that may not name it exactly.
 *
 * Real catalogues are full of "modern painting" and "history of jazz" — a
 * facet on a subject the hierarchy does know. Rather than leave those
 * unplaced, the longest known suffix wins, so "early nordic weaving" lands
 * where weaving is and the map stays readable without anyone curating every
 * phrasing.
 */
export function resolve(subject, positions) {
  if (positions.has(subject)) return positions.get(subject);

  const words = String(subject).toLowerCase().split(/\s+/);
  for (let start = 1; start < words.length; start++) {
    const tail = words.slice(start).join(' ');
    if (positions.has(tail)) return positions.get(tail);
  }
  return null;
}

/**
 * Anchors for a set of subjects: what each one's position should be before
 * membership has any say. Subjects the hierarchy has never heard of are left
 * out rather than guessed at, and the atlas falls back to co-membership for
 * those — a map that invents a location for something it knows nothing about
 * is worse than one that admits the gap.
 */
export function anchorsFor(subjects, positions) {
  const anchors = new Map();
  for (const subject of subjects) {
    const at = resolve(subject, positions);
    if (at) anchors.set(subject, { x: at.x, y: at.y });
  }
  return anchors;
}

/** Every subject the hierarchy knows, for checking coverage. */
export const known = (parents) => new Set(Object.keys(parents));
