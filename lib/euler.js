/**
 * Area-proportional Euler layout.
 *
 * Circle positions are *derived*, never authored. A circle's area carries its
 * population and the lens between two circles carries their shared membership,
 * so the diagram is a picture of the actual social graph rather than a drawing
 * somebody made that happens to sit near the data.
 *
 * The solver is honest about its own failure: `fit` reports, per pair, how far
 * the drawn overlap is from the true one. Two circles are always exactly
 * satisfiable; three usually land close; four is where a circle diagram starts
 * lying and `fit.faithful` goes false. Nothing here silently fakes it.
 */

import { parse } from './regions.js';

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * Drawn area, in members, below which an unoccupied region is a sliver of
 * anti-aliasing rather than somewhere anyone could mistake for a room.
 */
const PHANTOM_FLOOR = 0.5;

/** Subsets of the drawn shapes that the census has no room for. */
function missingRegions(circles, census) {
  const ids = circles.map((c) => c.id).sort();
  const out = [];

  const walk = (start, picked) => {
    if (picked.length >= 2 && !census.has(picked.join('+'))) out.push([...picked]);
    if (picked.length === ids.length) return;
    for (let i = start; i < ids.length; i++) {
      picked.push(ids[i]);
      walk(i + 1, picked);
      picked.pop();
    }
  };
  walk(0, []);
  return out;
}

/**
 * Area of the lens where two circles overlap.
 * Monotonically decreasing in `d` over `[|r1-r2|, r1+r2]`, which is what makes
 * `separation` below a well-posed inverse.
 */
export function lensArea(r1, r2, d) {
  const smaller = Math.min(r1, r2);
  if (d >= r1 + r2) return 0;
  if (d <= Math.abs(r1 - r2)) return Math.PI * smaller * smaller;

  const c1 = clamp((d * d + r1 * r1 - r2 * r2) / (2 * d * r1), -1, 1);
  const c2 = clamp((d * d + r2 * r2 - r1 * r1) / (2 * d * r2), -1, 1);
  const kite = Math.sqrt(
    Math.max(0, (-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2)),
  );
  return r1 * r1 * Math.acos(c1) + r2 * r2 * Math.acos(c2) - kite / 2;
}

/**
 * Centre distance that produces exactly `targetArea` of overlap.
 * Bisection rather than a closed form: the forward function has no elementary
 * inverse, and sixty halvings of a bounded interval is exact to float noise.
 */
