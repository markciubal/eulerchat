/**
 * Routed-boundary Euler diagrams.
 *
 * The circle map is a live surface and buys its continuity — one person joins,
 * a radius nudges, nothing jumps — at the price of accuracy: convex shapes
 * cannot produce exactly the set of regions a real population calls for, so
 * they invent regions nobody occupies and shrink real ones to specks.
 *
 * This does the opposite trade. Every zone is given ground first and the
 * outlines are drawn around the result afterwards, so the regions are exactly
 * the occupied ones and their areas are exactly proportional — by
 * construction, not by fitting. What it gives up is stability: the boundaries
 * come from a growth process, and a different population grows differently.
 * That makes it a snapshot rather than a surface, which is why it lives beside
 * the circle map instead of replacing it.
 *
 * The method is three steps, none of them clever:
 *   1. place the subjects, so that subjects sharing members sit near each other
 *   2. grow every zone outward from a seed until it holds its share of the
 *      ground — connected by construction, because growth only adds cells
 *      touching cells it already owns
 *   3. trace the outline of each subject's territory and round off the stairs
 */

import { canonical, key, parse } from './regions.js';

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * @param {Map<string, number>} zoneCounts  exclusive populations, from `zones()`
 * @param {object} [options]
 * @param {number} [options.grid=104]   cells per side; the resolution of the map
 * @param {number} [options.fill=0.58]  share of the canvas the diagram occupies
 * @param {number} [options.smooth=3]   rounds of corner-rounding on the outlines
 * @param {number} [options.extent=1000] user units across the finished map
 */
export function atlas(zoneCounts, options = {}) {
  const { grid = 104, fill = 0.58, smooth = 3, extent = 1000 } = options;

  const regions = [...zoneCounts]
    .map(([k, population]) => ({ key: k, subjects: parse(k), population }))
    .sort((a, b) => b.population - a.population || a.key.localeCompare(b.key));

  const subjects = canonical(regions.flatMap((r) => r.subjects));
  if (!regions.length) {
    return { subjects: [], zones: [], curves: [], extent, report: empty() };
  }

  const at = placeSubjects(subjects, regions, extent);
  seedRegions(regions, at, extent, fill);

  let owner = grow(regions, grid, fill, extent);
  // One relaxation pass: re-seed each zone at the middle of the ground it won
  // and grow again, which settles the patches into rounder shapes.
  reseed(regions, owner, grid, extent);
  owner = grow(regions, grid, fill, extent);
  closePockets(owner, grid, regions);

  const curves = subjects.map((subject) => {
    const mask = territory(subject, regions, owner, grid);
    return {
      subject,
      components: countComponents(mask, grid),
      // Labelled where the subject alone holds the ground. Anchoring to the
      // whole territory puts the name at the middle of the union, which lands
      // squarely on an internal boundary and reads as labelling the overlap.
      anchor: deepest(soleTerritory(subject, regions, owner, grid), grid, extent, mask),
      loops: outline(mask, grid).map((loop) => round(loop, smooth, grid, extent)),
    };
  });

  return {
    subjects,
    zones: regions.map(({ key: k, subjects: s, population, cx, cy }) => ({
      key: k,
      subjects: s,
      population,
      // Where to hang the label, in user units.
      x: cx,
      y: cy,
    })),
    curves,
    extent,
    report: verify(regions, owner, curves, grid, fill),
  };
}

const empty = () => ({
  exact: true,
  phantoms: 0,
  vanished: 0,
  worstError: 0,
  disconnected: [],
  wellFormed: true,
});

// --- 1. where the subjects sit ---------------------------------------------

/**
 * Subjects that share members are drawn near each other, because every zone
 * holding a subject is seeded near that subject — so keeping a subject's zones
 * close together is what keeps its territory in one piece.
 */
