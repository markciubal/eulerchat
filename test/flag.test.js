import test from 'node:test';
import assert from 'node:assert/strict';
import { REASONS, rank, scan, vocabulary } from '../lib/flag.js';

test('innocent words are not flagged for containing rude ones', () => {
  // The classic way to build one of these wrong. Every word here contains a
  // word from the list, and every one of them is ordinary: two are subjects
  // this place actually has channels for, and one is a town in Lincolnshire
  // whose residents have been fighting this exact bug since 1996.
  const innocent = [
    'classic', 'assassin', 'assassination', 'bass', 'mass', 'passage', 'grass',
    'Scunthorpe', 'Penistone', 'analysis', 'cockpit', 'shiitake', 'therapist',
    'arsenal', 'scrap', 'scrape', 'assess', 'embarrass', 'compass', 'harass',
    'as', 'gas', 'class', 'brass', 'glass', 'assumption', 'assign',
  ];

  for (const word of innocent) {
    const result = scan(`we were talking about ${word} yesterday`);
    assert.ok(result.clean, `"${word}" should not be flagged, got ${JSON.stringify(result.found)}`);
  }
});

test('a whole rude word is flagged', () => {
  const result = scan('what the fuck is this');
  assert.equal(result.clean, false);
  assert.equal(result.found[0].word, 'fuck');
  assert.equal(result.found[0].category, 'language');
});

test('the usual ways round it are covered', () => {
  // Substitutions and stretched vowels, which is most of what people actually
  // do. Each of these is one word once reduced.
  for (const written of ['a$$', 'sh1t', 'fuuuuck', 'FUCK', 'Sh!t', 'b1tch', 'cr@p']) {
    const result = scan(`this is ${written}`);
    assert.equal(result.clean, false, `"${written}" should be caught`);
  }
});

test('doubled letters are left alone, because "as" is a word', () => {
  // Collapsing runs of two would reduce `ass` to `as` and flag half of
  // everything anybody writes. Runs of three or more collapse; two do not.
  assert.ok(scan('as it happens').clean);
  assert.ok(scan('the pass was blocked').clean);
  assert.equal(scan('you ass').clean, false);
});

test('an operator brings their own words', () => {
  const words = { hate: ['snerg'], language: ['blort'] };
  const result = scan('you absolute snerg', { words });

  assert.equal(result.found[0].category, 'hate');
  assert.equal(result.weight, REASONS.hate.weight, 'the reason it is filed under sets its weight');
  // And the default list is replaced, not added to.
  assert.ok(scan('fuck', { words }).clean, 'their list is the list');
  assert.ok(vocabulary(words).has('blort'));
});

test('a sealed message has nothing to scan, and says so quietly', () => {
  // The server stores an empty body for these. It must come back clean rather
  // than throwing, and it must not be mistaken for evidence of good behaviour.
  assert.ok(scan('').clean);
  assert.ok(scan(null).clean);
  assert.ok(scan(undefined).clean);
});

// --- which rooms need looking at -------------------------------------------

const ago = (hours) => Date.now() - hours * 60 * 60 * 1000;
const reports = (list) => list.map(([by, reason, hours]) => ({ by, reason, at: ago(hours ?? 1) }));

test('many people reporting once beats one person reporting many times', () => {
  const ranked = rank([
    {
      room: 'many-voices',
      messages: 100,
      reports: reports([['a', 'abuse'], ['b', 'abuse'], ['c', 'abuse'], ['d', 'abuse']]),
    },
    {
      room: 'one-voice',
      messages: 100,
      // The same number of reports, all from one person. This is what a
      // grudge looks like, and it must not read the same as four people.
      reports: reports([['z', 'abuse'], ['z', 'abuse'], ['z', 'abuse'], ['z', 'abuse']]),
    },
  ]);

  assert.equal(ranked[0].room, 'many-voices');
  assert.ok(
    ranked[0].score > ranked[1].score * 1.5,
    `four people should outweigh one: ${ranked[0].score} vs ${ranked[1].score}`,
  );
  assert.match(ranked[1].why, /same person/, 'and the reason should say so plainly');
});

test('a big room is not top of the list merely for being big', () => {
  const ranked = rank([
    {
      room: 'enormous',
      messages: 20000,
      // Plenty of reports in absolute terms, and a vanishing share of traffic.
      reports: reports(Array.from({ length: 12 }, (_, i) => [`u${i}`, 'language'])),
    },
    {
      room: 'small-and-nasty',
      messages: 30,
      reports: reports([['a', 'hate'], ['b', 'abuse'], ['c', 'abuse']]),
    },
  ]);

  assert.equal(ranked[0].room, 'small-and-nasty', 'concentration, not volume');
});

test('the most serious kind of report reaches a moderator whatever the score', () => {
  // One report of hatred in a busy room scores low by concentration and must
  // still be surfaced. A ranking that buries this is worse than no ranking.
  const [only] = rank([
    { room: 'busy', messages: 5000, reports: reports([['a', 'hate']]) },
  ]);

  assert.equal(only.level, 'urgent');
  assert.equal(only.worst, 3);
  assert.match(only.why, /most serious/);
});

test('old trouble fades', () => {
  const recent = rank([{ room: 'r', messages: 50, reports: reports([['a', 'abuse', 1], ['b', 'abuse', 2]]) }]);
  const stale = rank([{ room: 'r', messages: 50, reports: reports([['a', 'abuse', 24 * 12], ['b', 'abuse', 24 * 13]]) }]);

  assert.ok(recent[0].score > stale[0].score, 'a room is not condemned by its distant past');

  // And past the window they stop counting altogether.
  const ancient = rank([{ room: 'r', messages: 50, reports: reports([['a', 'abuse', 24 * 60]]) }]);
  assert.deepEqual(ancient, []);
});

test('the word list can only ever be a hint', () => {
  // A room nobody has complained about, where the scanner is going off
  // constantly — a linguistics channel, or people quoting something. It may
  // appear, it may not lead, and it must not claim more than it knows.
  const ranked = rank([
    { room: 'quoting-things', messages: 100, flags: 100, reports: [] },
    { room: 'reported', messages: 100, reports: reports([['a', 'abuse'], ['b', 'abuse'], ['c', 'hate']]) },
  ]);

  assert.equal(ranked[0].room, 'reported', 'people outrank the word list');
  const scanned = ranked.find((r) => r.room === 'quoting-things');
  assert.ok(scanned.score <= 0.25, `the scanner is capped, got ${scanned.score}`);
  assert.match(scanned.why, /only a hint/);
});

test('a quiet room with nothing against it is not on the list at all', () => {
  assert.deepEqual(rank([{ room: 'fine', messages: 500, reports: [] }]), []);
  assert.deepEqual(rank([]), []);
  assert.deepEqual(rank(undefined), []);
});

test('every room on the list explains itself', () => {
  const ranked = rank([
    { room: 'art+music', subjects: ['art', 'music'], messages: 40, reports: reports([['a', 'abuse'], ['b', 'spam']]) },
  ]);

  const [entry] = ranked;
  assert.deepEqual(entry.subjects, ['art', 'music']);
  assert.equal(entry.reporters, 2);
  assert.equal(entry.reports, 2);
  assert.ok(entry.score > 0 && entry.score <= 1, 'scores stay comparable between rooms');
  assert.match(entry.why, /2 different people reported this 2 times/);
  // The breakdown is there so somebody can disagree with the ranking.
  assert.equal(entry.reasons.length, 2);
  assert.ok(entry.reasons.every((r) => r.says));
});