export function separation(r1, r2, targetArea) {
  const maxOverlap = Math.PI * Math.min(r1, r2) ** 2;
  if (targetArea <= 0) return r1 + r2;
  if (targetArea >= maxOverlap) return Math.abs(r1 - r2);

  let lo = Math.abs(r1 - r2);
  let hi = r1 + r2;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (lensArea(r1, r2, mid) > targetArea) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Solve a diagram from a region census.
 *
 * @param {Map<string, number>} census    region key -> population (see lib/regions.js)
 * @param {object}   [options]
 * @param {number}   [options.areaPerMember=900]  px² of circle area per member
 * @param {number}   [options.gap=12]             px of clear air between disjoint circles
 * @param {number}   [options.iterations=800]
 * @param {number}   [options.tolerance=0.08]     max relative overlap error still called faithful
 * @returns {{circles: Array, fit: object, bounds: object}}
 */
export function layout(census, options = {}) {
  const {
    areaPerMember = 900,
    gap = 12,
    iterations = 800,
    tolerance = 0.08,
    samples = 360,
  } = options;

  // Subjects are the arity-1 regions. Largest first, then alphabetical, so the
  // same census always yields the same picture — the map is a shared reference
  // and must not shuffle under people between reloads.
  const subjects = [...census.entries()]
    .filter(([k]) => !k.includes('+'))
    .map(([id, population]) => ({ id, population }))
    .sort((a, b) => b.population - a.population || a.id.localeCompare(b.id));

  const nodes = subjects.map((s, i) => {
    const r = Math.sqrt((s.population * areaPerMember) / Math.PI);
    const angle = i * GOLDEN_ANGLE;
    const spread = 2.2 * r + i * gap;
    return { ...s, r, x: Math.cos(angle) * spread, y: Math.sin(angle) * spread };
  });

  const overlapOf = (a, b) => census.get([a.id, b.id].sort().join('+')) ?? 0;

  const constraints = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const shared = overlapOf(nodes[i], nodes[j]);
      constraints.push(
        shared > 0
          ? {
              i,
              j,
              shared,
              target: separation(nodes[i].r, nodes[j].r, shared * areaPerMember),
              oneSided: false,
              weight: 1,
            }
          : {
              // Strangers get pushed apart but never pulled together. A
              // two-sided spring here would invent a relationship the data
              // does not have, parking unrelated subjects at exactly kissing
              // distance as if they nearly touched.
              i,
              j,
              shared: 0,
              target: nodes[i].r + nodes[j].r + gap,
              oneSided: true,
              weight: 0.5,
            },
      );
    }
  }

  for (let it = 0; it < iterations; it++) {
    const strength = 0.6 * (1 - (0.85 * it) / iterations);
    for (const c of constraints) {
      const a = nodes[c.i];
      const b = nodes[c.j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let d = Math.hypot(dx, dy);

      if (d < 1e-9) {
        // Deterministic nudge, not a random one: reproducibility is a feature.
        const angle = (c.i + 1) * GOLDEN_ANGLE;
        dx = Math.cos(angle) * 1e-3;
        dy = Math.sin(angle) * 1e-3;
        d = 1e-3;
      }
      if (c.oneSided && d >= c.target) continue;

      const shift = (((d - c.target) / d) * strength * c.weight) / 2;
      a.x += dx * shift;
      a.y += dy * shift;
      b.x -= dx * shift;
      b.y -= dy * shift;
    }
  }

  // Regions the shapes could form that nobody occupies. An Euler diagram is
  // supposed to show the occupied regions and *only* those, so these have to
  // be hunted rather than assumed away: three circles overlapping pairwise
  // tend to share a common patch whether or not anyone holds all three.
  const missing = missingRegions(nodes, census);
  const byId = new Map(nodes.map((c) => [c.id, c]));
  const overdetermined = [...census.keys()].some((k) => parse(k).length === 3);

  const ghostArea = () =>
    missing.reduce((sum, tags) => sum + drawnArea(byId, tags, samples), 0) / areaPerMember;
  const worstAreaError = () => {
    let worst = 0;
    for (const [k, population] of census) {
      const off = Math.abs(drawnArea(byId, parse(k), samples) / areaPerMember - population);
      if (off > PHANTOM_FLOOR) worst = Math.max(worst, off / Math.max(population, 1));
    }
    return worst;
  };

  if (nodes.length === 3 && overdetermined) refine(nodes, census, areaPerMember);

  // Removing a phantom is attempted, never insisted on. Three circles often
  // *cannot* overlap pairwise without sharing a common patch — at these radii
  // the centres would have to sit further apart than the overlaps allow — and
  // a solver told to do it anyway will wreck every area in the diagram trying.
  // So the second pass is kept only if it actually helped and cost nothing.
  if (nodes.length === 3 && ghostArea() > PHANTOM_FLOOR) {
    const before = { ghost: ghostArea(), error: worstAreaError() };
    const snapshot = nodes.map((n) => ({ x: n.x, y: n.y }));

    refine(nodes, census, areaPerMember, missing);

    const after = { ghost: ghostArea(), error: worstAreaError() };
    const better = after.ghost < before.ghost - 0.05;
    const affordable = after.error <= Math.max(before.error, tolerance);

    if (!(better && affordable)) {
      nodes.forEach((n, i) => Object.assign(n, snapshot[i]));
    }
  }

  // Recentre on the centroid so the viewport does not drift between solves.
  const cx = nodes.reduce((s, n) => s + n.x, 0) / (nodes.length || 1);
  const cy = nodes.reduce((s, n) => s + n.y, 0) / (nodes.length || 1);
  for (const n of nodes) {
    n.x -= cx;
    n.y -= cy;
  }

  const regions = audit(nodes, census, areaPerMember, samples);
  const failing = regions.filter((r) => r.significant && r.error > tolerance);
  const phantoms = missing
    .map((tags) => ({
      key: tags.join('+'),
      subjects: tags,
      drawn: round(drawnArea(byId, tags, samples) / areaPerMember),
    }))
    .filter((p) => p.drawn > PHANTOM_FLOOR)
    .sort((a, b) => b.drawn - a.drawn);

  return {
    circles: nodes.map(({ id, population, r, x, y }) => ({
      id,
      population,
      r: round(r),
      x: round(x),
      y: round(y),
    })),
    fit: {
      regions,
      phantoms,
      worstError: regions.length ? regions[0].error : 0,
      worst: regions[0] ?? null,
      // A drawn region that is not a room is a worse lie than a mis-sized one:
      // it offers somewhere to go that does not exist.
      faithful: failing.length === 0 && phantoms.length === 0,
      // Past three circles no layout can be trusted however good the numbers
      // look, because some regions are simply unrealisable — a low error then
      // just means the solver found a flattering lie.
      drawable: nodes.length <= 3,
    },
    bounds: bounds(nodes),
  };
}

