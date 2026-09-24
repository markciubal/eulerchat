import test from 'node:test';
import assert from 'node:assert/strict';
import { inBytes, statistics } from '../public/stats.js';

/** What a page has in hand after a while: a catalogue, a map, and its own storage. */
const seen = (over = {}) => ({
  chart: {
    shape: 'c3d4',
    subjects: [
      { id: 'art', n: 40, a: 0.5 },
      { id: 'philosophy', n: 25 },
      { id: 'music', n: 12, a: 1 },
      { id: 'nobody here', n: 0 },
    ],
    links: [['art', 'philosophy', 9, 0.3]],
    communities: [{ name: ['art', 'philosophy'], size: 2, near: [] }],
  },
  atlas: {
    shape: 'a1b2',
    rooms: [
      { key: 'art', subjects: ['art'], population: 40, member: true, messages: 12, activity: 0.5 },
      { key: 'philosophy', subjects: ['philosophy'], population: 25, member: false, messages: 3, activity: 0.1 },
      { key: 'art+philosophy', subjects: ['art', 'philosophy'], population: 9, member: true, messages: 5, activity: 1 },
      // Beside the map rather than on it, and not counted as drawn.
      { key: 'chess', subjects: ['chess'], population: 7, member: true, messages: 0, activity: 0, offMap: true },
    ],
  },
  lurkers: { art: 2, philosophy: 1 },
  storage: [
    ['eulerchat.name', 'wren'],
    ['eulerchat.kept', 'x'.repeat(500)],
  ],
  subscription: ['art', 'art+philosophy'],
  ...over,
});

const value = (rows, label) => rows.find((row) => row.label === label)?.value;
const note = (rows, label) => rows.find((row) => row.label === label)?.note;

test('the catalogue is counted, and holdings are not called people', () => {
  const { rows, log } = statistics(seen());
  assert.equal(value(rows, 'Interests in the catalogue'), '4');
  assert.equal(value(rows, 'Interests anybody holds'), '3');
  // 40 + 25 + 12 + 0, and said to be what it is.
  assert.equal(value(rows, 'Holdings, added up'), '77');
  assert.match(note(rows, 'Holdings, added up'), /not a population/);
  assert.equal(value(rows, 'Most held'), 'art');
  assert.equal(value(rows, 'Liveliest interest'), 'music');
  assert.equal(value(rows, 'Communities'), '1');
  assert.equal(value(rows, 'Pairs held together'), '1');
  assert.ok(log.some((line) => line.includes('holdings added up: 77 = sum of each interest’s holders') || line.includes('holdings added up: 77')));
});

test('the map is counted as drawn, and the average is shown as its own division', () => {
  const { rows, log } = statistics(seen());
  assert.equal(value(rows, 'Chats on this map'), '3', 'the one beside the map is not on it');
  assert.equal(note(rows, 'Chats on this map'), '2 of them yours');
  assert.equal(value(rows, 'People in them, added up'), '74');
  assert.equal(value(rows, 'Average people per chat'), '24.7');
  assert.equal(note(rows, 'Average people per chat'), '74 ÷ 3');
  assert.equal(value(rows, 'Busiest chat'), 'art');
  assert.equal(value(rows, 'Liveliest chat'), 'art + philosophy');
  assert.equal(value(rows, 'Messages held here'), '20');
  assert.equal(value(rows, 'Lurking in them'), '3');
  assert.equal(value(rows, 'Interests you hold'), '2');
  assert.ok(log.some((line) => line.includes('74 ÷ 3 = 24.7')), log.join('\n'));
});

test('this browser’s own disk is counted, in the bytes a browser uses', () => {
  const { rows } = statistics(seen());
  // Two bytes a character, keys included: (14 + 4 + 13 + 500) × 2.
  assert.equal(value(rows, 'Kept on this device'), '1.1 kB');
  assert.equal(value(rows, 'Largest of them'), 'eulerchat.kept');
  assert.equal(inBytes(999), '999 B');
  assert.equal(inBytes(1500), '1.5 kB');
  assert.equal(inBytes(2_500_000), '2.50 MB');
});

test('what a page cannot see is said rather than guessed', () => {
  const { rows, log, missing } = statistics({ storage: [] });
  assert.equal(value(rows, 'Interests in the catalogue'), undefined, 'nothing invented');
  assert.equal(value(rows, 'Chats on this map'), undefined);
  assert.equal(missing.length, 2, 'and both are named');
  assert.ok(missing.some((m) => m.includes('All interests')));
  assert.ok(log.some((line) => line.includes('not fetched yet')));
  assert.ok(log.some((line) => line.includes('not visible from here')));
  assert.ok(
    log.some((line) => line.includes('server')) && log.some((line) => line.includes('how many people there are')),
    'the server’s disk and the population are named as unknowable from here',
  );
});

test('a branch is counted as the map in front of you, since that is what is drawn', () => {
  const branch = {
    shape: 'b0b0',
    rooms: [
      { key: 'kayaking', subjects: ['kayaking'], population: 30, member: false, messages: 2, activity: 0.2 },
      { key: 'climbing', subjects: ['climbing'], population: 10, member: false, messages: 0, activity: 0 },
    ],
  };
  const { rows } = statistics({ ...seen(), branch });
  assert.equal(value(rows, 'Chats on this map'), '2');
  assert.equal(value(rows, 'People in them, added up'), '40');
  assert.equal(value(rows, 'Busiest chat'), 'kayaking');
});
