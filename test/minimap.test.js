import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { fitTo, pointsOf, renderMinimap } from '../public/minimap.js';
import { World, seed } from '../server/store.js';
import { populate } from '../server/populate.js';

const NS = 'http://www.w3.org/2000/svg';

/** An SVG element that knows how big it is on screen. */
const canvas = (width, height) => {
  const { document } = parseHTML('<!doctype html><html><body></body></html>');
  const svg = document.createElementNS(NS, 'svg');
  svg.getBoundingClientRect = () => ({ width, height });
  document.body.append(svg);
  return svg;
};

const viewBoxOf = (svg) => svg.getAttribute('viewBox').split(' ').map(Number);

/** Where a user-space point lands on screen, given the viewBox and element. */
const project = (svg, [x, y], W, H) => {
  const [vx, vy, vw, vh] = viewBoxOf(svg);
  return [((x - vx) / vw) * W, ((y - vy) / vh) * H];
};

test('fitting leaves exactly the padding asked for', () => {
  // Padding given in pixels cannot just be added to a viewBox: the viewBox is
  // in user units and the scale between them is what is being solved for, so
  // widening the box to make room shrinks the very margin it widened for.
  const W = 640;
  const H = 480;
  const svg = canvas(W, H);
  const points = [[-100, -50], [100, -50], [100, 50], [-100, 50]];

  fitTo(svg, points, 20);

  const screen = points.map((p) => project(svg, p, W, H));
  const left = Math.min(...screen.map((p) => p[0]));
  const right = Math.max(...screen.map((p) => p[0]));
  const top = Math.min(...screen.map((p) => p[1]));
  const bottom = Math.max(...screen.map((p) => p[1]));

  // The content is wider than it is tall against a 4:3 box, so width binds.
  assert.ok(Math.abs(left - 20) < 0.01, `left padding ${left.toFixed(2)}px`);
  assert.ok(Math.abs(W - right - 20) < 0.01, `right padding ${(W - right).toFixed(2)}px`);
  // The other axis gets at least the padding, and is centred.
  assert.ok(top >= 20 - 0.01, `top padding ${top.toFixed(2)}px`);
  assert.ok(Math.abs(top - (H - bottom)) < 0.01, 'should be centred vertically');
});

test('the binding axis swaps with the shape of the content', () => {
  const W = 400;
  const H = 700;
  const svg = canvas(W, H);
  // Tall content in a tall box: height binds.
  const points = [[-20, -300], [20, -300], [20, 300], [-20, 300]];
  fitTo(svg, points, 20);

  const screen = points.map((p) => project(svg, p, W, H));
  const top = Math.min(...screen.map((p) => p[1]));
  const bottom = Math.max(...screen.map((p) => p[1]));
  assert.ok(Math.abs(top - 20) < 0.01, `top padding ${top.toFixed(2)}px`);
  assert.ok(Math.abs(H - bottom - 20) < 0.01, `bottom padding ${(H - bottom).toFixed(2)}px`);
});

test('a single point still gets a viewport', () => {
  const svg = canvas(300, 300);
  assert.doesNotThrow(() => fitTo(svg, [[10, 10]], 20));
  const [, , w, h] = viewBoxOf(svg);
  assert.ok(Number.isFinite(w) && w > 0);
  assert.ok(Number.isFinite(h) && h > 0);
  assert.equal(fitTo(svg, [], 20), null);
});

test('padding survives an element too small to hold it', () => {
  // Twenty pixels each side of a thirty pixel element is not possible; it must
  // still produce a usable box rather than an inverted one.
  const svg = canvas(30, 30);
  fitTo(svg, [[-50, -50], [50, 50]], 20);
  const [, , w, h] = viewBoxOf(svg);
  assert.ok(w > 0 && h > 0 && Number.isFinite(w) && Number.isFinite(h));
});

// --- the overview ----------------------------------------------------------

test('every subject is on the minimap', () => {
  // The point of it: a view shows a handful, and this shows that the rest are
  // there and whereabouts they lie.
  const world = populate(new World(), { subjects: 400, users: 900, chatter: 0 });
  const overview = world.overview();

  assert.equal(overview.subjects.length, world.index().population.size);
  assert.ok(overview.subjects.length > 300, `${overview.subjects.length} on the map`);
  // The taxonomy places what it knows; the rest go on the unclassified ring
  // rather than being dropped, which is the promise this makes.
  assert.ok(overview.classified > 150);
  assert.ok(overview.classified < overview.subjects.length);
  for (const s of overview.subjects) {
    assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y), `${s.id} has no place`);
    assert.ok(s.n > 0);
  }

  const svg = canvas(120, 120);
  const drawn = renderMinimap(svg, overview, { mine: [] });
  assert.equal(svg.querySelectorAll('circle').length, overview.subjects.length);
  assert.equal(drawn, null, 'no frame when they hold nothing');
});

test('a subject the hierarchy never heard of is still placed', () => {
  const world = seed(new World());
  world.addSubject('competitive yodelling');
  const someone = world.addUser('someone');
  world.join(someone, 'competitive yodelling');

  const stray = world.overview().subjects.find((s) => s.id === 'competitive yodelling');
  assert.ok(stray, 'it must appear rather than be dropped');
  assert.equal(stray.known, false, 'and be marked as unclassified');
  assert.ok(Number.isFinite(stray.x) && Number.isFinite(stray.y));
});

test('the frame marks out the part of the map they hold', () => {
  const world = seed(new World());
  const member = world.addUser('member');
  world.join(member, 'art');
  world.join(member, 'philosophy');

  const svg = canvas(120, 120);
  const frame = renderMinimap(svg, world.overview(), { mine: ['art', 'philosophy'] });

  assert.ok(frame, 'holding subjects should produce a frame');
  assert.ok(frame.width > 0 && frame.height > 0);
  assert.equal(svg.querySelectorAll('.here').length, 1);
  assert.equal(svg.querySelectorAll('.dot.mine').length, 2);
});

test('fitting an atlas frames the subjects they hold', () => {
  const world = seed(new World());
  const member = world.addUser('member');
  world.join(member, 'art');

  const view = world.atlasFor(member, 3);
  const mine = pointsOf(view.curves, ['art']);
  const everything = pointsOf(view.curves);

  assert.ok(mine.length > 0);
  assert.ok(mine.length < everything.length, 'their own ground is a part, not the whole');

  const svg = canvas(600, 600);
  fitTo(svg, mine, 20);
  const [, , w] = viewBoxOf(svg);

  const svgAll = canvas(600, 600);
  fitTo(svgAll, everything, 20);
  const [, , wAll] = viewBoxOf(svgAll);

  assert.ok(w < wAll, 'framing on their own subjects should be closer in');
});
