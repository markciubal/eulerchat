import test from 'node:test';
import assert from 'node:assert/strict';
import { knowledge, subfields } from '../lib/knowledge.js';
import { normalise, radialLayout } from '../lib/taxonomy.js';
import { World } from '../server/store.js';

const at = radialLayout(knowledge);

test('a facet is not a different subject', () => {
  // `theory of entomology` and `modern entomology` are entomology. Three rooms
  // for one small community is fragmentation nobody would defend if asked.
  for (const phrasing of [
    'theory of entomology', 'modern entomology', 'field entomology',
    'applied entomology', 'ENTOMOLOGY', '  entomology  ',
  ]) {
    assert.equal(normalise(phrasing, at), 'entomology', phrasing);
  }
  assert.equal(normalise('history of jazz', at), 'jazz');
  assert.equal(normalise('modern theory of optics', at), 'optics', 'stacked facets');
});

test('stripping stops when what is left is not a subject', () => {
  // The restraint is the safety: a rule that stripped unconditionally would
  // quietly rename things nobody meant to rename.
  assert.equal(normalise('theory of everything', at), 'theory of everything');
  assert.equal(normalise('field theory', at), 'field theory');
  assert.equal(normalise('modern art', at), 'modern art', 'no bare `art` in the taxonomy');
  assert.equal(normalise('competitive yodelling', at), 'competitive yodelling');
});

test('the world stores the subject, not the phrasing', () => {
  const w = new World();
  assert.equal(w.addSubject('theory of entomology'), 'entomology');
  assert.equal(w.addSubject('Modern Entomology'), 'entomology');
  assert.equal(w.subjects.size, 1, 'one subject, however it was asked for');

  const someone = w.addUser('someone');
  w.join(someone, 'entomology');
  assert.ok(w.subscription(someone).has('entomology'));
});

test('fields hold subfields, and the subfields are what people join', () => {
  const leaves = subfields(knowledge);
  assert.ok(leaves.length > 140, `${leaves.length} joinable subjects`);

  // Real subfields under their real field.
  for (const [leaf, field] of [
    ['entomology', 'biology'],
    ['mycology', 'biology'],
    ['topology', 'mathematics'],
    ['epistemology', 'philosophy'],
    ['macroeconomics', 'economics'],
    ['cryptography', 'computer science'],
  ]) {
    assert.equal(knowledge[leaf], field, leaf);
    assert.ok(leaves.includes(leaf), `${leaf} should be joinable`);
  }

  // And a field sits under a division, which is the layer above.
  assert.equal(knowledge.biology, 'natural sciences');
  assert.equal(knowledge.mathematics, 'formal sciences');
  assert.equal(knowledge.philosophy, 'humanities');
  assert.equal(knowledge['natural sciences'], 'knowledge');
});

test('subfields of one field sit together, away from other fields', () => {
  const gap = (a, b) => Math.hypot(at.get(a).x - at.get(b).x, at.get(a).y - at.get(b).y);

  // This is what the hierarchy is for: entomology is near mycology before a
  // single person has joined either, and nowhere near topology.
  assert.ok(gap('entomology', 'mycology') < gap('entomology', 'topology'));
  assert.ok(gap('algebra', 'topology') < gap('algebra', 'baking'));
  assert.ok(gap('ethics', 'epistemology') < gap('ethics', 'oceanography'));
});
