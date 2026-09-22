import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { DOUBLE_GAP, gestures } from '../public/gestures.js';

/** A drawing to gesture at, and a record of what the gestures asked of it. */
function setup({ orbits = true, waitForDouble } = {}) {
  const { document } = parseHTML('<!doctype html><html><body><svg id="s"><circle id="dot" /></svg></body></html>');
  const el = document.getElementById('s');
  const calls = { pan: [], zoom: [], orbit: [], tap: [] };
  const handle = gestures(el, {
    canOrbit: () => orbits,
    pan: (dx, dy) => calls.pan.push([dx, dy]),
    zoom: (factor, x, y) => calls.zoom.push([factor, x, y]),
    orbit: (turn, tilt, anchor) => calls.orbit.push([turn, tilt, anchor]),
    tap: (tap) => calls.tap.push(tap),
    waitForDouble,
  });
  const fire = (type, { id = 1, x = 0, y = 0, target = el, ...rest } = {}) => {
    const evt = Object.assign(new document.defaultView.Event(type, { bubbles: true, cancelable: true }), {
      pointerId: id,
      clientX: x,
      clientY: y,
      button: 0,
      pointerType: 'mouse',
      ...rest,
    });
    target.dispatchEvent(evt);
    return evt;
  };
  return { document, el, calls, handle, fire, dot: document.getElementById('dot') };
}

const sum = (list, i) => list.reduce((n, c) => n + c[i], 0);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const drag = (fire, path, extra = {}) => {
  const [[x0, y0], ...rest] = path;
  fire('pointerdown', { x: x0, y: y0, ...extra });
  for (const [x, y] of rest) fire('pointermove', { x, y, ...extra });
  const [x1, y1] = path.at(-1);
  fire('pointerup', { x: x1, y: y1, ...extra });
};

test('one finger, or the mouse, drags it about, in relief as flat', () => {
  const { calls, fire, handle } = setup();
  drag(fire, [[100, 100], [130, 90], [160, 80]]);
  assert.deepEqual([sum(calls.pan, 0), sum(calls.pan, 1)], [60, -20], 'it goes where the hand goes');
  assert.equal(calls.orbit.length, 0, 'and does not turn');
  assert.equal(calls.tap.length, 0);
  assert.ok(handle.claims(), 'the click that follows is not a choice of anything');

  drag(fire, [[100, 100], [100, 140]], { pointerType: 'touch' });
  assert.deepEqual(calls.pan.at(-1), [0, 40], 'a finger too');
  assert.equal(calls.orbit.length, 0);
});

test('flat, with nothing to orbit, everything that would orbit it moves it', () => {
  const { calls, fire } = setup({ orbits: false });
  drag(fire, [[10, 10], [30, 15], [50, 5]]);
  drag(fire, [[10, 10], [20, 10]], { button: 2 });
  drag(fire, [[10, 10], [10, 20]], { shiftKey: true });
  assert.deepEqual(calls.pan, [[20, 5], [20, -10], [10, 0], [0, 10]]);
  assert.equal(calls.orbit.length, 0);
});

test('the right button, or Shift, orbits it with a mouse; the middle button moves it; the menu stays shut', () => {
  const { calls, fire, el, document } = setup();
  drag(fire, [[100, 100], [150, 80]], { button: 2 });
  const [turn, tilt] = [sum(calls.orbit, 0), sum(calls.orbit, 1)];
  assert.ok(turn < 0, `dragged right, the front follows the hand round (${turn.toFixed(3)})`);
  assert.ok(tilt > 0, `dragged up, it tips further away (${tilt.toFixed(3)})`);
  drag(fire, [[100, 100], [100, 120]], { shiftKey: true });
  assert.ok(calls.orbit.at(-1)[1] < 0, 'with Shift, dragged down, it is seen more from above');
  assert.equal(calls.pan.length, 0, 'orbiting does not also move it');
  drag(fire, [[100, 100], [90, 100]], { button: 1 });
  assert.deepEqual(calls.pan, [[-10, 0]]);

  // A right click that goes nowhere is somebody reaching for a menu, not a tap.
  drag(fire, [[5, 5]], { button: 2 });
  assert.equal(calls.tap.length, 0);
  const menu = new document.defaultView.Event('contextmenu', { bubbles: true, cancelable: true });
  el.dispatchEvent(menu);
  assert.equal(menu.defaultPrevented, true);
});

test('a press that stays put is a tap on whatever was under it when pressed', () => {
  const { calls, fire, dot, el } = setup();
  fire('pointerdown', { x: 10, y: 10, target: dot });
  fire('pointermove', { x: 12, y: 11 });
  // Released on the drawing as a whole, as a captured pointer is.
  fire('pointerup', { x: 12, y: 11, target: el });
  assert.equal(calls.tap.length, 1);
  assert.equal(calls.tap[0].target, dot);
});

