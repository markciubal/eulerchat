import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { boxAround, cullTo, overlaps, viewBoxOf } from '../public/cull.js';
import { view3d } from '../public/relief.js';

/**
 * Culling: what is drawn but out of view is not painted. The test is four
 * comparisons between two boxes, and everything else here is making sure the
 * boxes are generous enough that nothing in view is ever hidden, and that
 * nothing is written when nothing changed.
 */

const box = (x0, y0, x1, y1) => ({ x0, y0, x1, y1 });

test('two boxes meet unless one is wholly to one side of the other', () => {
  const a = box(0, 0, 10, 10);
  assert.ok(overlaps(a, box(5, 5, 15, 15)), 'overlapping');
  assert.ok(overlaps(a, box(2, 2, 3, 3)), 'one inside the other');
  assert.ok(overlaps(a, box(10, 0, 20, 10)), 'sharing an edge');
  for (const apart of [box(11, 0, 20, 10), box(-20, 0, -1, 10), box(0, 11, 10, 20), box(0, -20, 10, -1)]) {
    assert.ok(!overlaps(a, apart), `${JSON.stringify(apart)} is to one side`);
  }
  // Diagonally off a corner: apart on both axes, not on one.
  assert.ok(!overlaps(a, box(11, 11, 20, 20)));
});

test('a view keeps a margin past each edge', () => {
  const v = viewBoxOf({ x: 100, y: 50, width: 200, height: 100 }, 20, 10);
  assert.deepEqual(v, box(80, 40, 320, 160));
  assert.ok(overlaps(box(305, 60, 315, 70), v), 'just past the right edge is still kept');
});

test("a raised shape's box holds it at every height it stands, however it is turned", () => {
  const corners = [[-10, -10], [10, -10], [-10, 10], [10, 10]];
  for (const turn of [0, 0.7, 2.1, 4]) {
    const view = view3d({ turn });
    const b = boxAround(view.at, corners, [0, 40]);
    // Every point of the ground patch, at the foot, the top and between.
    for (let x = -10; x <= 10; x += 5) {
      for (let y = -10; y <= 10; y += 5) {
        for (const h of [0, 13, 40]) {
          const [X, Y] = view.at(x, y, h);
          assert.ok(X >= b.x0 - 1e-9 && X <= b.x1 + 1e-9 && Y >= b.y0 - 1e-9 && Y <= b.y1 + 1e-9, `(${x}, ${y}, ${h}) at turn ${turn}`);
        }
      }
    }
  }
});

test('culling hides what left the view, shows what came back, and writes nothing else', () => {
  const { document } = parseHTML('<!doctype html><html><body><svg></svg></body></html>');
  const node = () => document.createElementNS('http://www.w3.org/2000/svg', 'g');
  const parts = [
    { box: box(0, 0, 10, 10), nodes: [node(), node()] },
    { box: box(100, 0, 110, 10), nodes: [node()] },
  ];
  const writes = [];
  const count = (part, on) => writes.push([parts.indexOf(part), on]);

  // Everything drawn counts as shown, so nothing in view is touched.
  assert.equal(cullTo(parts, box(-5, -5, 50, 50), count), 1);
  assert.deepEqual(writes, [[1, false]], 'only the one that is out of view');
  assert.ok(parts[1].nodes[0].classList.contains('culled'));
  assert.ok(!parts[0].nodes[0].classList.contains('culled'));

  // The same view again: nothing changes, so nothing is written.
  writes.length = 0;
  cullTo(parts, box(-5, -5, 50, 50), count);
  assert.deepEqual(writes, []);

  // Panned across: the first goes, the second comes back.
  cullTo(parts, box(60, -5, 120, 50), count);
  assert.deepEqual(writes, [[0, false], [1, true]]);
  assert.ok(parts[0].nodes.every((n) => n.classList.contains('culled')));
  assert.ok(!parts[1].nodes[0].classList.contains('culled'));
});