/**
 * Spend the unavoidable error where it hurts least.
 *
 * Three circles give three distances to play with. Those three distances fix
 * three pairwise overlaps *and* the triple intersection — four quantities from
 * three knobs, so something must give. The spring solve satisfies the pairs
 * perfectly and lets the triple absorb the entire discrepancy, which is the
 * worst possible distribution: the triple is the region this product exists
 * for. This re-solves for least total relative error across every region
 * instead, so a few percent gets shaved off each pair to pull the triple back.
 *
 * Coordinate descent over the three distances, scored by the same sampler the
 * audit uses. Deliberately not a gradient method: the objective runs through a
 * point-sampler and is mildly non-smooth, and a derivative-free search over
 * three bounded parameters converges in well under a millisecond anyway.
 */
function refine(nodes, census, areaPerMember, missing = [], samples = 90) {
  if (nodes.length !== 3) return;

  // An unoccupied region is simply a target whose population is zero, so
  // avoiding phantoms and sizing real rooms are the same objective rather than
  // two competing ones.
  const targets = [
    ...[...census].map(([k, population]) => ({ tags: parse(k), population })),
    ...missing.map((tags) => ({ tags, population: 0 })),
  ];

  const pairs = [[0, 1], [0, 2], [1, 2]];
  const lo = pairs.map(([i, j]) => Math.abs(nodes[i].r - nodes[j].r));
  const hi = pairs.map(([i, j]) => nodes[i].r + nodes[j].r);

  const place = ([dab, dac, dbc]) => {
    const x = dab === 0 ? 0 : (dab * dab + dac * dac - dbc * dbc) / (2 * dab);
    return [
      { ...nodes[0], x: 0, y: 0 },
      { ...nodes[1], x: dab, y: 0 },
      { ...nodes[2], x, y: Math.sqrt(Math.max(0, dac * dac - x * x)) },
    ];
  };

  // A real region's error is judged against its own size. A phantom has no
  // size to be judged against, so it borrows the smallest circle's — a phantom
  // worth two members inside circles of twenty is an eight-percent blemish,
  // not a catastrophe. Judging it against 1 instead (or against the smallest
  // *room*, which is routinely a single person) made phantoms hundreds of
  // times louder than everything else, and the solver flattened every area in
  // the diagram chasing one.
  const scale = Math.max(
    1,
    Math.min(...[...census].filter(([k]) => !k.includes('+')).map(([, n]) => n)),
  );
  const cost = (d) => {
    const byId = new Map(place(d).map((c) => [c.id, c]));
    let total = 0;
    for (const { tags, population } of targets) {
      // A real room is judged against its own size; only a phantom, having
      // none, borrows the scale above.
      const relative =
        (drawnArea(byId, tags, samples) / areaPerMember - population) /
        (population > 0 ? population : scale);
      total += relative * relative;
    }
    return total;
  };

  let d = pairs.map(([i, j]) => Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y));
  let best = cost(d);
  let step = Math.max(...hi) * 0.06;

  for (let round = 0; round < 9; round++) {
    let improved = false;
    for (let k = 0; k < 3; k++) {
      for (const dir of [1, -1]) {
        const trial = [...d];
        trial[k] = Math.min(hi[k], Math.max(lo[k], d[k] + dir * step));
        const score = cost(trial);
        if (score < best - 1e-9) {
          best = score;
          d = trial;
          improved = true;
        }
      }
    }
    if (!improved) step /= 2;
    if (step < 0.4) break; // below the width of a stroke; nobody can see it
  }

  const solved = place(d);
  for (let i = 0; i < nodes.length; i++) {
    nodes[i].x = solved[i].x;
    nodes[i].y = solved[i].y;
  }
}

