import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { renderDiagram, regionAt, scopeOf, cssId, NS } from '../public/diagram.js';
import { World, seed } from '../server/store.js';
import { receives } from '../lib/regions.js';

function draw() {
  const world = seed(new World());
  const guest = world.addUser('guest');
  const diagram = world.diagramFor(guest);

  const { document } = parseHTML('<!doctype html><html><body></body></html>');
  const svg = document.createElementNS(NS, 'svg');
  document.body.append(svg);

  return { svg, diagram, ...renderDiagram(svg, diagram) };
}

test('every region gets a fill and every circle a clip path', () => {
  const { svg, diagram, fills } = draw();

  assert.equal(fills.size, diagram.rooms.length);
  assert.equal(svg.querySelectorAll('clipPath').length, diagram.circles.length);
  assert.equal(svg.querySelectorAll('mask').length, diagram.rooms.length);
  assert.equal(svg.querySelectorAll('.ring').length, diagram.circles.length);
});

test('no reference dangles', () => {
  // A url(#...) pointing at nothing renders as either everything or nothing,
  // silently. This is the failure the whole file exists to catch.
  const { svg } = draw();

  const ids = new Set([...svg.querySelectorAll('[id]')].map((n) => n.getAttribute('id')));
  const refs = [];
  for (const node of svg.querySelectorAll('[clip-path], [mask]')) {
    for (const attr of ['clip-path', 'mask']) {
      const value = node.getAttribute(attr);
      if (value) refs.push(value.slice(5, -1)); // url(#x) -> x
    }
  }

  assert.ok(refs.length > 0, 'expected some references');
  for (const ref of refs) assert.ok(ids.has(ref), `dangling reference: ${ref}`);
});

test('a region is its own circles intersected, minus the rest', () => {
  const { svg, diagram, fills } = draw();

  for (const room of diagram.rooms) {
    const fill = fills.get(room.key);

    // Walk up from the fill collecting the clips that bound it.
    const clipped = [];
    let maskId = null;
    for (let node = fill.parentNode; node && node !== svg; node = node.parentNode) {
      const clip = node.getAttribute?.('clip-path');
      if (clip) clipped.push(clip.slice(5, -1).replace(/^clip-/, ''));
      const mask = node.getAttribute?.('mask');
      if (mask) maskId = mask.slice(5, -1);
    }

    assert.deepEqual(
      clipped.map((c) => c).sort(),
      room.subjects.map(cssId).sort(),
      `${room.key} should be clipped to exactly its own circles`,
    );

    // And the mask must subtract every circle the region excludes.
    const mask = svg.querySelector(`#${maskId}`);
    const subtracted = mask.querySelectorAll('circle').length;
    assert.equal(
      subtracted,
      diagram.circles.length - room.subjects.length,
      `${room.key} should subtract the circles it does not contain`,
    );
  }
});

test('a coordinate resolves to the room that contains it', () => {
  const { diagram } = draw();
  const circles = diagram.circles;
  const at = (c) => regionAt(circles, c.x, c.y);

  for (const c of circles) {
    const room = at(c);
    assert.ok(room.split('+').includes(c.id), `centre of ${c.id} should be inside ${c.id}`);
  }

  // Far outside everything is not a room, and must not pretend to be one.
  const far = Math.max(...circles.map((c) => Math.hypot(c.x, c.y) + c.r)) + 100;
  assert.equal(regionAt(circles, far, far), null);
});

test('every room can actually be clicked into', () => {
  // A room the census offers but the picture gives you no way to reach is a
  // dead end: it would appear in the list with a population and simply refuse
  // to open. Sweep the diagram and confirm each room owns some ground.
  const { diagram } = draw();
  const { circles, bounds, rooms } = diagram;

  const reachable = new Set();
  const steps = 260;
  for (let i = 0; i <= steps; i++) {
    const x = bounds.minX + ((bounds.maxX - bounds.minX) * i) / steps;
    for (let j = 0; j <= steps; j++) {
      const y = bounds.minY + ((bounds.maxY - bounds.minY) * j) / steps;
      const at = regionAt(circles, x, y);
      if (at) reachable.add(at);
    }
  }

  for (const room of rooms) {
    assert.ok(reachable.has(room.key), `${room.key} has no clickable ground`);
  }

  // And the sweep must not turn up regions that are not rooms — that would be
  // two circles crossing where no shared membership exists.
  const known = new Set(rooms.map((r) => r.key));
  for (const found of reachable) {
    assert.ok(known.has(found), `${found} is drawn but is not a room`);
  }
});

test('selecting a single subject lights its whole circle', () => {
  // Regions are drawn exclusively but delivery is by containment, so the lit
  // area for `art` has to be every region inside art — not the art-only sliver.
  // Otherwise a single-subject room looks like the smallest place on the map
  // when it is in fact the largest.
  const keys = ['art', 'music', 'philosophy', 'art+music', 'art+philosophy', 'art+music+philosophy'];

  assert.deepEqual(
    [...scopeOf(keys, 'art')].sort(),
    ['art', 'art+music', 'art+music+philosophy', 'art+philosophy'],
  );

  // An overlap covers itself and anything nested deeper inside it.
  assert.deepEqual(
    [...scopeOf(keys, 'art+philosophy')].sort(),
    ['art+music+philosophy', 'art+philosophy'],
  );

  // The deepest region covers only itself, and nothing is lit with no selection.
  assert.deepEqual([...scopeOf(keys, 'art+music+philosophy')], ['art+music+philosophy']);
  assert.deepEqual([...scopeOf(keys, null)], []);
});

test('the lit area is exactly the audience', () => {
  // The same predicate decides who receives a message and what the map lights
  // up, so the picture cannot promise an audience the router will not deliver.
  const world = seed(new World());
  const reader = world.addUser('reader');
  world.join(reader, 'art');
  world.join(reader, 'philosophy');

  const rooms = world.diagramFor(reader).rooms.map((r) => r.key);

  for (const selected of rooms) {
    const lit = scopeOf(rooms, selected);
    for (const roomKey of rooms) {
      // A region is lit iff somebody standing there would receive the post.
      const wouldReceive = receives(roomKey.split('+'), selected.split('+'));
      assert.equal(lit.has(roomKey), wouldReceive, `${selected} -> ${roomKey}`);
    }
  }
});

test('a lone subject still draws', () => {
  const world = new World();
  world.addSubject('art');
  const solo = world.addUser('solo');
  world.join(solo, 'art');

  const { document } = parseHTML('<!doctype html><html><body></body></html>');
  const svg = document.createElementNS(NS, 'svg');
  const { fills } = renderDiagram(svg, world.diagramFor(solo));

  assert.equal(fills.size, 1);
  for (const node of svg.querySelectorAll('text, circle, rect')) {
    for (const attr of ['x', 'y', 'cx', 'cy', 'r', 'width', 'height']) {
      const value = node.getAttribute(attr);
      if (value !== null) assert.ok(!/NaN/.test(value), `${attr}="${value}"`);
    }
  }
});

test('an empty world draws nothing rather than throwing', () => {
  const { document } = parseHTML('<!doctype html><html><body></body></html>');
  const svg = document.createElementNS(NS, 'svg');
  const world = new World();
  const nobody = world.addUser('nobody');

  const { fills, viewBox } = renderDiagram(svg, world.diagramFor(nobody));
  assert.equal(fills.size, 0);
  assert.equal(viewBox, null);
});