function placeSubjects(subjects, regions, extent) {
  const size = new Map(subjects.map((s) => [s, 0]));
  const shared = new Map();

  for (const r of regions) {
    for (const s of r.subjects) size.set(s, size.get(s) + r.population);
    for (let i = 0; i < r.subjects.length; i++) {
      for (let j = i + 1; j < r.subjects.length; j++) {
        const pair = `${r.subjects[i]}+${r.subjects[j]}`;
        shared.set(pair, (shared.get(pair) ?? 0) + r.population);
      }
    }
  }

  const nodes = subjects.map((id, i) => ({
    id,
    x: Math.cos(i * GOLDEN_ANGLE) * extent * 0.3,
    y: Math.sin(i * GOLDEN_ANGLE) * extent * 0.3,
  }));

  const near = extent * 0.16;
  const far = extent * 0.62;
  const targets = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const pair = [nodes[i].id, nodes[j].id].sort().join('+');
      const overlap = shared.get(pair) ?? 0;
      const smaller = Math.min(size.get(nodes[i].id), size.get(nodes[j].id)) || 1;
      const affinity = Math.min(1, overlap / smaller);
      targets.push({ i, j, d: far - (far - near) * affinity });
    }
  }

  for (let step = 0; step < 400; step++) {
    const strength = 0.5 * (1 - (0.8 * step) / 400);
    for (const t of targets) {
      const a = nodes[t.i];
      const b = nodes[t.j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let d = Math.hypot(dx, dy);
      if (d < 1e-9) {
        dx = Math.cos(t.i * GOLDEN_ANGLE) * 1e-3;
        dy = Math.sin(t.i * GOLDEN_ANGLE) * 1e-3;
        d = 1e-3;
      }
      const shift = (((d - t.d) / d) * strength) / 2;
      a.x += dx * shift;
      a.y += dy * shift;
      b.x -= dx * shift;
      b.y -= dy * shift;
    }
  }

  return new Map(nodes.map((n) => [n.id, n]));
}

/**
 * Where each zone starts growing from.
 *
 * Seeding every zone at the middle of its own subjects is the obvious thing
 * and it does not work: all the zones holding a subject pile onto the same
 * spot, fight for the same ground, and the losers starve at a fraction of
 * their proper size. What matters is not that a zone sits near its subjects
 * but that zones *sharing* a subject end up side by side — because a subject's
 * territory is the union of its zones, and a union of neighbours is connected
 * while a union of scattered patches is not.
 *
 * So the zones are packed like discs sized by population: ones that share a
 * subject are drawn together until they touch, ones that share nothing keep
 * clear, and a weak pull toward the subject layout keeps the whole arrangement
 * oriented the way the subjects are.
 */
function seedRegions(regions, at, extent, fill) {
  const total = regions.reduce((s, r) => s + r.population, 0) || 1;
  const ground = extent * extent * fill;

  regions.forEach((r, i) => {
    r.radius = Math.sqrt(((r.population / total) * ground) / Math.PI);
    let x = 0;
    let y = 0;
    for (const s of r.subjects) {
      x += at.get(s).x;
      y += at.get(s).y;
    }
    r.ax = x / r.subjects.length;
    r.ay = y / r.subjects.length;
    r.cx = r.ax + Math.cos(i * GOLDEN_ANGLE) * r.radius;
    r.cy = r.ay + Math.sin(i * GOLDEN_ANGLE) * r.radius;
  });

  const pairs = [];
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const shared = regions[i].subjects.filter((s) => regions[j].subjects.includes(s)).length;
      pairs.push({ i, j, shared });
    }
  }

  for (let step = 0; step < 320; step++) {
    const strength = 0.4 * (1 - (0.75 * step) / 320);

    for (const p of pairs) {
      const a = regions[p.i];
      const b = regions[p.j];
      let dx = b.cx - a.cx;
      let dy = b.cy - a.cy;
      let d = Math.hypot(dx, dy);
      if (d < 1e-9) {
        dx = Math.cos(p.i * GOLDEN_ANGLE) * 1e-3;
        dy = Math.sin(p.i * GOLDEN_ANGLE) * 1e-3;
        d = 1e-3;
      }

      const touching = a.radius + b.radius;
      // Sharing a subject means "be adjacent"; sharing none means only "do not
      // sit on top of me", which is one-sided so strangers are free to drift.
      const target = p.shared ? touching : touching * 1.2;
      if (!p.shared && d >= target) continue;

      const pull = p.shared ? Math.min(1, p.shared / 2 + 0.5) : 0.7;
      const shift = (((d - target) / d) * strength * pull) / 2;
      a.cx += dx * shift;
      a.cy += dy * shift;
      b.cx -= dx * shift;
      b.cy -= dy * shift;
    }

    for (const r of regions) {
      r.cx += (r.ax - r.cx) * 0.015;
      r.cy += (r.ay - r.cy) * 0.015;
    }
  }
}

