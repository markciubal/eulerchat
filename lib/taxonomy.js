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
 * Laid out on a disc, a patch to each branch, because a hierarchy drawn that
 * way has the properties a map wants: siblings adjacent, cousins near,
 * unrelated branches far apart, and the whole of it deterministic.
 */

import { label } from './cluster.js';

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** The gutter round the broadest branches, as a share of the plane's width. */
const GUTTER = 0.01;

/**
 * Coordinates for every node of a hierarchy.
 *
 * Every node owns a patch of the disc in proportion to how much sits beneath
 * it, and its children divide that patch between them. A patch is a piece of
 * a ring: between two angles and between two radii. It is cut into bands by
 * radius and each band into cells by angle, with the number of bands chosen
 * so the cells come out about as deep as they are wide.
 *
 * That last part is the point, and it is what the first version got wrong. It
 * gave each branch a wedge of the circle and each depth a ring, which is fine
 * for three hundred names and falls apart at a thousand: a field of fourteen
 * subjects was a sliver five degrees wide and a hundred units long, so the two
 * ends of `mathematics` were further apart than `algebra` was from `baking`
 * in the wedge next door. A compact patch keeps a field's subjects nearer to
 * each other than to anybody else's, which is the only promise this makes.
 *
 * A node sits in a cell of its own among its children, in the middle of the
 * order, so `biology` is found amid its subfields rather than off to one side
 * of them.
 *
 * @param {Record<string,string>} parents  child -> parent; roots simply have no entry
 * @param {object} [options]
 * @param {number} [options.extent=1000]  width of the plane the layout fills
 * @param {number} [options.innerRadius=0.2]  how much of the middle is left clear
 * @param {number} [options.outerReach=0.78]  how much of the radius the outermost nodes use
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
  // and lay out what is there; nothing below visits a node twice.
  if (!roots.length) {
    const widest = [...everyone].sort(
      (a, b) => (children.get(b)?.length ?? 0) - (children.get(a)?.length ?? 0) || a.localeCompare(b),
    )[0];
    if (!widest) return new Map();
    roots.push(widest);
  }

  // The hierarchy as a tree: each node under the first parent that reaches it.
  // A graph with a cycle or a shared child becomes one here, once, so that
  // weighing and placing agree about what is under what.
  const under = new Map();
  const depthOf = new Map();
  const claim = (node, depth) => {
    depthOf.set(node, depth);
    const kids = (children.get(node) ?? []).filter((kid) => !depthOf.has(kid));
    // Claimed before descending, so a grandchild cannot take one of them first.
    for (const kid of kids) depthOf.set(kid, depth + 1);
    under.set(node, kids);
    for (const kid of kids) claim(kid, depth + 1);
  };
  for (const root of roots) if (!depthOf.has(root)) claim(root, roots.length > 1 ? 1 : 0);

  // A node weighs one for itself and whatever its children weigh, since every
  // name needs somewhere to sit and not only the ones at the ends.
  const weightOf = new Map();
  const weigh = (node) => {
    let total = 1;
    for (const kid of under.get(node) ?? []) total += weigh(kid);
    weightOf.set(node, total);
    return total;
  };
  for (const root of roots) weigh(root);

  const positions = new Map();
  const reach = (extent / 2) * outerReach;

  /** Put `node` down in the middle of a patch. */
  const settle = (node, branch, a0, a1, r0, r1) => {
    const angle = (a0 + a1) / 2;
    // The radius with half the patch's area on either side of it, rather than
    // the midpoint, which on a ring sits nearer the inside than it looks.
    const radius = Math.sqrt((r0 * r0 + r1 * r1) / 2);
    positions.set(node, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      depth: depthOf.get(node) ?? 0,
      branch,
    });
  };

  /** Divide a patch between `items`, each `{node, weight, self}`. */
  const divide = (items, branch, a0, a1, r0, r1) => {
    const total = items.reduce((sum, item) => sum + item.weight, 0);
    const deep = r1 - r0;
    const wide = (a1 - a0) * ((r0 + r1) / 2);
    const wanted = Math.round(Math.sqrt((items.length * deep) / Math.max(wide, 1e-9)));
    const bands = Math.max(1, Math.min(items.length, wanted));

    // Into bands by where the middle of each item's weight falls, which keeps
    // the order and cannot leave a heavy item straddling two of them.
    const rows = Array.from({ length: bands }, () => []);
    let before = 0;
    for (const item of items) {
      const middle = (before + item.weight / 2) / total;
      rows[Math.min(bands - 1, Math.floor(middle * bands))].push(item);
      before += item.weight;
    }

    let inside = 0;
    for (const row of rows) {
      if (!row.length) continue;
      const rowWeight = row.reduce((sum, item) => sum + item.weight, 0);
      // Area goes with the square of the radius, so the bands are cut there.
      const from = Math.sqrt(r0 * r0 + ((r1 * r1 - r0 * r0) * inside) / total);
      inside += rowWeight;
      const to = Math.sqrt(r0 * r0 + ((r1 * r1 - r0 * r0) * inside) / total);

      let cursor = a0;
      for (const item of row) {
        const share = ((a1 - a0) * item.weight) / rowWeight;
        if (item.self) settle(item.node, branch, cursor, cursor + share, from, to);
        else place(item.node, branch, cursor, cursor + share, from, to);
        cursor += share;
      }
    }
  };

  const place = (node, branch, a0, a1, r0, r1) => {
    const kids = under.get(node) ?? [];
    if (!kids.length) return settle(node, branch, a0, a1, r0, r1);

    // A branch is drawn in from the edges of its patch, so there is a gutter
    // between it and its neighbours: two subjects either side of a border
    // would otherwise be closer than two in the same field. Widest between
    // the broadest branches, and never more than a fifth of a small patch.
    const gutter = (extent * GUTTER) / (depthOf.get(node) || 1);
    const deep = Math.min(gutter, (r1 - r0) * 0.2);
    const turn = Math.min(gutter / ((r0 + r1) / 2), (a1 - a0) * 0.2);

    const items = kids.map((kid) => ({ node: kid, weight: weightOf.get(kid) }));
    items.splice(Math.floor(items.length / 2), 0, { node, weight: 1, self: true });
    divide(items, branch, a0 + turn, a1 - turn, r0 + deep, r1 - deep);
  };

  const turn = Math.PI * 2;
  const inner = reach * innerRadius;
  if (roots.length === 1) {
    // One root is the middle of the map, and everything else is around it.
    const [root] = roots;
    positions.set(root, { x: 0, y: 0, depth: 0, branch: root });
    const items = (under.get(root) ?? []).map((kid) => ({ node: kid, weight: weightOf.get(kid) }));
    if (items.length) divide(items, root, 0, turn, inner, reach);
  } else {
    // Several roots share the disc as the branches of one would, except that
    // each keeps its own name as the branch it belongs to.
    let cursor = 0;
    const total = roots.reduce((sum, root) => sum + weightOf.get(root), 0);
    for (const root of roots) {
      const share = (turn * weightOf.get(root)) / total;
      place(root, root, cursor, cursor + share, inner, reach);
      cursor += share;
    }
  }

  return positions;
}

