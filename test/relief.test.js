import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { TILT, WALLS, heightOf, shade, strips, view3d } from '../public/relief.js';
import { renderAtlas, TALLEST } from '../public/atlasview.js';
import { COLUMN, drawChart, reprojectChart } from '../public/explorer.js';
import { catalogueOptions } from '../public/catalogue.js';
import { HALF_LIFE, activity } from '../lib/activity.js';
import { World, seed, stock } from '../server/store.js';

const NS = 'http://www.w3.org/2000/svg';

const canvas = () => {
  const { document } = parseHTML('<!doctype html><html><body></body></html>');
  const svg = document.createElementNS(NS, 'svg');
  document.body.append(svg);
  return svg;
};

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// --- the view ------------------------------------------------------------------

test('the tilted view goes there and back, and up is up the screen', () => {
  for (const turn of [0, 0.4, Math.PI / 2, 2.5]) {
    const view = view3d({ turn });
    for (const [x, y, h] of [[0, 0, 0], [120, -40, 0], [-300, 250, 35]]) {
      const [X, Y] = view.at(x, y, h);
      const [gx, gy] = view.ground(X, Y, h);
      assert.ok(close(gx, x, 1e-6) && close(gy, y, 1e-6), `turn ${turn}: (${x}, ${y}) came back as (${gx}, ${gy})`);
      // Higher is straight up the screen, whatever the turn.
      const [X2, Y2] = view.at(x, y, h + 10);
      assert.ok(close(X2, X) && Y2 < Y);
    }
  }
  // Nearer the viewer is lower on the screen, before any height.
  const view = view3d();
  assert.ok(view.depth(0, 100) > view.depth(0, -100));
  assert.ok(close(view.lift, Math.sin(TILT)) && close(view.squash, Math.cos(TILT)));
  assert.match(view.matrix(10), /^matrix\(/);
});

test('only the walls facing the viewer are built, lit by which way they face', () => {
  // A square, both ways round: which way a loop is wound must not matter.
  const square = [[-50, -50], [50, -50], [50, 50], [-50, 50]];
  const count = (path) => (path.match(/M/g) ?? []).length;
  for (const loop of [square, [...square].reverse()]) {
    // Square on, only the near side faces the viewer: the far one faces
    // away and the two sides are edge on. It catches the light.
    const walls = strips([loop], view3d(), 10);
    assert.equal(count(walls.lit), 1);
    assert.equal(count(walls.side) + count(walls.shade), 0);
    const ys = [...walls.lit.matchAll(/(-?\d+\.\d),(-?\d+\.\d)/g)].map((m) => Number(m[2]));
    const near = view3d().at(0, 50)[1];
    assert.ok(Math.max(...ys) <= near + 0.05 && Math.min(...ys) >= near - 11.5 * view3d().lift - 0.1, 'the near side, one band high');

    // Turned a little, the right-hand side comes into view, in shadow.
    const turned = strips([loop], view3d({ turn: 0.4 }), 10);
    assert.equal(count(turned.lit), 1);
    assert.equal(count(turned.side) + count(turned.shade), 1);
  }

  // A hole's walls face into it: the far side of a hole is seen, its near
  // side is not.
  const outer = [[-100, -100], [100, -100], [100, 100], [-100, 100]];
  const hole = [[-20, -20], [20, -20], [20, 20], [-20, 20]];
  const withHole = strips([outer, hole], view3d(), 10);
  const plain = strips([outer], view3d(), 10);
  const size = (w) => `${w.lit}${w.side}${w.shade}`.length;
  assert.ok(size(withHole) > size(plain), 'the hole has walls of its own');

  // Turned half round, what faced away faces the viewer.
  const front = strips([square], view3d({ turn: 0 }), 10);
  const back = strips([square], view3d({ turn: Math.PI }), 10);
  assert.ok(front.lit || front.side || front.shade);
  assert.ok(back.lit || back.side || back.shade);
});

test('walls are the room colour, lighter in the light and darker in the shade', () => {
  assert.equal(shade('#808080', 0), '#808080');
  const light = shade('#336699', WALLS.lit);
  const dark = shade('#336699', WALLS.shade);
  const sum = (hex) => [1, 3, 5].reduce((n, i) => n + parseInt(hex.slice(i, i + 2), 16), 0);
  assert.ok(sum(light) > sum('#336699') && sum(dark) < sum('#336699'));
  assert.equal(shade('not a colour', 0.2), 'not a colour');
});

test('height goes with the square root of activity, from a floor', () => {
  assert.equal(heightOf(0, 100, 5), 5);
  assert.equal(heightOf(1, 100, 5), 100);
  assert.ok(close(heightOf(0.25, 100), 50));
  assert.equal(heightOf(undefined, 100), 0);
  assert.equal(heightOf(7, 100), 100, 'never past the tallest');
});

// --- activity ---------------------------------------------------------------------

test('activity is relative to the liveliest, and halves with each half-life of age', () => {
  const now = 1_000_000_000;
  const logs = new Map([
    ['art', [{ at: now }, { at: now }]],
    ['music', [{ at: now }]],
    ['art+music', [{ at: now - HALF_LIFE }, { at: now - HALF_LIFE }]],
  ]);
  const { rooms, subjects } = activity(logs);
  assert.equal(rooms.get('art'), 1, 'the liveliest is 1');
  assert.equal(rooms.get('music'), 0.5);
  assert.equal(rooms.get('art+music'), 0.5, 'two an hour ago count as one now');
  // A message in a room is about each thing the room is about: art has its
  // own two and the pair's one, music its own one and the pair's.
  assert.equal(subjects.get('art'), 1);
  assert.equal(subjects.get('music'), 0.667);

  // Nothing said for a day changes none of it.
  const later = new Map([...logs].map(([room, log]) => [room, log.map((m) => ({ at: m.at - 24 * HALF_LIFE }))]));
  assert.deepEqual([...activity(later).rooms], [...rooms]);
});

test('a portal is not counted, and a group does not set the scale for the open world', () => {
  const now = 5_000_000;
  const logs = new Map([
    ['art', [{ at: now }]],
    ['portal-abc', Array.from({ length: 50 }, () => ({ at: now }))],
    ['kite-fox-9/art', Array.from({ length: 10 }, () => ({ at: now }))],
  ]);
  const { rooms } = activity(logs, {
    skip: (room) => room.startsWith('portal-'),
    open: (subject) => !subject.includes('/'),
  });
  assert.equal(rooms.has('portal-abc'), false);
  assert.equal(rooms.get('art'), 1, 'the open world is measured against itself');
  assert.equal(rooms.get('kite-fox-9/art'), 1, 'and a busier group room only reaches the top');

  // With the open world silent, a group's rooms are measured among themselves.
  const quiet = activity(new Map([['kite-fox-9/art', [{ at: now }]], ['kite-fox-9/chess', [{ at: now }, { at: now }]]]), {
    open: (subject) => !subject.includes('/'),
  });
  assert.equal(quiet.rooms.get('kite-fox-9/chess'), 1);
  assert.equal(quiet.rooms.get('kite-fox-9/art'), 0.5);
});

test('the atlas and the chart say how lively each thing is, and keep up with what is said', () => {
  const world = seed(new World());
  const member = world.addUser('member');
  world.join(member, 'art');
  world.join(member, 'philosophy');

  const rooms = () => new Map(world.atlasFor(member, 3).rooms.map((r) => [r.key, r.activity]));
  const before = rooms();
  for (const value of before.values()) assert.ok(value >= 0 && value <= 1);
  assert.ok([...before.values()].includes(1), 'the liveliest is the top');

  // Talk in one room until it is the liveliest.
  for (let i = 0; i < 12; i++) world.post(member, ['art'], `hello ${i}`);
  const after = rooms();
  assert.equal(after.get('art'), 1);
  assert.ok(after.get('art+philosophy') < before.get('art+philosophy'), 'the rest are measured against it now');

  const chart = world.chart();
  const art = chart.subjects.find((s) => s.id === 'art');
  assert.equal(art.a, 1);
  assert.ok(chart.subjects.every((s) => s.a === undefined || (s.a > 0 && s.a <= 1)));
});

// --- the map in relief -----------------------------------------------------------

const seededAtlas = () => {
  const world = seed(new World());
  const member = world.addUser('member');
  world.join(member, 'art');
  world.join(member, 'philosophy');
  for (let i = 0; i < 12; i++) world.post(member, ['art', 'philosophy'], `hello ${i}`);
  return world.atlasFor(member, 3);
};

const liftOf = (node) => Number(/matrix\([^)]* (-?[\d.]+)\)$/.exec(node.getAttribute('transform'))[1]);

