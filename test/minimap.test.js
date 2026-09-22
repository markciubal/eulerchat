import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseHTML } from 'linkedom';
import { fitTo, pointsOf, renderMinimap } from '../public/minimap.js';
import { drawChart, findIn } from '../public/explorer.js';
import { World, seed, stock } from '../server/store.js';
import { createEulerChat } from '../server/app.js';
import { populate } from '../server/populate.js';

const NS = 'http://www.w3.org/2000/svg';
const WebSocket = createRequire(import.meta.url)('ws');

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
  // The bundled hierarchy knows more than four hundred names now, so a
  // synthetic world that size is all classified. The strays the promise is
  // about are added by hand: things people made that no taxonomy has met.
  for (const name of ['competitive yodelling', 'the shed', 'topic 17']) {
    world.join(world.addUser(name), world.addSubject(name));
  }
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

// --- the explorer's chart ----------------------------------------------------

test('the chart is every interest there is, held or not, and not the groups', () => {
  const world = new World();
  stock(world);
  world.join(world.addUser('a'), 'chess');
  world.addSubject('kite-fox-9/chess');
  world.join(world.addUser('b'), 'kite-fox-9/chess');

  const chart = world.chart();
  const ids = chart.subjects.map((s) => s.id);
  // Everything is on it, because what is being explored is what could be
  // joined, not only what already has been.
  assert.equal(ids.length, [...world.subjects].filter((s) => !s.includes('/')).length);
  assert.ok(ids.includes('padel'), 'an interest nobody holds is still there');
  assert.ok(!ids.some((id) => id.includes('/')), 'a group keeps its rooms to itself');
  assert.equal(new Set(ids).size, ids.length);

  const chess = chart.subjects.find((s) => s.id === 'chess');
  assert.equal(chess.n, 1, 'the group copy is not counted with the open one');
  assert.deepEqual(chess.up, ['games', 'hobbies'], 'its place, nearest first');

  // The same holds for the minimap now: the overview is the open world too.
  assert.ok(!world.overview().subjects.some((s) => s.id.includes('/')));
});

test('the divisions and fields are named in the middle of what they cover', () => {
  const world = new World();
  stock(world);
  const { subjects, labels } = world.chart();

  const divisions = labels.filter((l) => l.depth === 1);
  assert.equal(divisions.length, 12);
  assert.ok(labels.filter((l) => l.depth === 2).length > 50);
  assert.ok(labels.every((l) => l.depth === 1 || l.depth === 2), 'no deeper than fields: the dots are the rest');

  for (const label of labels) {
    const under = subjects.filter((s) => s.up.includes(label.name));
    assert.equal(under.length, label.count, `${label.name} counts what is under it`);
    const mid = (k) => Math.round(under.reduce((sum, s) => sum + s[k], 0) / under.length);
    assert.equal(label.x, mid('x'));
    assert.equal(label.y, mid('y'));
  }
});

test('the chart keeps up with joins, though the census is changed in place', () => {
  // Counts are kept in one map that is updated rather than replaced, so a
  // cache keyed on the map alone — or on its size — handed back yesterday's.
  const world = new World();
  stock(world);
  const before = world.chart().subjects.find((s) => s.id === 'padel').n;
  world.join(world.addUser('a'), 'padel');
  assert.equal(world.chart().subjects.find((s) => s.id === 'padel').n, before + 1);
  assert.equal(world.overview().subjects.find((s) => s.id === 'padel')?.n, before + 1);

  const made = world.addSubject('competitive yodelling');
  assert.ok(world.chart().subjects.some((s) => s.id === made && !s.known), 'a new one turns up, unclassified');
});

test('the chart is drawn with a dot for each interest, and its names ready for the zoom', () => {
  const world = new World();
  stock(world);
  world.join(world.addUser('a'), 'chess');
  const chart = world.chart();

  const svg = canvas(800, 600);
  const nodes = drawChart(svg, chart, { held: new Set(['chess']) });
  assert.equal(svg.querySelectorAll('.chart-dots .dot').length, chart.subjects.length);
  assert.equal(svg.querySelectorAll('.chart-names .chart-name').length, chart.subjects.length);
  assert.equal(nodes.size, chart.subjects.length);
  assert.deepEqual(nodes.get('chess').map((n) => n.classList.contains('mine')), [true, true]);
  assert.equal(svg.querySelectorAll('.dot.mine').length, 1);
  assert.equal(svg.querySelectorAll('.dot.empty').length, chart.subjects.filter((s) => !s.n).length);

  // The busier dot is the bigger one, and one nobody holds is still a dot.
  const r = (id) => Number(svg.querySelector(`.dot[data-id="${id}"]`).getAttribute('r'));
  assert.ok(r('chess') > r('padel') && r('padel') > 0);

  // The dots first and every name over them: under the dots, the division
  // names were lost among the thousand things they are the names of.
  // (Other layers, such as the links between interests, may sit among them.)
  const names = ['chart-dots', 'chart-divisions', 'chart-fields', 'chart-names'];
  const order = [...svg.children].map((g) => g.getAttribute('class')).filter((c) => names.includes(c));
  assert.deepEqual(order, names);
});

test('the chart is asked for over the socket, and comes back whole', async () => {
  const world = new World();
  stock(world);
  const chat = createEulerChat({ world, serveClient: false });
  await new Promise((resolve) => chat.server.listen(0, resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${chat.server.address().port}/`);
  try {
    const frames = [];
    ws.on('message', (raw) => frames.push(JSON.parse(raw)));
    await new Promise((resolve) => ws.once('open', resolve));
    ws.send(JSON.stringify({ type: 'chart' }));
    let chart = null;
    for (let i = 0; i < 300 && !chart; i++) {
      chart = frames.find((f) => f.type === 'chart') ?? null;
      if (!chart) await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(chart, 'answered');
    assert.equal(chart.subjects.length, world.chart().subjects.length);
    assert.equal(chart.labels.length, world.chart().labels.length);
    assert.equal(chart.extent, world.chart().extent);
  } finally {
    ws.close();
    chat.close();
  }
});

test('finding puts what begins with the words first, then the busiest', () => {
  const subjects = [
    { id: 'board games', n: 9 },
    { id: 'games', n: 2 },
    { id: 'video games', n: 30 },
    { id: 'gamelan', n: 1 },
    { id: 'chess', n: 50 },
  ];
  assert.deepEqual(findIn(subjects, ' Game').map((s) => s.id), ['games', 'gamelan', 'video games', 'board games']);
  assert.deepEqual(findIn(subjects, ''), []);
});