/**
 * Ways of saying "about X" that do not make a different X.
 *
 * `theory of entomology`, `modern entomology` and `field entomology` are not
 * three subjects, and treating them as three rooms splits a small community
 * into smaller ones for no reason anybody would defend.
 */
const FACETS = [
  'theory of', 'history of', 'philosophy of', 'principles of', 'foundations of',
  'elements of', 'introduction to', 'studies in', 'topics in', 'writing on',
  'advanced', 'basic', 'general', 'applied', 'practical', 'theoretical',
  'experimental', 'computational', 'modern', 'contemporary', 'early', 'late',
  'classical', 'traditional', 'amateur', 'professional', 'field', 'digital',
  'analogue', 'urban', 'rural', 'teaching',
];

/**
 * The subject a name is really about.
 *
 * A facet is only stripped when what remains is a subject the hierarchy
 * actually knows. That restraint is the whole safety of it: `theory of
 * entomology` becomes `entomology` because entomology is a subject, while
 * `theory of everything` is left alone because `everything` is not. A rule
 * that stripped unconditionally would quietly rename things nobody meant to
 * rename.
 *
 * @param {string} name
 * @param {{has: (name: string) => boolean}} [known]  the hierarchy to check against
 */
export function normalise(name, known) {
  let clean = String(name).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!known?.has) return clean;
  if (known.has(clean)) return clean;

  // Stacked facets do happen — "modern theory of optics" — so keep peeling
  // while each peel lands on something real, bounded by the name's length.
  for (let peel = 0; peel < 4; peel++) {
    const facet = FACETS.find((f) => clean.startsWith(`${f} `));
    if (!facet) break;
    const rest = clean.slice(facet.length + 1);
    if (known.has(rest)) return rest;
    // Not a subject yet, but it may be one facet further down.
    if (!FACETS.some((f) => rest.startsWith(`${f} `))) break;
    clean = rest;
  }
  return String(name).trim().toLowerCase().replace(/\s+/g, ' ');
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
export function anchorsFor(subjects, positions, options = {}) {
  const { spread = 26 } = options;

  // Facets of one subject all resolve to it, so a real catalogue piles dozens
  // of names onto a single coordinate — "modern painting", "early painting"
  // and "field painting" stacked invisibly on "painting". Everything was
  // present and nothing was distinguishable. Each cluster is fanned into a
  // little constellation around its subject instead, widening as it grows so
  // the density stays even, and ordered by name so it never reshuffles.
  const clusters = new Map();
  for (const subject of subjects) {
    // Inside a group a subject sits where its outside twin does, so the group
    // is laid out as a copy of the world and not as a heap of strangers.
    const at = resolve(label(subject), positions);
    if (!at) continue;
    const spot = `${at.x.toFixed(2)},${at.y.toFixed(2)}`;
    if (!clusters.has(spot)) clusters.set(spot, { at, members: [] });
    clusters.get(spot).members.push(subject);
  }

  const anchors = new Map();
  for (const { at, members } of clusters.values()) {
    if (members.length === 1) {
      anchors.set(members[0], { x: at.x, y: at.y });
      continue;
    }
    members.sort();
    const radius = spread * Math.sqrt(members.length);
    members.forEach((subject, i) => {
      // Sunflower packing: an even fill of the disc rather than a bare ring.
      const angle = i * GOLDEN_ANGLE;
      const r = radius * Math.sqrt((i + 0.5) / members.length);
      anchors.set(subject, { x: at.x + Math.cos(angle) * r, y: at.y + Math.sin(angle) * r });
    });
  }
  return anchors;
}

