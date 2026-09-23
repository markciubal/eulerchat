import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { mountTour } from '../public/tour.js';

/** A page with the tour's parts on it, and two things to point at. */
function page({ second = true, watching = true } = {}) {
  const { document } = parseHTML(`<!doctype html><html><body>
    <button id="one">One</button>
    <button id="two">Two</button>
    <button id="tour-open"><svg id="tour-nib" class="tour-nib"><g class="tour-wiggle"></g></svg></button>
    <div id="tour" hidden>
      <div id="tour-ring"></div>
      <div id="tour-card" tabindex="-1">
        <p id="tour-step"></p><h2 id="tour-title"></h2><p id="tour-say"></p>
        <button id="tour-back"></button><button id="tour-next"></button><button id="tour-stop"></button>
      </div>
    </div>
  </body></html>`);
  const win = document.defaultView;
  // Frames are asked for and run later, as a browser runs them: run at once
  // and the handle would be assigned after the callback had already cleared
  // it, which is not how any of this behaves in a page.
  const frames = [];
  win.requestAnimationFrame = (fn) => frames.push(fn);
  win.cancelAnimationFrame = () => frames.splice(0, frames.length);
  win.innerWidth = 1000;
  win.innerHeight = 800;
  // linkedom measures nothing, so the page says where things are.
  const boxes = {
    one: { left: 100, top: 50, width: 80, height: 30 },
    two: { left: 600, top: 400, width: 120, height: 40 },
    'tour-card': { left: 0, top: 0, width: 300, height: 160 },
    // The arrow is the button's icon, up in a header at the top right.
    'tour-nib': { left: 940, top: 10, width: 16, height: 16 },
  };
  for (const [id, box] of Object.entries(boxes)) {
    document.getElementById(id).getBoundingClientRect = () => ({
      ...box,
      right: box.left + box.width,
      bottom: box.top + box.height,
    });
  }
  const opened = [];
  const steps = [
    { at: () => document.getElementById('one'), title: 'The first', say: 'about one', before: () => opened.push('one') },
    { at: () => (second ? document.getElementById('two') : null), title: 'The second', say: 'about two' },
  ];
  let ended = 0;
  const started = [];
  const tour = mountTour(document, {
    steps,
    watching,
    opening: () => started.push('opened'),
    done: () => (ended += 1),
  });
  /** Run frames until the arrow has caught up, as a browser would over a moment. */
  const settle = () => {
    for (let i = 0; i < 200 && frames.length; i++) frames.shift()();
  };
  return {
    document,
    win,
    tour,
    opened,
    started,
    settle,
    ended: () => ended,
    press: (id) => document.getElementById(id).dispatchEvent(new win.Event('click', { bubbles: true })),
  };
}

const ring = (document) => document.getElementById('tour-ring').style;
const arrow = (document) => document.getElementById('tour-nib').style.transform ?? '';
const turnOf = (transform) => Number(/rotate\(([-\d.]+)deg\)/.exec(transform)?.[1] ?? NaN);
/**
 * Which way the tip ends up facing, as a bearing in degrees, 0 to 360.
 *
 * The nib is drawn facing up and to the left — 225° — and the turn is applied
 * on top of that. Measured in a browser: at this the tip lands on the pointer
 * to within a degree.
 */
const facing = (transform) => (((turnOf(transform) + 225) % 360) + 360) % 360;

test('the tour rings what each step is about, and says which step it is', () => {
  const { document, tour, opened } = page();
  assert.equal(tour.isOn, false);
  tour.start();
  assert.equal(tour.isOn, true);
  assert.equal(document.getElementById('tour').hidden, false);
  assert.equal(document.getElementById('tour-step').textContent, '1 of 2');
  assert.equal(document.getElementById('tour-title').textContent, 'The first');
  assert.equal(document.getElementById('tour-say').textContent, 'about one');
  assert.deepEqual(opened, ['one'], 'and opens whatever the step needs first');
  // The ring is round the first thing, with a little room to spare.
  assert.equal(ring(document).left, '94px');
  assert.equal(ring(document).top, '44px');
  assert.equal(ring(document).width, '92px');
  assert.equal(document.getElementById('tour-back').disabled, true, 'nowhere to go back to');
  assert.equal(document.getElementById('tour-next').textContent, 'Next');
});

test('it goes on and back, and the last step finishes it', () => {
  const { document, tour, press, ended } = page();
  tour.start();
  press('tour-next');
  assert.equal(document.getElementById('tour-title').textContent, 'The second');
  assert.equal(document.getElementById('tour-step').textContent, '2 of 2');
  assert.equal(document.getElementById('tour-next').textContent, 'Done', 'the last one says so');
  assert.equal(ring(document).left, '594px', 'and the ring has moved');

  press('tour-back');
  assert.equal(document.getElementById('tour-title').textContent, 'The first');
  press('tour-next');
  press('tour-next');
  assert.equal(tour.isOn, false, 'done');
  assert.equal(ended(), 1, 'and said so once');
});

