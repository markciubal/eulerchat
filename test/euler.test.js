import test from 'node:test';
import assert from 'node:assert/strict';
import { lensArea, separation, layout } from '../lib/euler.js';
import { census } from '../lib/regions.js';

const close = (a, b, eps, msg) =>
  assert.ok(Math.abs(a - b) <= eps, `${msg ?? 'value'}: ${a} vs ${b} (tol ${eps})`);

test('lens area matches the closed form at known configurations', () => {
  // Two unit circles one radius apart: 2π/3 − √3/2, the textbook vesica value.
  close(lensArea(1, 1, 1), (2 * Math.PI) / 3 - Math.sqrt(3) / 2, 1e-9, 'vesica');

  close(lensArea(2, 3, 5), 0, 1e-12, 'externally tangent');
  close(lensArea(2, 3, 9), 0, 1e-12, 'disjoint');
  close(lensArea(2, 3, 1), Math.PI * 4, 1e-12, 'internally tangent = smaller disc');
  close(lensArea(2, 3, 0), Math.PI * 4, 1e-12, 'concentric = smaller disc');
  close(lensArea(3, 3, 0), Math.PI * 9, 1e-12, 'coincident = whole disc');
});

test('separation inverts lens area', () => {
  for (const [r1, r2] of [[1, 1], [2, 3], [5, 1], [4, 4]]) {
    for (const frac of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const d = Math.abs(r1 - r2) + frac * (r1 + r2 - Math.abs(r1 - r2));
      const round = separation(r1, r2, lensArea(r1, r2, d));
      close(round, d, 1e-6, `r=${r1},${r2} d=${d}`);
    }
  }
});

test('separation handles the degenerate ends', () => {
  assert.equal(separation(2, 3, 0), 5);
  assert.equal(separation(2, 3, -10), 5);
  assert.equal(separation(2, 3, Math.PI * 4), 1);
  assert.equal(separation(2, 3, 9999), 1);
});

test('two circles are drawn exactly', () => {
  // With one pair there is a distance that satisfies the overlap precisely, so
  // any error here is solver error rather than a geometric impossibility.
  const { circles, fit } = layout(
    census([
      ...Array.from({ length: 6 }, () => ['art']),
      ...Array.from({ length: 4 }, () => ['art', 'philosophy']),
      ...Array.from({ length: 4 }, () => ['philosophy']),
    ]),
  );

  assert.equal(circles.length, 2);
  const overlap = fit.regions.find((r) => r.key === 'art+philosophy');
  close(overlap.drawn, 4, 0.08, 'drawn overlap in members');
  assert.ok(fit.faithful);
  assert.ok(fit.drawable);
});

test('circle area carries population', () => {
  const { circles } = layout(
    census([...Array.from({ length: 12 }, () => ['art']), ...Array.from({ length: 3 }, () => ['philosophy'])]),
  );
  const art = circles.find((c) => c.id === 'art');
  const phil = circles.find((c) => c.id === 'philosophy');

  // Four times the members means four times the area, so twice the radius.
  close(art.r / phil.r, 2, 0.01, 'radius ratio');
});

test('subjects with no shared members are drawn apart', () => {
  const { circles } = layout(census([...Array.from({ length: 5 }, () => ['art']), ...Array.from({ length: 5 }, () => ['philosophy'])]));
  const [a, b] = circles;
  const d = Math.hypot(b.x - a.x, b.y - a.y);

  assert.ok(d >= a.r + b.r, `disjoint subjects must not overlap (d=${d}, r+r=${a.r + b.r})`);
  close(lensArea(a.r, b.r, d), 0, 1e-9, 'drawn overlap');
});

test('a subject contained in another is drawn nested', () => {
  // Every philosopher here is also an artist, so philosophy belongs inside art.
  const { circles } = layout(
    census([...Array.from({ length: 8 }, () => ['art']), ...Array.from({ length: 4 }, () => ['art', 'philosophy'])]),
  );
  const art = circles.find((c) => c.id === 'art');
  const phil = circles.find((c) => c.id === 'philosophy');
  const d = Math.hypot(phil.x - art.x, phil.y - art.y);

  assert.ok(d <= art.r - phil.r + 0.5, `philosophy should sit inside art (d=${d})`);
});

test('three circles that meet pairwise invent a room nobody is in', () => {
  // Every pair overlaps; nobody holds all three. Circles cannot oblige at
  // these sizes — to share this much area pairwise their centres must sit
  // closer than avoiding a common patch allows — so the drawing shows a region
  // the census has no room for.
  //
  // Note what the old pairs-only check would have said: every real region is
  // sized perfectly, worst error zero, all clear. Checking only the regions
  // that exist can never catch a region that should not.
  const { circles, fit } = layout(
    census([
      ...Array.from({ length: 12 }, () => ['art']),
      ...Array.from({ length: 12 }, () => ['philosophy']),
      ...Array.from({ length: 12 }, () => ['music']),
      ...Array.from({ length: 6 }, () => ['art', 'philosophy']),
      ...Array.from({ length: 6 }, () => ['art', 'music']),
      ...Array.from({ length: 6 }, () => ['music', 'philosophy']),
    ]),
  );

  assert.equal(circles.length, 3);
  assert.equal(fit.worstError, 0, 'every real room should be sized exactly');

  assert.equal(fit.phantoms.length, 1);
  assert.equal(fit.phantoms[0].key, 'art+music+philosophy');
  assert.ok(fit.phantoms[0].drawn > 0.5, `phantom only ${fit.phantoms[0].drawn} members`);

  assert.equal(fit.faithful, false, 'a drawn region that is not a room is not faithful');
});