test('a double click or double tap zooms in there, and with Shift out', () => {
  const { calls, fire } = setup();
  const tap = (x, y, extra = {}) => drag(fire, [[x, y]], extra);
  tap(100, 80);
  tap(104, 82);
  assert.deepEqual(calls.zoom, [[2, 104, 82]]);
  assert.equal(calls.tap.length, 1, 'a mouse click is had at once, the second is the zoom');

  tap(300, 300, { shiftKey: true });
  tap(300, 300, { shiftKey: true });
  assert.deepEqual(calls.zoom.at(-1), [0.5, 300, 300]);

  // Too far apart to be one double tap.
  tap(10, 10);
  tap(200, 200);
  assert.equal(calls.zoom.length, 2);
});

test('a finger tap that might be the first of two waits, and a second cancels it', async () => {
  const { calls, fire } = setup({ waitForDouble: (tap) => tap.pointerType === 'touch' });
  const tap = (x, y) => drag(fire, [[x, y]], { pointerType: 'touch' });
  tap(50, 50);
  assert.equal(calls.tap.length, 0, 'not yet');
  await wait(DOUBLE_GAP + 60);
  assert.equal(calls.tap.length, 1, 'once it is sure it was one');

  tap(50, 50);
  tap(52, 51);
  await wait(DOUBLE_GAP + 60);
  assert.equal(calls.tap.length, 1, 'the first of a double tap never opens anything');
  assert.deepEqual(calls.zoom, [[2, 52, 51]]);
});

test('two fingers moved together orbit it: across turns, down tilts, twisted turns', () => {
  const { calls, fire } = setup();
  const touch = (type, id, x, y) => fire(type, { id, x, y, pointerType: 'touch' });
  touch('pointerdown', 1, 100, 100);
  touch('pointerdown', 2, 200, 100);
  // Both across the screen together, a long way, then both down.
  for (let i = 1; i <= 4; i++) {
    touch('pointermove', 1, 100 + i * 15, 100);
    touch('pointermove', 2, 200 + i * 15, 100);
  }
  const across = sum(calls.orbit, 0);
  assert.ok(across < -0.3, `dragged right together, the front follows them round (${across.toFixed(3)})`);
  touch('pointermove', 1, 160, 140);
  touch('pointermove', 2, 260, 140);
  assert.ok(sum(calls.orbit, 1) < 0, 'dragged down together, it is seen more from above');
  // Turned between them, as a dial is.
  const before = sum(calls.orbit, 0);
  touch('pointermove', 1, 170, 120);
  touch('pointermove', 2, 250, 160);
  assert.ok(sum(calls.orbit, 0) - before > 0.2, 'twisted clockwise, it turns with them');
  touch('pointerup', 1, 170, 120);
  touch('pointerup', 2, 250, 160);

  assert.ok(calls.orbit.every(([, , anchor]) => Array.isArray(anchor)), 'about the point between them');
  assert.equal(calls.pan.length, 0, 'two fingers turn it; one moves it');
  assert.equal(calls.zoom.length, 0, 'not pinched, so not zoomed');
  assert.equal(calls.tap.length, 0);
});

test('two fingers dragged fast, reported one at a time, still orbit it rather than pinch it', () => {
  const { calls, fire } = setup();
  const touch = (type, id, x, y) => fire(type, { id, x, y, pointerType: 'touch' });
  touch('pointerdown', 1, 100, 100);
  touch('pointerdown', 2, 200, 100);
  // Straight after the first finger's report the two look as if they spread.
  touch('pointermove', 1, 130, 100);
  touch('pointermove', 2, 230, 100);
  touch('pointermove', 1, 160, 100);
  touch('pointermove', 2, 260, 100);
  touch('pointerup', 1, 160, 100);
  touch('pointerup', 2, 260, 100);
  assert.equal(calls.zoom.length, 0, 'not a pinch');
  assert.ok(sum(calls.orbit, 0) < -0.3, 'turned');
});

test('two fingers pinched zoom it, and do not turn it, even with one held still', () => {
  const { calls, fire } = setup();
  const touch = (type, id, x, y) => fire(type, { id, x, y, pointerType: 'touch' });
  // A thumb held still and a finger drawn away from it: the point between
  // them moves as far as they spread, and it is still only a pinch.
  touch('pointerdown', 1, 100, 100);
  touch('pointerdown', 2, 160, 100);
  for (let i = 1; i <= 6; i++) touch('pointermove', 2, 160 + i * 15, 100 + i * 3);
  touch('pointerup', 2, 250, 118);
  touch('pointerup', 1, 100, 100);

  const zoomed = calls.zoom.reduce((n, [f]) => n * f, 1);
  assert.ok(zoomed > 2, `spread apart zooms in (${zoomed.toFixed(2)})`);
  assert.equal(calls.orbit.length, 0, 'not turned');
  assert.equal(calls.pan.length, 0, 'not moved');
});