function reseed(regions, owner, grid, extent) {
  const sums = regions.map(() => ({ x: 0, y: 0, n: 0 }));
  for (let c = 0; c < owner.length; c++) {
    const r = owner[c];
    if (r < 0) continue;
    sums[r].x += c % grid;
    sums[r].y += Math.floor(c / grid);
    sums[r].n++;
  }
  regions.forEach((r, i) => {
    if (!sums[i].n) return;
    r.cx = ((sums[i].x / sums[i].n + 0.5) / grid) * extent - extent / 2;
    r.cy = ((sums[i].y / sums[i].n + 0.5) / grid) * extent - extent / 2;
  });
}

// --- 2. growing the zones --------------------------------------------------

/**
 * Every zone grows outward from its seed, and the zone furthest behind its
 * quota always moves next — so they expand together like soap bubbles rather
 * than one finishing before the next begins.
 *
 * Growth only ever adds a cell touching ground the zone already holds, which
 * is what makes every zone a single connected patch. Nothing needs to check
 * for it afterwards.
 */
function grow(regions, grid, fill, extent) {
  const cells = grid * grid;
  const owner = new Int32Array(cells).fill(-1);
  const budget = Math.floor(cells * fill);
  const total = regions.reduce((s, r) => s + r.population, 0) || 1;

  const toCell = (ux, uy) => {
    const gx = Math.min(grid - 1, Math.max(0, Math.floor(((ux + extent / 2) / extent) * grid)));
    const gy = Math.min(grid - 1, Math.max(0, Math.floor(((uy + extent / 2) / extent) * grid)));
    return gy * grid + gx;
  };

  const state = regions.map((r) => {
    const quota = Math.max(1, Math.round((r.population / total) * budget));
    return { quota, filled: 0, splits: 0, stalled: false, heap: new Heap(), seed: toCell(r.cx, r.cy) };
  });

  // Seed each zone. If its own cell is taken, spiral out until a free one turns up.
  state.forEach((s, i) => {
    let cell = s.seed;
    if (owner[cell] !== -1) {
      const sx = cell % grid;
      const sy = Math.floor(cell / grid);
      search: for (let ring = 1; ring < grid; ring++) {
        for (let dy = -ring; dy <= ring; dy++) {
          for (let dx = -ring; dx <= ring; dx++) {
            const x = sx + dx;
            const y = sy + dy;
            if (x < 0 || y < 0 || x >= grid || y >= grid) continue;
            if (owner[y * grid + x] === -1) {
              cell = y * grid + x;
              break search;
            }
          }
        }
      }
    }
    if (owner[cell] !== -1) return; // no ground left at all
    owner[cell] = i;
    s.filled = 1;
    pushNeighbours(s, cell, grid, owner, regions[i], extent);
  });

  let placed = state.reduce((n, s) => n + s.filled, 0);
  while (placed < budget) {
    let pick = -1;
    let hungriest = Infinity;
    for (let i = 0; i < state.length; i++) {
      const s = state[i];
      if (s.filled >= s.quota || s.stalled) continue;
      const ratio = s.filled / s.quota;
      if (ratio < hungriest) {
        hungriest = ratio;
        pick = i;
      }
    }
    if (pick === -1) break;

    const s = state[pick];
    let cell = -1;
    while (!s.heap.empty()) {
      const next = s.heap.pop();
      if (owner[next] === -1) {
        cell = next;
        break;
      }
    }

    // Walled in by its neighbours before reaching its share. Area is the
    // promise this method exists to keep, so it takes ground elsewhere and
    // accepts being drawn in two pieces — which `verify` then reports rather
    // than hides.
    if (cell === -1) {
      cell = nearestFree(owner, grid, regions[pick], extent);
      if (cell === -1) {
        s.stalled = true;
        continue;
      }
      s.splits++;
    }

    owner[cell] = pick;
    s.filled++;
    placed++;
    pushNeighbours(s, cell, grid, owner, regions[pick], extent);
  }

  regions.forEach((r, i) => {
    r.cells = state[i].filled;
    r.quota = state[i].quota;
    r.splits = state[i].splits;
  });
  return owner;
}