/** Every subject the hierarchy knows, for checking coverage. */
export const known = (parents) => new Set(Object.keys(parents));

/**
 * The broader subjects a subject sits inside, nearest first.
 *
 * What the funnel widens along. Somebody in `entomology` and somebody in
 * `mycology` share nothing at all as far as the rooms are concerned, and that
 * is a fair description of their subjects and a poor description of them: both
 * are in biology, and the reason they cannot find each other is that the
 * catalogue is finer-grained than the community is large. Reaching one step up
 * puts them in a room together without either having to pretend their actual
 * interest is something broader than it is.
 *
 * The root is never returned. A room containing everybody is not a room.
 */
export function ancestorsOf(subject, parents, reach = 1) {
  const out = [];
  let at = subject;

  for (let step = 0; step < reach; step++) {
    const above = parents[at];
    if (!above || !parents[above]) break; // the root has no parent; stop below it
    out.push(above);
    at = above;
  }
  return out;
}

/**
 * How far apart two subjects are in the hierarchy, from 0 (siblings) to 1
 * (different divisions entirely).
 *
 * What the novelty dial steers by. Shared membership says who already bridges
 * two subjects; this says how far the bridge goes — and a long bridge that
 * somebody is nonetheless standing on is exactly the route into a community
 * you would not have found alone.
 */
export function distanceBetween(parents) {
  const chainOf = (subject) => {
    const chain = [subject];
    let at = subject;
    for (let step = 0; step < 16 && parents[at]; step++) {
      at = parents[at];
      chain.push(at);
    }
    return chain;
  };

  const cache = new Map();
  const chain = (s) => {
    let got = cache.get(s);
    if (!got) cache.set(s, (got = chainOf(s)));
    return got;
  };

  return (a, b) => {
    if (a === b) return 0;
    const up = chain(a);
    const down = chain(b);
    const meetAt = up.findIndex((step) => down.includes(step));
    if (meetAt === -1) return 1; // no common ancestor: as far as it gets

    const depth = Math.max(up.length, down.length, 1);
    const apart = meetAt + down.indexOf(up[meetAt]);
    return Math.min(1, apart / (depth * 2));
  };
}
