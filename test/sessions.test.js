import test from 'node:test';
import assert from 'node:assert/strict';
import { Sessions } from '../server/sessions.js';
import { World, seed } from '../server/store.js';

test('the world answers who, not where', () => {
  // The whole point of the split: routing can be asked without a socket in
  // sight, so any transport can carry it.
  const w = new World();
  for (const s of ['art', 'philosophy']) w.addSubject(s);

  const artist = w.addUser('artist');
  const both = w.addUser('both');
  w.join(artist, 'art');
  w.join(both, 'art');
  w.join(both, 'philosophy');

  assert.deepEqual(w.audienceFor(['art']).sort(), [artist, both].sort());
  assert.deepEqual(w.audienceFor(['art', 'philosophy']), [both]);
  assert.deepEqual(w.audienceFor(['philosophy']), [both]);

  // Nothing socket-shaped is required, or even possible, to ask.
  assert.equal(typeof w.sessions, 'undefined');
});

test('a narrowed audience matches the full one', () => {
  const w = seed(new World());
  const here = w.addUser('here');
  w.join(here, 'art');

  const everyone = w.audienceFor(['art']);
  const narrowed = w.audienceFor(['art'], [here]);

  assert.ok(everyone.includes(here));
  assert.deepEqual(narrowed, [here]);
  // Narrowing is an optimisation, never a different answer.
  assert.ok(narrowed.every((id) => everyone.includes(id)));
});

test('one person can be connected several times over', () => {
  // Two tabs, a phone and a laptop. The old shape could not express this:
  // sessions were keyed by id on the world with no way back from a user.
  const sessions = new Sessions();
  sessions.open('a', 'wren', { tag: 'laptop' });
  sessions.open('b', 'wren', { tag: 'phone' });
  sessions.open('c', 'osmo', { tag: 'desktop' });

  assert.equal(sessions.size, 3);
  assert.deepEqual(sessions.forUser('wren').map((s) => s.socket.tag).sort(), ['laptop', 'phone']);
  assert.deepEqual([...sessions.present()].sort(), ['osmo', 'wren']);

  // A message for wren reaches both of their connections and neither of osmo's.
  assert.deepEqual(sessions.reaching(['wren']).map((s) => s.id).sort(), ['a', 'b']);
  assert.deepEqual(sessions.reaching(['wren', 'osmo']).length, 3);
  assert.deepEqual(sessions.reaching([]), []);
});

test('closing one connection leaves the others alone', () => {
  const sessions = new Sessions();
  sessions.open('a', 'wren', {});
  sessions.open('b', 'wren', {});

  const closed = sessions.close('a');
  assert.equal(closed.id, 'a');
  assert.deepEqual(sessions.forUser('wren').map((s) => s.id), ['b']);
  assert.deepEqual([...sessions.present()], ['wren']);

  sessions.close('b');
  assert.equal(sessions.size, 0);
  // The reverse index must not keep an empty set for someone entirely gone.
  assert.deepEqual([...sessions.present()], []);
  assert.equal(sessions.close('gone'), null);
});

test('resuming moves a live connection to another identity', () => {
  const sessions = new Sessions();
  sessions.open('a', 'guest-xyz', {});
  sessions.open('b', 'wren', {});

  sessions.reassign('a', 'wren');

  assert.deepEqual(sessions.forUser('wren').map((s) => s.id).sort(), ['a', 'b']);
  assert.deepEqual([...sessions.present()], ['wren']);
  assert.equal(sessions.get('a').userId, 'wren');
  // A reassigned session must be redrawn, so its last view is cleared.
  assert.equal(sessions.get('a').lastView, null);
  assert.equal(sessions.reassign('missing', 'wren'), null);
});

test('iterating a Sessions gives sessions', () => {
  const sessions = new Sessions();
  sessions.open('a', 'wren', {});
  sessions.open('b', 'osmo', {});

  assert.deepEqual([...sessions].map((s) => s.userId).sort(), ['osmo', 'wren']);
});