/**
 * Area where *every* one of `circles` overlaps — the drawn size of that region
 * under containment semantics, which is what census counts mean.
 *
 * Sampled over the intersection of the bounding boxes rather than the whole
 * diagram. The region being measured fills a large fraction of that box, so
 * nearly every sample lands somewhere informative; the same precision costs a
 * fraction of what a full-diagram sweep would.
 */
export function intersectionArea(circles, samples = 160) {
  if (!circles.length) return 0;

  const minX = Math.max(...circles.map((c) => c.x - c.r));
  const maxX = Math.min(...circles.map((c) => c.x + c.r));
  const minY = Math.max(...circles.map((c) => c.y - c.r));
  const maxY = Math.min(...circles.map((c) => c.y + c.r));
  if (maxX <= minX || maxY <= minY) return 0;

  const stepX = (maxX - minX) / samples;
  const stepY = (maxY - minY) / samples;
  const cell = stepX * stepY;
  let area = 0;

  for (let i = 0; i < samples; i++) {
    const x = minX + (i + 0.5) * stepX;
    for (let j = 0; j < samples; j++) {
      const y = minY + (j + 0.5) * stepY;
      let inAll = true;
      for (const c of circles) {
        if ((x - c.x) ** 2 + (y - c.y) ** 2 > c.r * c.r) {
          inAll = false;
          break;
        }
      }
      if (inAll) area += cell;
    }
  }
  return area;
}

/**
 * Drawn area of one region, exactly where an exact answer exists.
 *
 * A single circle is πr² and a pair is the lens — both closed form, both free.
 * Only a triple or deeper needs sampling, so a diagram that has no triple
 * region is audited without a single sample taken.
 */
function drawnArea(byId, tags, samples) {
  const circles = tags.map((t) => byId.get(t)).filter(Boolean);
  if (circles.length !== tags.length) return 0;

  if (circles.length === 1) return Math.PI * circles[0].r ** 2;
  if (circles.length === 2) {
    const [a, b] = circles;
    return lensArea(a.r, b.r, Math.hypot(b.x - a.x, b.y - a.y));
  }
  return intersectionArea(circles, samples);
}

/**
 * Every region's drawn size against its true population, worst first.
 *
 * Checking pairs alone would be self-flattering: three circles have exactly
 * enough freedom to satisfy all three pairwise overlaps, since a triangle is
 * determined by its sides. It is the triple intersection that has no freedom
 * left, so it is the one that quietly lies. This checks all of them.
 */
function audit(circles, census, areaPerMember, samples) {
  const byId = new Map(circles.map((c) => [c.id, c]));

  return [...census]
    .map(([k, population]) => {
      const tags = parse(k);
      const drawn = drawnArea(byId, tags, samples) / areaPerMember;
      const off = Math.abs(drawn - population);

      return {
        key: k,
        subjects: tags,
        population,
        drawn: round(drawn),
        error: round(off / Math.max(population, 1), 4),
        // Sampling cannot resolve a region below about half a member, so a
        // sub-member discrepancy is noise in the measurement rather than a lie
        // in the picture.
        significant: off > 0.5,
      };
    })
    .sort((a, b) => b.error - a.error);
}

function bounds(nodes) {
  if (!nodes.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  const minX = Math.min(...nodes.map((n) => n.x - n.r));
  const minY = Math.min(...nodes.map((n) => n.y - n.r));
  const maxX = Math.max(...nodes.map((n) => n.x + n.r));
  const maxY = Math.max(...nodes.map((n) => n.y + n.r));
  return {
    minX: round(minX),
    minY: round(minY),
    maxX: round(maxX),
    maxY: round(maxY),
    width: round(maxX - minX),
    height: round(maxY - minY),
  };
}

const round = (x, places = 2) => Number(x.toFixed(places));
