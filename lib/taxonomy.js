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

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

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

  const place = (node, from, to, branch, seen, wedgeIndex = 0, siblings = 1) => {
    if (seen.has(node)) return;
    seen.add(node);

    const depth = depthOf.get(node) ?? 0;
    const angle = (from + to) / 2;

    // Each depth owns a ring, and a node is spread across the width of its own
    // ring by where it falls among its siblings — not merely fanned by angle.
    //
    // Depth alone put every node of a depth on one arc, and most of a real
    // taxonomy is at one depth: a hundred and sixty-five subfields all sitting
    // on the same circle around an empty middle. Giving the ring width and
    // spreading siblings through it uses the disc instead of its edge.
    const tiers = Math.max(1, deepest);
    const within = siblings > 1 ? (wedgeIndex + 0.5) / siblings : 0.5;
    const t = Math.min(1, (Math.max(0, depth - 1) + within) / tiers);
    const radius = span * outerReach * (innerRadius + (1 - innerRadius) * t);

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
      place(kid, cursor, cursor + share, branch, seen, kids.indexOf(kid), kids.length);
      cursor += share;
    }
  };

  const seen = new Set();
  const perRoot = (Math.PI * 2) / roots.length;
  roots.forEach((root, i) => place(root, i * perRoot, (i + 1) * perRoot, root, seen, i, roots.length));

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
    const at = resolve(subject, positions);
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