test('every room stands on the map as tall as it is lively', () => {
  const view = seededAtlas();
  const svg = canvas();
  const drawn = renderAtlas(svg, view, { relief: view3d() });

  const tops = [...svg.querySelectorAll('.relief-top')];
  assert.equal(tops.length, view.zones.filter((z) => z.loops?.length).length, 'a top for every room');
  const top = (key) => tops.find((t) => t.getAttribute('data-zone') === key);
  const busiest = view.rooms.find((r) => r.activity === 1).key;
  const quietest = [...view.rooms].sort((a, b) => a.activity - b.activity)[0].key;
  // Lifted up the screen: the more negative, the higher.
  assert.ok(liftOf(top(busiest)) < liftOf(top(quietest)), 'the busier room stands taller');
  assert.ok(liftOf(top(quietest)) < 0, 'and a quiet one still stands off the floor');
  assert.ok(drawn.raised > 0 && drawn.raised <= view.extent * TALLEST + 1e-9);

  // Each top is the room's own drawing, cut to its shape.
  for (const t of tops) {
    assert.match(t.getAttribute('clip-path'), /^url\(#relief-zone-\d+-clip\)$/);
    assert.ok(t.querySelector('.zone-ground'));
  }
  // Walls, stacked by reference, one stretch between each height a top is
  // drawn at below each room's own, all saying which room they belong to.
  const walls = [...svg.querySelectorAll('.relief > use')];
  assert.ok(walls.length > tops.length);
  assert.ok(walls.every((w) => view.rooms.some((r) => r.key === w.getAttribute('data-zone'))));

  // A room's top is drawn after every wall below its height: its own, and
  // every lower band of the rooms around it.
  const order = [...svg.querySelector('.relief').children];
  const at = (node) => order.indexOf(node);
  const busyTop = top(busiest);
  assert.ok(order.filter((n) => n.getAttribute('data-zone') === busiest && n.tagName === 'use').every((w) => at(w) < at(busyTop)));

  // Names stand over everything, and the outline of a subject is now in
  // pieces, one per room top it runs along.
  assert.ok(svg.lastElementChild.tagName === 'text' || svg.lastElementChild.classList.contains('zone-label'));
  assert.ok(Array.isArray(drawn.territories.get('art')) && drawn.territories.get('art').length >= 1);
  assert.equal(drawn.grounds.size, tops.length);
});

test('a room is walled from the floor to its top in as few pieces as the tops around it allow', () => {
  const view = seededAtlas();
  const svg = canvas();
  const relief = view3d();
  const drawn = renderAtlas(svg, view, { relief });
  const band = (view.extent * TALLEST) / 36;
  // `+ 0`, since a translate of nothing reads back as minus nothing.
  const levelOf = (y) => Math.round(-y / (band * relief.lift)) + 0;

  const tops = [...svg.querySelectorAll('.relief-top')];
  const levels = new Map(tops.map((t) => [t.getAttribute('data-zone'), levelOf(liftOf(t))]));
  const stops = new Set([0, ...levels.values()]);
  const walls = [...svg.querySelectorAll('.relief > use')];
  let bands = 0;
  for (const [key, level] of levels) {
    bands += level;
    // Where each piece starts, and how many bands it is: the defs say.
    const pieces = walls
      .filter((w) => w.getAttribute('data-zone') === key)
      .map((w) => ({
        from: levelOf(Number(/translate\(0 (-?[\d.]+)\)/.exec(w.getAttribute('transform'))[1])),
        bands: Number(/-walls-(\d+)$/.exec(w.getAttribute('href'))[1]),
      }))
      .sort((a, b) => a.from - b.from);
    // Unbroken from the floor to the top, and broken only where another
    // room's top is drawn, since that is the only thing that has to go
    // between two pieces of wall.
    let at = 0;
    for (const piece of pieces) {
      assert.equal(piece.from, at, `${key}: a gap or an overlap at ${at}`);
      assert.ok(stops.has(piece.from), `${key}: a piece starting where no top is`);
      at += piece.bands;
    }
    assert.equal(at, level, `${key}: walled all the way up to its top`);
  }
  assert.ok(walls.length < bands, `${walls.length} pieces of wall for ${bands} bands`);

  // Every room can be kept off the screen as a whole: its top and all of its
  // walls, in a box that holds it from the floor up.
  assert.equal(drawn.cull.length, tops.length);
  for (const part of drawn.cull) {
    const key = part.nodes[0].getAttribute('data-zone');
    assert.ok(part.nodes.includes(tops.find((t) => t.getAttribute('data-zone') === key)));
    assert.equal(part.nodes.length, 1 + walls.filter((w) => w.getAttribute('data-zone') === key).length);
    assert.ok(part.box.x0 < part.box.x1 && part.box.y0 < part.box.y1);
  }
});

test('the flat map is the flat map still, and says which room each ground is', () => {
  const view = seededAtlas();
  const svg = canvas();
  const drawn = renderAtlas(svg, view);
  assert.equal(svg.querySelectorAll('.relief-top').length, 0);
  const grounds = [...svg.querySelectorAll('.zone-ground')];
  assert.ok(grounds.length > 0 && grounds.every((g) => view.rooms.some((r) => r.key === g.getAttribute('data-zone'))));
  assert.ok(!Array.isArray(drawn.territories.get('art')));
});

// --- the explorer in relief --------------------------------------------------------

test('in relief every interest is a column as tall as it is lively, drawn from the back', () => {
  const world = new World();
  stock(world);
  const someone = world.addUser('someone');
  world.join(someone, 'chess');
  for (let i = 0; i < 5; i++) world.post(someone, ['chess'], `move ${i}`);
  world.join(someone, 'padel');
  world.post(someone, ['padel'], 'one');
  const chart = world.chart();

  const svg = canvas();
  const relief = view3d({ turn: 0.3 });
  const nodes = drawChart(svg, chart, { held: new Set(['chess']), relief });
  const dot = (id) => nodes.get(id)[0];
  assert.equal(dot('chess').tagName.toLowerCase(), 'g');
  const h = (id) => Number(dot(id).getAttribute('data-h'));
  assert.ok(close(h('chess'), (chart.extent ?? 1000) * COLUMN), 'the liveliest stands tallest');
  assert.ok(h('padel') > 0 && h('padel') < h('chess'));
  assert.equal(h('photography'), 0, 'a quiet one is only its top, on the floor');
  assert.equal(dot('photography').querySelector('.column'), null);
  assert.ok(dot('chess').querySelector('.column') && dot('chess').querySelector('.column-top'));
  assert.ok(dot('chess').classList.contains('mine'));

  // Back to front: each column is drawn after everything further back.
  const depths = [...svg.querySelector('.chart-dots').children].map((g) => {
    const s = chart.subjects.find((x) => x.id === g.getAttribute('data-id'));
    return relief.depth(s.x, s.y);
  });
  assert.ok(depths.every((d, i) => i === 0 || d >= depths[i - 1] - 1e-9));

  // Its name stands above its top.
  const [, name] = nodes.get('chess');
  assert.ok(Number(name.getAttribute('y')) < Number(dot('chess').getAttribute('data-y')) - h('chess') * relief.lift + 1e-6);
});

test('turning a chart moves it to exactly where drawing it turned would put it', () => {
  const world = new World();
  stock(world);
  const someone = world.addUser('someone');
  world.join(someone, 'chess');
  for (let i = 0; i < 3; i++) world.post(someone, ['chess'], `move ${i}`);
  const chart = world.chart();

  const from = view3d({ turn: 0.2 });
  const to = view3d({ turn: 1.1, tilt: 0.7 });
  const moved = canvas();
  const nodes = drawChart(moved, chart, { relief: from });
  reprojectChart(moved, chart, nodes, to);
  const drawn = canvas();
  drawChart(drawn, chart, { relief: to });

  const pick = (svg, selector, attrs) =>
    [...svg.querySelectorAll(selector)].map((n) => attrs.map((a) => n.getAttribute(a)).join(' '));
  // Same places, same shapes, same order from the back.
  assert.deepEqual(pick(moved, '.chart-dots > g', ['data-id', 'data-x', 'data-y']), pick(drawn, '.chart-dots > g', ['data-id', 'data-x', 'data-y']));
  assert.deepEqual(pick(moved, '.column', ['d']).sort(), pick(drawn, '.column', ['d']).sort());
  assert.deepEqual(pick(moved, '.column-top', ['cy', 'ry']).sort(), pick(drawn, '.column-top', ['cy', 'ry']).sort());
  // Names and labels to within a hundredth: one way writes two places first.
  const near = (svg, selector, key) =>
    new Map([...svg.querySelectorAll(selector)].map((n, i) => [key(n, i), [Number(n.getAttribute('x')), Number(n.getAttribute('y'))]]));
  for (const [selector, key] of [['.chart-name', (n) => n.getAttribute('data-id')], ['.chart-divisions text', (n, i) => i], ['.chart-fields text', (n, i) => i]]) {
    const a = near(moved, selector, key);
    const b = near(drawn, selector, key);
    assert.equal(a.size, b.size);
    for (const [k, [x, y]] of a) {
      const [x2, y2] = b.get(k);
      assert.ok(Math.abs(x - x2) < 0.01 && Math.abs(y - y2) < 0.01, `${selector} ${k}: (${x}, ${y}) against (${x2}, ${y2})`);
    }
  }
});

// --- the list to add from ------------------------------------------------------------

test('the catalogue list is every interest, under its division, indented by depth', () => {
  const world = new World();
  stock(world);
  const chart = world.chart();
  const groups = catalogueOptions(chart.subjects, new Set(['photography']));

  assert.equal(groups.length, 12, 'one group per division');
  assert.deepEqual(groups.map((g) => g.label), [...groups.map((g) => g.label)].sort((a, b) => a.localeCompare(b)));
  const options = groups.flatMap((g) => g.options);
  assert.equal(options.length, chart.subjects.length, 'everything, once');
  assert.equal(new Set(options.map((o) => o.value)).size, options.length);

  const arts = groups.find((g) => g.label === 'Arts');
  assert.equal(arts.options[0].value, 'arts', 'a division starts with itself');
  assert.equal(arts.options[0].depth, 0);
  const at = (value) => options.find((o) => o.value === value);
  assert.equal(at('visual art').depth, 1);
  assert.equal(at('photography').depth, 2);
  // The indent is in the text, since an option can hold nothing else.
  assert.match(at('photography').text, /^( ){6}› photography/);
  assert.ok(at('photography').held && /joined/.test(at('photography').text));
  assert.ok(!at('visual art').held);
  // Under its parent: the field comes before the interests in it.
  const artsValues = arts.options.map((o) => o.value);
  assert.ok(artsValues.indexOf('visual art') < artsValues.indexOf('photography'));
  // Something the catalogue never heard of is kept, at the end.
  const withStray = catalogueOptions([...chart.subjects, { id: 'the shed', n: 2, up: [], known: false }]);
  assert.equal(withStray.at(-1).label, 'Not in the catalogue yet');
  assert.equal(withStray.at(-1).options[0].text, 'the shed (2)');
});

test('a room they are not in yet is drawn fainter, flat and in relief', () => {
  const view = seededAtlas();
  const outside = view.rooms.find((r) => r.key === 'music') ?? view.rooms[0];
  const marked = { ...view, rooms: view.rooms.map((r) => (r.key === outside.key ? { ...r, member: false } : { ...r, member: true })) };
  for (const relief of [null, view3d()]) {
    const svg = canvas();
    renderAtlas(svg, marked, { relief });
    const away = [...svg.querySelectorAll('.zone-ground.away')];
    assert.ok(away.length >= 1, `${relief ? 'relief' : 'flat'}: something is faint`);
    assert.ok(away.every((g) => g.getAttribute('data-zone') === outside.key), 'only the room they are not in');
  }
});
