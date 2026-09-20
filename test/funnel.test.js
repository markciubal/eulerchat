import test from 'node:test';
import assert from 'node:assert/strict';
import { World, seed } from '../server/store.js';
import { ancestorsOf } from '../lib/taxonomy.js';
import { knowledge, subfields } from '../lib/knowledge.js';

test('the broader subjects above one, nearest first', () => {
  assert.deepEqual(ancestorsOf('entomology', knowledge, 2), ['biology', 'natural sciences']);
  assert.deepEqual(ancestorsOf('baking', knowledge, 2), ['cooking', 'hobbies']);
  assert.deepEqual(ancestorsOf('entomology', knowledge, 1), ['biology']);
  assert.deepEqual(ancestorsOf('entomology', knowledge, 0), []);

  // Never the root: a room containing everybody is not a room.
  assert.deepEqual(ancestorsOf('entomology', knowledge, 9), ['biology', 'natural sciences']);
  assert.deepEqual(ancestorsOf('hobbies', knowledge, 3), []);
  assert.deepEqual(ancestorsOf('nothing known', knowledge, 2), []);
});

test('a wider funnel puts neighbours in the same room', () => {
  // The problem it exists for: a catalogue finer-grained than the community is
  // large. Two people one subject apart share nothing at all, which is true of
  // their subjects and false of them.
  const w = seed(new World());
  for (const s of ['entomology', 'mycology', 'topology']) w.addSubject(s);

  const ants = w.addUser('ants');
  const fungi = w.addUser('fungi');
  const shapes = w.addUser('shapes');
  for (const id of [ants, fungi, shapes]) w.setFunnel(id, 1);

  w.join(ants, 'entomology');
  w.join(fungi, 'mycology');
  w.join(shapes, 'topology');

  assert.deepEqual([...w.subscription(ants)].sort(), ['biology', 'entomology']);
  assert.deepEqual(w.audienceFor(['biology']).sort(), [ants, fungi].sort());
  assert.ok(!w.audienceFor(['biology']).includes(shapes), 'and not the whole world');

  // Their own rooms are untouched: widening adds, it does not replace.
  assert.deepEqual(w.audienceFor(['entomology']), [ants]);
});

test('a narrow funnel stays narrow', () => {
  const w = seed(new World());
  w.addSubject('entomology');
  const someone = w.addUser('someone');

  w.join(someone, 'entomology'); // reach defaults to 0
  assert.deepEqual([...w.subscription(someone)], ['entomology']);
  assert.equal(w.funnel(someone), 0);
});

test('the field is created if the catalogue has not got it yet', () => {
  // A funnel that quietly does nothing whenever the broader room happens to be
  // missing is worse than no funnel.
  const w = new World();
  w.addSubject('entomology');
  const someone = w.addUser('someone');
  w.setFunnel(someone, 2);
  w.join(someone, 'entomology');

  assert.ok(w.subjects.has('biology'));
  assert.ok(w.subjects.has('natural sciences'));
  assert.deepEqual([...w.subscription(someone)].sort(), ['biology', 'entomology', 'natural sciences']);
});

test('widening never breaks the subscription cap', () => {
  const w = new World();
  const someone = w.addUser('someone');
  w.setFunnel(someone, 2);
  for (const s of subfields(knowledge).slice(0, 40)) w.addSubject(s);

  assert.doesNotThrow(() => {
    for (const s of subfields(knowledge).slice(0, 40)) {
      try {
        w.join(someone, s);
      } catch {
        break; // the cap refuses the direct join, which is the point
      }
    }
  });
  assert.ok(w.subscription(someone).size <= 32, `${w.subscription(someone).size} subjects held`);
});

test('the funnel setting is clamped and remembered', () => {
  const w = seed(new World());
  const someone = w.addUser('someone');

  assert.equal(w.setFunnel(someone, 1), 1);
  assert.equal(w.funnel(someone), 1);
  assert.equal(w.setFunnel(someone, 99), 2, 'clamped');
  assert.equal(w.setFunnel(someone, -5), 0, 'clamped');
  assert.equal(w.setFunnel('nobody', 1), 0, 'an unknown person is not an error');
});

test('hobbies are on the map alongside the fields', () => {
  // A catalogue that only admits scholarship has nothing for somebody who came
  // for bread and bicycles.
  const leaves = subfields(knowledge);
  for (const hobby of ['baking', 'chess', 'gardening', 'knitting', 'kayaking', 'guitar']) {
    assert.ok(leaves.includes(hobby), `${hobby} should be joinable`);
    assert.equal(ancestorsOf(hobby, knowledge, 2).at(-1), 'hobbies');
  }

  // And they are the larger half, which is right for a room full of people
  // rather than a prospectus.
  const underHobbies = leaves.filter((l) => ancestorsOf(l, knowledge, 3).includes('hobbies'));
  assert.ok(underHobbies.length > 60, `${underHobbies.length} hobbies`);
});