test('a diagram with nothing invented reports no phantoms', () => {
  // Two circles cannot invent anything, and disjoint subjects are held apart.
  const pair = layout(
    census([
      ...Array.from({ length: 8 }, () => ['art']),
      ...Array.from({ length: 4 }, () => ['art', 'philosophy']),
      ...Array.from({ length: 8 }, () => ['philosophy']),
    ]),
  );
  assert.deepEqual(pair.fit.phantoms, []);
  assert.ok(pair.fit.faithful);

  const strangers = layout(
    census([
      ...Array.from({ length: 6 }, () => ['art']),
      ...Array.from({ length: 6 }, () => ['music']),
    ]),
  );
  assert.deepEqual(strangers.fit.phantoms, []);
  assert.ok(strangers.fit.faithful);
});

test('the audit checks every region, not just the easy ones', () => {
  const rep = (n, s) => Array.from({ length: n }, () => s);
  const { fit } = layout(
    census([
      ...rep(10, ['art']), ...rep(10, ['philosophy']), ...rep(10, ['music']),
      ...rep(4, ['art', 'philosophy']), ...rep(4, ['art', 'music']), ...rep(4, ['music', 'philosophy']),
      ...rep(2, ['art', 'philosophy', 'music']),
    ]),
  );

  // Three distances cannot satisfy three pairwise overlaps *and* the triple.
  // Something has to be wrong; the requirement is that the report says so and
  // that the error is shared out rather than dumped on the triple, which is
  // the region the whole product exists for.
  const regions = new Map(fit.regions.map((r) => [r.key, r]));
  const triple = 'art+music+philosophy'; // addresses are alphabetical
  assert.ok(regions.has(triple));

  for (const key of ['art', 'philosophy', 'music']) {
    assert.ok(regions.get(key).error < 0.01, `${key} should be exact, got ${regions.get(key).error}`);
  }

  // Left to the spring solver alone the triple lands near 39% out. Refinement
  // trades a few percent of each pair to pull it back under 20%.
  assert.ok(regions.get(triple).error < 0.2, `triple still off by ${regions.get(triple).error}`);
  assert.ok(fit.worstError < 0.2, `worst region off by ${fit.worstError}`);
  assert.equal(fit.faithful, false, 'a diagram this compromised must not call itself faithful');
});

test('a solve stays fast enough to run per membership change', () => {
  const rep = (n, s) => Array.from({ length: n }, () => s);
  const counts = census([
    ...rep(10, ['art']), ...rep(10, ['philosophy']), ...rep(10, ['music']),
    ...rep(4, ['art', 'philosophy']), ...rep(4, ['art', 'music']),
    ...rep(2, ['art', 'philosophy', 'music']),
  ]);

  const started = performance.now();
  layout(counts);
  const elapsed = performance.now() - started;
  // Generous because the suite runs files in parallel; this is a guard
  // against an order-of-magnitude regression, not a benchmark.
  assert.ok(elapsed < 400, `layout took ${elapsed.toFixed(0)}ms`);
});

test('the fourth circle is reported as undrawable', () => {
  // Not a budget: no arrangement of four circles realises all fifteen regions.
  // The solver still returns a picture, but it must not claim the picture is true.
  const { fit } = layout(
    census([
      ...Array.from({ length: 6 }, () => ['a']),
      ...Array.from({ length: 6 }, () => ['b']),
      ...Array.from({ length: 6 }, () => ['c']),
      ...Array.from({ length: 6 }, () => ['d']),
      ...Array.from({ length: 3 }, () => ['a', 'b']),
      ...Array.from({ length: 3 }, () => ['c', 'd']),
    ]),
  );
  assert.equal(fit.drawable, false);
});

test('the same census always yields the same picture', () => {
  const subscriptions = [
    ['art'], ['art'], ['philosophy'], ['art', 'philosophy'], ['music', 'art'], ['music'],
  ];
  const a = layout(census(subscriptions));
  const b = layout(census(subscriptions));
  assert.deepEqual(a.circles, b.circles);
  assert.deepEqual(a.bounds, b.bounds);
});

test('an empty world does not throw', () => {
  const { circles, fit, bounds } = layout(census([]));
  assert.deepEqual(circles, []);
  assert.equal(fit.worstError, 0);
  assert.equal(bounds.width, 0);
});