/** Closest unclaimed cell to a zone's centre, searched outward in rings. */
function nearestFree(owner, grid, region, extent) {
  const sx = Math.min(grid - 1, Math.max(0, Math.floor(((region.cx + extent / 2) / extent) * grid)));
  const sy = Math.min(grid - 1, Math.max(0, Math.floor(((region.cy + extent / 2) / extent) * grid)));

  for (let ring = 0; ring < grid * 2; ring++) {
    let found = -1;
    let best = Infinity;
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const x = sx + dx;
        const y = sy + dy;
        if (x < 0 || y < 0 || x >= grid || y >= grid) continue;
        const cell = y * grid + x;
        if (owner[cell] !== -1) continue;
        const d = dx * dx + dy * dy;
        if (d < best) {
          best = d;
          found = cell;
        }
      }
    }
    if (found !== -1) return found;
  }
  return -1;
}

function pushNeighbours(state, cell, grid, owner, region, extent) {
  const gx = cell % grid;
  const gy = Math.floor(cell / grid);
  const seedX = ((region.cx + extent / 2) / extent) * grid;
  const seedY = ((region.cy + extent / 2) / extent) * grid;

  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const x = gx + dx;
    const y = gy + dy;
    if (x < 0 || y < 0 || x >= grid || y >= grid) continue;
    const next = y * grid + x;
    if (owner[next] !== -1) continue;
    // Nearest-to-seed first, so a patch grows round rather than in a tendril.
    state.heap.push(next, (x + 0.5 - seedX) ** 2 + (y + 0.5 - seedY) ** 2);
  }
}

/** Minimal binary heap; the growth loop leans on it heavily. */
class Heap {
  constructor() {
    this.items = [];
    this.keys = [];
  }
  empty() {
    return this.items.length === 0;
  }
  push(item, k) {
    this.items.push(item);
    this.keys.push(k);
    let i = this.items.length - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (this.keys[up] <= this.keys[i]) break;
      this.swap(i, up);
      i = up;
    }
  }
  pop() {
    const top = this.items[0];
    const item = this.items.pop();
    const k = this.keys.pop();
    if (this.items.length) {
      this.items[0] = item;
      this.keys[0] = k;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let small = i;
        if (l < this.items.length && this.keys[l] < this.keys[small]) small = l;
        if (r < this.items.length && this.keys[r] < this.keys[small]) small = r;
        if (small === i) break;
        this.swap(i, small);
        i = small;
      }
    }
    return top;
  }
  swap(a, b) {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
  }
}

// --- 3. drawing the outlines -----------------------------------------------

/**
 * Ground left unclaimed but walled in on every side.
 *
 * Growth stops when zones meet, which can strand a pocket in the middle of the
 * diagram. Unclaimed ground is how "outside the diagram" is drawn, so a
 * stranded pocket renders as a hole in the middle of the map — a bounded,
 * clickable-looking area belonging to nothing. Ground touching the edge is the
 * real outside; anything else is handed to whichever zone surrounds it.
 */
function closePockets(owner, grid, regions) {
  const outside = new Uint8Array(owner.length);
  const stack = [];

  for (let i = 0; i < grid; i++) {
    for (const c of [i, (grid - 1) * grid + i, i * grid, i * grid + grid - 1]) {
      if (owner[c] === -1 && !outside[c]) {
        outside[c] = 1;
        stack.push(c);
      }
    }
  }
  while (stack.length) {
    const c = stack.pop();
    const x = c % grid;
    const y = (c / grid) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= grid || ny >= grid) continue;
      const n = ny * grid + nx;
      if (owner[n] === -1 && !outside[n]) {
        outside[n] = 1;
        stack.push(n);
      }
    }
  }

  // A pocket is only ever handed to a zone that is still short of its share.
  // Capping by how big the pocket is instead was the wrong bound: a zone whose
  // quota is twenty cells can ring a gap of a hundred and swallow all of it,
  // which put the area error at 56% — ruining the one thing this method is for
  // in order to tidy a blemish. Quota bounds the damage exactly, and has the
  // happy side effect of feeding whichever zones the growth left starved.
  const room = regions.map((r) => Math.max(0, r.quota - r.cells));

  for (let pass = 0; pass < 64; pass++) {
    let changed = false;

    for (let c = 0; c < owner.length; c++) {
      if (owner[c] !== -1 || outside[c]) continue;
      const x = c % grid;
      const y = (c / grid) | 0;

      const tally = new Map();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= grid || ny >= grid) continue;
        const o = owner[ny * grid + nx];
        if (o >= 0 && room[o] > 0) tally.set(o, (tally.get(o) ?? 0) + 1);
      }
      if (!tally.size) continue;

      let best = -1;
      let most = 0;
      for (const [o, count] of tally) {
        if (count > most) {
          most = count;
          best = o;
        }
      }
      owner[c] = best;
      room[best]--;
      changed = true;
    }
    if (!changed) break;
  }

  regions.forEach((r, i) => {
    r.cells = r.quota - room[i];
  });
}

