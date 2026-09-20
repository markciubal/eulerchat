import test from 'node:test';
import assert from 'node:assert/strict';
import { abbreviate, shortLabels } from '../lib/abbrev.js';

test('a subject is shortened only as far as it stays unambiguous', () => {
  // The rule, by example: `p` is enough for philosophy because nothing else
  // starts with it, while `m` is not enough for either music or math.
  const labels = shortLabels(['music', 'philosophy', 'math']);
  assert.equal(labels.get('music'), 'mu');
  assert.equal(labels.get('philosophy'), 'p');
  assert.equal(labels.get('math'), 'ma');

  assert.equal(abbreviate(['music', 'philosophy', 'math'], labels), 'mu + p + ma');
});

test('adding a subject can lengthen another label, which is the point', () => {
  // A label's job is to be unmistakable among what is on screen, so it depends
  // on the set and must be recomputed per view rather than cached per subject.
  const before = shortLabels(['music', 'math']);
  const after = shortLabels(['music', 'math', 'mathematics']);

  assert.equal(before.get('math'), 'ma');
  assert.equal(after.get('math'), 'math');
  assert.equal(after.get('mathematics'), 'mathe');
  assert.equal(after.get('music'), 'mu');
});

test('a phrase becomes its initials rather than a prefix of its first word', () => {
  const labels = shortLabels(['amateur running', 'amateur go', 'art']);
  assert.equal(labels.get('amateur running'), 'ar');
  assert.equal(labels.get('amateur go'), 'ag');
  assert.equal(labels.get('art'), 'a');
});

test('every label in a set is distinct', () => {
  const hard = [
    'painting', 'philosophy', 'piano', 'poetry', 'photography',
    'physics', 'physiology', 'p',
  ];
  const labels = shortLabels(hard);
  assert.equal(new Set(labels.values()).size, hard.length);
  for (const name of hard) assert.ok(labels.get(name).length > 0);
});

test('identical prefixes fall back to the whole name', () => {
  // One name being a prefix of another is the case that cannot be resolved by
  // shortening, so it has to end at the full name rather than loop.
  const labels = shortLabels(['art', 'art history']);
  assert.notEqual(labels.get('art'), labels.get('art history'));
});

test('the odd cases do not throw', () => {
  assert.doesNotThrow(() => shortLabels([]));
  assert.doesNotThrow(() => shortLabels(['']));
  assert.equal(shortLabels(['solo']).get('solo'), 's');
  // Duplicates collapse rather than colliding with themselves forever.
  assert.equal(shortLabels(['music', 'music']).get('music'), 'm');
});