test('off duty, the button’s own icon turns to face the pointer', () => {
  const { document, win, settle } = page();
  const move = (x, y) => {
    document.dispatchEvent(Object.assign(new win.Event('pointermove', { bubbles: true }), { clientX: x, clientY: y }));
    settle();
  };

  // The icon is at (948, 18). A pointer below and to the left of it is
  // roughly south-west; one below and to the right, south-east.
  move(100, 700);
  const left = facing(arrow(document));
  assert.ok(left > 90 && left < 180, `south-west, not ${left}°`);

  move(1400, 700);
  const right = facing(arrow(document));
  assert.ok(right > 0 && right < 90, `south-east, not ${right}°`);
});

test('on the tour it faces the step instead, and stops chasing the pointer', () => {
  const { document, win, tour, settle } = page();
  tour.start();
  settle();
  // The first step is at (140, 65): away to the left of the icon and barely
  // below it, which is west and a whisker south.
  const atStep = facing(arrow(document));
  assert.ok(atStep > 150 && atStep < 200, `west, not ${atStep}°`);

  // The pointer moving no longer turns it: it has something to point at.
  document.dispatchEvent(Object.assign(new win.Event('pointermove', { bubbles: true }), { clientX: 1200, clientY: 800 }));
  settle();
  assert.equal(Math.round(facing(arrow(document))), Math.round(atStep));

  // The next step is somewhere else, and it turns that way.
  document.getElementById('tour-next').dispatchEvent(new win.Event('click', { bubbles: true }));
  settle();
  assert.notEqual(Math.round(facing(arrow(document))), Math.round(atStep), 'it turned to the new one');
});

test('Escape stops it, and so does Stop', () => {
  const { document, win, tour, press, ended } = page();
  tour.start();
  const escape = Object.assign(new win.Event('keydown', { bubbles: true, cancelable: true }), { key: 'Escape' });
  document.dispatchEvent(escape);
  assert.equal(tour.isOn, false);
  assert.equal(ended(), 1);

  tour.start();
  press('tour-stop');
  assert.equal(tour.isOn, false);
  assert.equal(ended(), 2);
  // Stopped twice over is still stopped once: nothing is told twice.
  press('tour-stop');
  assert.equal(ended(), 2);
});

test('the arrow keys walk it, and a step with nothing to point at still speaks', () => {
  const { document, win, tour } = page({ second: false });
  tour.start();
  const key = (k) => document.dispatchEvent(Object.assign(new win.Event('keydown', { bubbles: true, cancelable: true }), { key: k }));
  key('ArrowRight');
  assert.equal(document.getElementById('tour-title').textContent, 'The second');
  assert.equal(document.getElementById('tour-ring').hidden, true, 'nothing to ring');
  assert.ok(document.getElementById('tour-card').style.left, 'the card stands where it can be read');
  key('ArrowLeft');
  assert.equal(document.getElementById('tour-title').textContent, 'The first');
  assert.equal(document.getElementById('tour-ring').hidden, false);
});

test('told to stop watching, the arrow stands straight up and stays there', () => {
  const { document, win, tour, settle } = page();
  const move = (x, y) => {
    document.dispatchEvent(Object.assign(new win.Event('pointermove', { bubbles: true }), { clientX: x, clientY: y }));
    settle();
  };
  move(100, 700);
  assert.notEqual(Math.round(facing(arrow(document))), 270, 'it was watching');

  tour.watch(false);
  settle();
  assert.equal(tour.watching, false);
  assert.equal(Math.round(facing(arrow(document))), 270, 'straight up');

  // And it stays up, however the pointer wanders.
  move(1300, 40);
  assert.equal(Math.round(facing(arrow(document))), 270);
  move(20, 880);
  assert.equal(Math.round(facing(arrow(document))), 270);

  // The tour still points at its steps: that is what it is for.
  tour.start();
  settle();
  assert.notEqual(Math.round(facing(arrow(document))), 270, 'it points at the step');
  // And when the tour is over it goes back to standing up.
  document.getElementById('tour-stop').dispatchEvent(new win.Event('click', { bubbles: true }));
  settle();
  assert.equal(Math.round(facing(arrow(document))), 270);

  // Asked back, it watches again.
  tour.watch(true);
  move(1300, 700);
  assert.notEqual(Math.round(facing(arrow(document))), 270);
});

test('it can be mounted not watching in the first place', () => {
  const { document, win, tour, settle } = page({ watching: false });
  assert.equal(tour.watching, false);
  document.dispatchEvent(Object.assign(new win.Event('pointermove', { bubbles: true }), { clientX: 40, clientY: 800 }));
  settle();
  assert.equal(Math.round(facing(arrow(document))), 270, 'still straight up');
});
