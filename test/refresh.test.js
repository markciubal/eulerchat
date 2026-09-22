import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { World, seed, stock } from '../server/store.js';
import { createEulerChat } from '../server/app.js';

/**
 * Every open page asks for its map again every ten seconds, and All interests
 * too while it is open, for how busy everything has been. So the drawing is
 * solved once for what it is drawn from and kept, and a page that says which
 * drawing it has is sent only the numbers.
 */

const WebSocket = createRequire(import.meta.url)('ws');

/** Someone holding art and philosophy, with company, in a stocked world. */
function peopled() {
  const world = seed(new World());
  const me = world.addUser('me');
  world.join(me, 'art');
  world.join(me, 'philosophy');
  const them = world.addUser('them');
  world.join(them, 'art');
  world.join(them, 'philosophy');
  return { world, me, them };
}

test('the drawing is solved once for what it is drawn from, and the rooms every time', () => {
  const { world, me, them } = peopled();
  const first = world.atlasFor(me, 5);
  const again = world.atlasFor(me, 5);
  assert.equal(again.shape, first.shape, 'the same drawing is named the same');
  assert.equal(again.zones, first.zones, 'and is the very same drawing, not solved again');
  assert.notEqual(again.rooms, first.rooms, 'while the rooms are worked out afresh');

  // Something said: the drawing is the same, how busy it is is not. (How
  // tall it stands is against the liveliest room anywhere, which this may
  // already be, so the count is what is certain to move.)
  const room = (view) => view.rooms.find((r) => r.key === 'art+philosophy');
  const said = room(first).messages;
  world.post(them, ['art', 'philosophy'], 'what is beauty for?');
  const busier = world.atlasFor(me, 5);
  assert.equal(busier.shape, first.shape);
  assert.equal(room(busier).messages, said + 1, 'the rooms are not kept with the drawing');
  assert.ok(room(busier).activity > 0, 'and it stands up off the floor');

  // Somebody joining changes the drawing, and so its name.
  world.join(world.addUser('newcomer'), 'art');
  assert.notEqual(world.atlasFor(me, 5).shape, first.shape);
});

test('the chart is kept apart from how lively things are, and named by the rest', () => {
  const world = new World();
  stock(world);
  const someone = world.addUser('someone');
  world.join(someone, 'chess');
  const first = world.chart();
  world.post(someone, ['chess'], 'e4');
  const after = world.chart();
  assert.equal(after.shape, first.shape, 'a message changes only how lively it is');
  assert.ok(after.subjects.find((s) => s.id === 'chess').a > 0, 'and chess is livelier');
  world.join(world.addUser('another'), 'chess');
  assert.notEqual(world.chart().shape, first.shape, 'a join changes the chart');
});

/** A connection, and a way to wait for the next frame of a kind. */
async function connect(chat) {
  const ws = new WebSocket(`ws://127.0.0.1:${chat.server.address().port}/`);
  const frames = [];
  ws.on('message', (raw) => frames.push(JSON.parse(raw)));
  await new Promise((resolve) => ws.once('open', resolve));
  const next = async (type, after = frames.length) => {
    for (let i = 0; i < 500; i++) {
      const found = frames.slice(after).find((f) => f.type === type);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no ${type} frame`);
  };
  return { ws, frames, next, ask: (frame) => ws.send(JSON.stringify(frame)) };
}

test('a page that has the drawing is sent only the rooms, and one that has not the whole', async () => {
  const world = seed(new World());
  const chat = createEulerChat({ world, serveClient: false });
  await new Promise((resolve) => chat.server.listen(0, resolve));
  const page = await connect(chat);
  try {
    page.ask({ type: 'join', subject: 'art' });
    await page.next('state');
    let at = page.frames.length;
    page.ask({ type: 'atlas', subjects: 5 });
    const whole = await page.next('atlas', at);
    assert.ok(whole.zones && whole.curves && whole.shape, 'the whole drawing, named');

    at = page.frames.length;
    page.ask({ type: 'atlas', subjects: 5, have: whole.shape });
    const numbers = await page.next('atlas', at);
    assert.equal(numbers.only, 'rooms');
    assert.equal(numbers.shape, whole.shape);
    assert.equal(numbers.zones, undefined, 'no drawing sent again');
    assert.deepEqual(numbers.rooms.map((r) => r.key), whole.rooms.map((r) => r.key));
    assert.ok(JSON.stringify(numbers).length * 5 < JSON.stringify(whole).length, 'a fraction of the size');

    // A drawing it does not have — an old one — gets the whole of the new.
    at = page.frames.length;
    page.ask({ type: 'atlas', subjects: 5, have: 'not-this-one' });
    assert.ok((await page.next('atlas', at)).zones);
  } finally {
    page.ws.close();
    chat.close();
  }
});

test('All interests, asked again by a page that has it, is sent only how lively each is', async () => {
  const world = new World();
  stock(world);
  const chat = createEulerChat({ world, serveClient: false });
  await new Promise((resolve) => chat.server.listen(0, resolve));
  const page = await connect(chat);
  try {
    let at = page.frames.length;
    page.ask({ type: 'chart' });
    const whole = await page.next('chart', at);
    assert.ok(whole.subjects.length > 100 && whole.shape);

    const someone = world.addUser('someone');
    world.join(someone, 'chess');
    at = page.frames.length;
    page.ask({ type: 'chart', have: whole.shape });
    const changed = await page.next('chart', at);
    assert.ok(changed.subjects, 'a join since: the whole chart, since the counts have moved');

    world.post(someone, ['chess'], 'e4');
    at = page.frames.length;
    page.ask({ type: 'chart', have: changed.shape });
    const lively = await page.next('chart', at);
    assert.equal(lively.only, 'activity');
    assert.equal(lively.subjects, undefined);
    assert.ok(lively.activity.some(([id, a]) => id === 'chess' && a > 0), 'chess, and how lively');
  } finally {
    page.ws.close();
    chat.close();
  }
});