test('flat, two fingers move it where they go and pinch it closer', () => {
  const { calls, fire } = setup({ orbits: false });
  const touch = (type, id, x, y) => fire(type, { id, x, y, pointerType: 'touch' });
  touch('pointerdown', 1, 100, 100);
  touch('pointerdown', 2, 200, 100);
  touch('pointermove', 1, 100, 140);
  touch('pointermove', 2, 200, 140);
  touch('pointermove', 1, 70, 140);
  touch('pointermove', 2, 240, 140);
  touch('pointerup', 1, 70, 140);
  touch('pointerup', 2, 240, 140);
  assert.ok(sum(calls.pan, 1) > 30, 'moved with them');
  assert.ok(calls.zoom.reduce((n, [f]) => n * f, 1) > 1.4, 'and spread apart zooms in');
  assert.equal(calls.orbit.length, 0);
});

test('taking one finger off two does not start moving or turning it', () => {
  const { calls, fire } = setup();
  const touch = (type, id, x, y) => fire(type, { id, x, y, pointerType: 'touch' });
  touch('pointerdown', 1, 100, 100);
  touch('pointerdown', 2, 200, 100);
  touch('pointermove', 2, 230, 100);
  touch('pointerup', 2, 230, 100);
  touch('pointermove', 1, 160, 60);
  touch('pointerup', 1, 160, 60);
  assert.equal(calls.orbit.length, 0);
  assert.equal(calls.pan.length, 0);
  assert.equal(calls.tap.length, 0);
});

test('a two-finger tap zooms out', () => {
  const { calls, fire } = setup();
  const touch = (type, id, x, y) => fire(type, { id, x, y, pointerType: 'touch' });
  touch('pointerdown', 1, 100, 100);
  touch('pointerdown', 2, 140, 120);
  touch('pointerup', 1, 100, 100);
  touch('pointerup', 2, 140, 120);
  assert.deepEqual(calls.zoom, [[0.5, 120, 110]]);
  assert.equal(calls.tap.length, 0, 'and is not a tap as well');
});

test('a mouse wheel zooms a notch at a time, and a trackpad orbits it with two fingers and pinches it', async () => {
  const { calls, el, document } = setup();
  const wheel = (props) => {
    const evt = Object.assign(new document.defaultView.Event('wheel', { bubbles: true, cancelable: true }), {
      deltaX: 0,
      deltaY: 0,
      deltaMode: 0,
      clientX: 50,
      clientY: 60,
      ctrlKey: false,
      ...props,
    });
    el.dispatchEvent(evt);
    return evt;
  };

  assert.equal(wheel({ deltaY: -100 }).defaultPrevented, true);
  wheel({ deltaY: 120 });
  wheel({ deltaY: 3, deltaMode: 1 });
  assert.deepEqual(calls.zoom.map(([f]) => Number(f.toFixed(3))), [1.18, 0.847, 0.847]);

  // Two fingers on a trackpad: small, smooth, and often sideways. They turn
  // it as two fingers on a screen do, the fingers going the other way to
  // the scroll.
  wheel({ deltaX: 6, deltaY: 12 });
  const [turn, tilt] = calls.orbit.at(-1);
  assert.ok(turn > 0 && tilt > 0, 'scrolled right and down: the fingers went left and up');
  // A bigger one straight after is the same gesture, still turning it.
  wheel({ deltaY: 60 });
  assert.equal(calls.orbit.length, 2);
  assert.equal(calls.pan.length, 0);

  // A trackpad pinch comes as the wheel with Ctrl held.
  wheel({ deltaY: -20, ctrlKey: true });
  assert.ok(calls.zoom.at(-1)[0] > 1.2);

  await wait(350);
  wheel({ deltaY: 100 });
  assert.equal(calls.zoom.length, 5, 'and once the trackpad has stopped, a notch is a notch again');
});

test('flat, a trackpad scrolled with two fingers moves it', () => {
  const { calls, el, document } = setup({ orbits: false });
  const evt = Object.assign(new document.defaultView.Event('wheel', { bubbles: true, cancelable: true }), {
    deltaX: 6, deltaY: 12, deltaMode: 0, clientX: 0, clientY: 0, ctrlKey: false,
  });
  el.dispatchEvent(evt);
  assert.deepEqual(calls.pan, [[-6, -12]]);
  assert.equal(calls.orbit.length, 0);
});