/** Every cell held by a zone that contains this subject. */
function territory(subject, regions, owner, grid) {
  const holds = regions.map((r) => r.subjects.includes(subject));
  const mask = new Uint8Array(grid * grid);
  for (let c = 0; c < owner.length; c++) {
    if (owner[c] >= 0 && holds[owner[c]]) mask[c] = 1;
  }
  return mask;
}

/**
 * The point furthest inside a territory, for hanging a label on.
 *
 * Not the centroid: these shapes are routed rather than convex, and the
 * centroid of a bent one lands outside it. A distance transform inward from
 * the edge gives the deepest cell, which is always genuinely inside and is the
 * roomiest place to put text.
 */
/** Ground where this subject is the only one — where its name is unambiguous. */
function soleTerritory(subject, regions, owner, grid) {
  const alone = regions.map((r) => r.subjects.length === 1 && r.subjects[0] === subject);
  const mask = new Uint8Array(grid * grid);
  for (let c = 0; c < owner.length; c++) {
    if (owner[c] >= 0 && alone[owner[c]]) mask[c] = 1;
  }
  return mask;
}

function deepest(mask, grid, extent, fallback) {
  // A subject entirely covered by its overlaps has no ground of its own; then
  // the whole territory is the best that can be done.
  if (fallback && !mask.some((v) => v)) mask = fallback;

  const depth = new Int32Array(mask.length).fill(-1);
  const queue = [];

  for (let c = 0; c < mask.length; c++) {
    if (mask[c]) continue;
    depth[c] = 0;
    queue.push(c);
  }
  for (let c = 0; c < mask.length; c++) {
    if (!mask[c]) continue;
    const x = c % grid;
    const y = (c / grid) | 0;
    if (x === 0 || y === 0 || x === grid - 1 || y === grid - 1) {
      depth[c] = 1;
      queue.push(c);
    }
  }

  for (let head = 0; head < queue.length; head++) {
    const c = queue[head];
    const x = c % grid;
    const y = (c / grid) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= grid || ny >= grid) continue;
      const n = ny * grid + nx;
      if (!mask[n] || depth[n] !== -1) continue;
      depth[n] = depth[c] + 1;
      queue.push(n);
    }
  }

  let best = -1;
  let at = -1;
  for (let c = 0; c < mask.length; c++) {
    if (mask[c] && depth[c] > best) {
      best = depth[c];
      at = c;
    }
  }
  if (at === -1) return { x: 0, y: 0 };
  return {
    x: (((at % grid) + 0.5) / grid) * extent - extent / 2,
    y: ((((at / grid) | 0) + 0.5) / grid) * extent - extent / 2,
  };
}

function countComponents(mask, grid) {
  const seen = new Uint8Array(mask.length);
  let components = 0;

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    components++;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const c = stack.pop();
      const gx = c % grid;
      const gy = (c / grid) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = gx + dx;
        const y = gy + dy;
        if (x < 0 || y < 0 || x >= grid || y >= grid) continue;
        const n = y * grid + x;
        if (mask[n] && !seen[n]) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
  }
  return components;
}

/**
 * The boundary as closed loops of grid corners.
 *
 * Each cell on the edge of the territory contributes the sides that face
 * outward, wound clockwise so the inside stays on the same hand throughout.
 * Chaining the segments end to start then yields the outer loops and any
 * holes, which `fill-rule: evenodd` renders correctly without further work.
 */
