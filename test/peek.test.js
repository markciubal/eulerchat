import test from 'node:test';
import assert from 'node:assert/strict';
import { labelsNear, tourOf } from '../public/peek.js';
import { World } from '../server/store.js';
import { populate } from '../server/populate.js';

/**
 * The card played on "Explore all interests": where it goes, and what it
 * writes when it gets there. The playing itself is driven in `record.test.js`
 * against the real page; these are the two decisions underneath it.
 */

const overview = () => populate(new World(), { subjects: 400, users: 900, chatter: 0 }).overview();

test('the tour goes to different parts of the sheet, busiest first', () => {
  const { subjects } = overview();
  const apart = 250;
  const tour = tourOf(subjects, { stops: 3, apart });

  assert.equal(tour.length, 3);
  const busiest = subjects.filter((s) => s.known).reduce((a, b) => (b.n > a.n ? b : a));
  assert.equal(tour[0].n, busiest.n, 'it starts where the most people are');
  for (const [i, a] of tour.entries()) {
    for (const b of tour.slice(i + 1)) {
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= apart, `${a.id} and ${b.id} are the same neighbourhood`);
    }
  }
});

test('the tour starts with what they hold, and never on the unplaced ring', () => {
  const subjects = [
    { id: 'chess', n: 50, x: 0, y: 0, known: true },
    { id: 'go', n: 40, x: 10, y: 0, known: true },
    { id: 'padel', n: 2, x: 400, y: 0, known: true },
    { id: 'the shed', n: 90, x: -460, y: 0, known: false },
  ];
  const tour = tourOf(subjects, { held: new Set(['padel']), stops: 3, apart: 100 });
  assert.deepEqual(tour.map((s) => s.id), ['padel', 'chess'], 'theirs first, then the busiest; go is beside chess');
  assert.deepEqual(tourOf([subjects[3]], {}), [], 'nothing to tour on the ring');
});

test('the names at a stop are inside the view and clear of each other', () => {
  const { subjects } = overview();
  const [stop] = tourOf(subjects, { stops: 1 });
  const font = 9;
  const view = { x: stop.x - 110, y: stop.y - 70, width: 220, height: 140 };
  const labels = labelsNear(subjects, stop, view, { font, radius: () => 4 });

  assert.equal(labels[0].id, stop.id, 'the stop is always named, and first');
  assert.ok(labels.length > 1 && labels.length <= 5, `${labels.length} names`);

  const boxes = labels.map(({ id, x, y }) => {
    const half = (id.length * font * 0.56) / 2;
    return { id, left: x - half, right: x + half, top: y - font * 0.9, bottom: y + font * 0.25 };
  });
  for (const [i, a] of boxes.entries()) {
    if (i > 0) {
      assert.ok(a.left >= view.x && a.right <= view.x + view.width, `${a.id} runs off the side`);
      assert.ok(a.top >= view.y && a.bottom <= view.y + view.height, `${a.id} runs off the top or bottom`);
    }
    for (const b of boxes.slice(i + 1)) {
      const touch = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      assert.ok(!touch, `${a.id} lands on ${b.id}`);
    }
  }
});

test('a name sits above its dot, clear of it', () => {
  const at = { id: 'chess', n: 1, x: 0, y: 0 };
  const [label] = labelsNear([at], at, { x: -50, y: -50, width: 100, height: 100 }, { font: 10, radius: () => 6 });
  assert.ok(label.y + 10 * 0.25 < -6, 'the bottom of the name is above the top of the dot');
});