function outline(mask, grid) {
  const segments = new Map();
  const add = (ax, ay, bx, by) => {
    const from = `${ax},${ay}`;
    if (!segments.has(from)) segments.set(from, []);
    segments.get(from).push([bx, by]);
  };

  for (let c = 0; c < mask.length; c++) {
    if (!mask[c]) continue;
    const x = c % grid;
    const y = (c / grid) | 0;
    const solid = (dx, dy) => {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= grid || ny >= grid) return false;
      return mask[ny * grid + nx] === 1;
    };

    if (!solid(0, -1)) add(x, y, x + 1, y);
    if (!solid(1, 0)) add(x + 1, y, x + 1, y + 1);
    if (!solid(0, 1)) add(x + 1, y + 1, x, y + 1);
    if (!solid(-1, 0)) add(x, y + 1, x, y);
  }

  const loops = [];
  for (const [from, ends] of segments) {
    while (ends.length) {
      const loop = [];
      let [cx, cy] = from.split(',').map(Number);
      let step = ends.pop();

      for (let guard = 0; guard < mask.length * 4 + 8; guard++) {
        loop.push([cx, cy]);
        [cx, cy] = step;
        const outgoing = segments.get(`${cx},${cy}`);
        if (!outgoing || !outgoing.length) break;
        step = outgoing.pop();
        if (cx === Number(from.split(',')[0]) && cy === Number(from.split(',')[1])) {
          loop.push([cx, cy]);
          break;
        }
      }
      if (loop.length > 3) loops.push(loop);
    }
  }
  return loops;
}

/**
 * Ramer–Douglas–Peucker: drop points that sit on the line their neighbours
 * already describe.
 *
 * A traced boundary is a staircase with a point at every cell corner, which is
 * both far more detail than the shape carries and enough to push an atlas of
 * twelve subjects past two megabytes on the wire. Run before smoothing, with a
 * tolerance near the cell size, it collapses the stairs into the diagonals
 * they were approximating.
 */
function simplify(points, tolerance) {
  if (points.length < 4) return points;

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];

  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;

    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const dx = bx - ax;
    const dy = by - ay;
    const span = Math.hypot(dx, dy) || 1;

    let worst = 0;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i];
      const off = Math.abs((px - ax) * dy - (py - ay) * dx) / span;
      if (off > worst) {
        worst = off;
        at = i;
      }
    }
    if (worst > tolerance && at !== -1) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Chaikin corner-cutting: turns the staircase into something drawn. */
function round(loop, passes, grid, extent) {
  const lean = simplify(loop, 0.7);
  let points = lean.map(([x, y]) => [(x / grid) * extent - extent / 2, (y / grid) * extent - extent / 2]);

  for (let pass = 0; pass < passes; pass++) {
    const next = [];
    for (let i = 0; i < points.length; i++) {
      const [ax, ay] = points[i];
      const [bx, by] = points[(i + 1) % points.length];
      next.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25]);
      next.push([ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
    }
    points = next;
  }
  return points;
}

// --- what it managed ------------------------------------------------------

/**
 * The same honesty the circle map owes, asked of this one.
 *
 * Two of these can only ever come back clean: a zone is drawn because it is in
 * the data, and it is grown until it holds its share, so there is nothing to
 * invent and nothing to lose. They are measured anyway — a construction that
 * cannot fail is exactly the kind that stops being checked and then quietly
 * starts failing.
 */
function verify(regions, owner, curves, grid, fill) {
  const drawn = new Map();
  for (const c of owner) if (c >= 0) drawn.set(c, (drawn.get(c) ?? 0) + 1);

  const budget = Math.floor(grid * grid * fill);
  const total = regions.reduce((s, r) => s + r.population, 0) || 1;

  let worstError = 0;
  let vanished = 0;
  for (let i = 0; i < regions.length; i++) {
    const cells = drawn.get(i) ?? 0;
    if (cells === 0) vanished++;
    const expected = (regions[i].population / total) * budget;
    worstError = Math.max(worstError, Math.abs(cells - expected) / Math.max(expected, 1));
  }

  const keys = new Set(regions.map((r) => r.key));
  const phantoms = [...drawn.keys()].filter((i) => !keys.has(regions[i]?.key)).length;
  const disconnected = curves.filter((c) => c.components > 1).map((c) => c.subject);

  return {
    exact: phantoms === 0 && vanished === 0,
    phantoms,
    vanished,
    worstError: Number(worstError.toFixed(4)),
    // A subject split across two patches is still readable, but it is the one
    // thing this method can get wrong, so it is named rather than averaged away.
    disconnected,
    worstSplit: curves.reduce((m, c) => Math.max(m, c.components), 0),
    wellFormed: disconnected.length === 0,
  };
}

export { key, parse };
