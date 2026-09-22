import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { alsoCalled, childrenOf, knowledge, subfields } from '../lib/knowledge.js';
import { World, seed, stock } from '../server/store.js';

/**
 * The catalogue a fresh install opens with.
 *
 * It is a list eleven hundred names long that somebody maintains by hand, and
 * every way such a list goes wrong is silent: a name written twice is simply
 * one name, a parent misspelled is simply a new root, a name the server would
 * refuse is simply missing on the day. So each of those is checked here.
 */

const source = fs.readFileSync(new URL('../lib/knowledge.js', import.meta.url), 'utf8');

/** The keys of one object literal, as written, duplicates and all. */
function written(name) {
  const start = source.indexOf(`export const ${name} = {`);
  assert.ok(start > -1, `${name} is not where it was`);
  const body = source.slice(start, source.indexOf('\n};', start));
  return [...body.matchAll(/^\s+(?:'([^']+)'|([a-z0-9]+)):\s*'/gm)].map((m) => m[1] ?? m[2]);
}

test('no name is written twice', () => {
  // An object literal keeps the last of two equal keys and says nothing, so
  // `drones` under tinkering and again under technology would quietly move it.
  for (const which of ['knowledge', 'alsoCalled']) {
    const keys = written(which);
    const twice = keys.filter((key, i) => keys.indexOf(key) !== i);
    assert.deepEqual(twice, [], `${which} repeats ${twice.join(', ')}`);
  }
  assert.equal(written('knowledge').length, Object.keys(knowledge).length);
});

test('every name is one the server will accept, under a parent that exists', () => {
  for (const [name, parent] of Object.entries(knowledge)) {
    assert.match(name, /^[a-z0-9][a-z0-9 -]{0,30}$/, `"${name}" is not a usable subject name`);
    assert.ok(parent === 'knowledge' || parent in knowledge, `${name} is under ${parent}, which is nowhere`);
  }
  // And nothing is its own ancestor.
  for (const name of Object.keys(knowledge)) {
    const seen = new Set();
    for (let at = name; at in knowledge; at = knowledge[at]) {
      assert.ok(!seen.has(at), `${name} is inside itself`);
      seen.add(at);
    }
  }
});

test('it is big enough to find yourself in, and sorted into a dozen places to look', () => {
  const divisions = childrenOf().get('knowledge');
  assert.equal(divisions.length, 12, divisions.join(', '));
  assert.ok(Object.keys(knowledge).length > 1000, `${Object.keys(knowledge).length} names`);
  assert.ok(subfields().length > 900);

  // Nothing is a drawer nobody could read to the bottom of.
  for (const [parent, kids] of childrenOf()) {
    if (parent === 'knowledge') continue;
    assert.ok(kids.length <= 45, `${parent} holds ${kids.length}, which is a list and not a category`);
  }
});

test('the obvious, the niche and the modern are all there', () => {
  const has = (name) => assert.ok(name in knowledge, `${name} is missing`);
  // What anybody would look for first.
  for (const name of ['football', 'cooking', 'dogs', 'television', 'parenting', 'personal finance', 'travel', 'rock', 'python', 'spanish']) has(name);
  // What people cannot find a room for elsewhere.
  for (const name of ['fountain pens', 'lockpicking', 'narrowboats', 'roguelikes', 'speedcubing', 'conlangs', 'raw denim', 'mead making']) has(name);
  // What a catalogue nobody had looked at in ten years would not have.
  for (const name of ['large language models', 'pickleball', 'heat pumps', 'fediverse', 'e-bikes', 'vtubers', 'four-day week', 'sim racing']) has(name);
});

test('an interest big enough to have interests of its own holds them', () => {
  assert.equal(knowledge['film photography'], 'photography');
  assert.equal(knowledge.roguelikes, 'video games');
  assert.equal(knowledge.espresso, 'coffee');
  assert.equal(knowledge['fantasy football'], 'football');
  // And the one above is still a room, not only a heading.
  const world = stock(new World());
  for (const name of ['photography', 'video games', 'coffee', 'football']) assert.ok(world.subjects.has(name));
});

test('another name for something points at something', () => {
  for (const [word, name] of Object.entries(alsoCalled)) {
    assert.ok(name in knowledge, `${word} means ${name}, which is not here`);
    assert.ok(!(word in knowledge), `${word} is already a name, so it cannot also mean ${name}`);
    assert.equal(word, word.toLowerCase());
  }
});

// --- stocking ------------------------------------------------------------------

test('a fresh install has the whole catalogue, and nobody in most of it', () => {
  const bare = stock(new World());
  assert.equal(bare.subjects.size, Object.keys(knowledge).length);
  assert.equal(bare.profiles.size, 0, 'stocking adds interests, not people');
  assert.equal(bare.index().population.size, 0);

  // Stocking twice is stocking once.
  assert.equal(stock(bare).subjects.size, Object.keys(knowledge).length);

  // The demo world is that, plus its three busy corners.
  const demo = seed(new World());
  assert.ok(demo.subjects.size > 1000);
  assert.equal(demo.index().population.size, 3, 'an empty interest takes up no room on the map');
  assert.equal(demo.overview().subjects.length, 3);
});

// --- search --------------------------------------------------------------------

test('the word somebody has in their head finds the name the catalogue uses', () => {
  const world = stock(new World());
  const first = (query) => world.searchSubjects(query)[0]?.id;

  assert.equal(first('soccer'), 'football');
  assert.equal(first('dnd'), 'dungeons and dragons');
  assert.equal(first('ai'), 'artificial intelligence');
  assert.equal(first('F1'), 'formula 1', 'however it is capitalised');
  assert.equal(first('  ping   pong '), 'table tennis', 'or spaced');

  // Half a word still gets there.
  assert.ok(world.searchSubjects('socc').some((r) => r.id === 'football'));
  // But two letters of one do not drag in everything that starts that way.
  assert.ok(!world.searchSubjects('so').some((r) => r.id === 'football'));

  // The ordinary search is untouched: letters in the name, as before.
  const found = world.searchSubjects('photography').map((r) => r.id);
  assert.ok(found.includes('photography') && found.includes('film photography'));
  assert.equal(found[0], 'photography', 'the name itself before the names that contain it');
});

test('another name only finds what this world has', () => {
  const world = new World();
  world.addSubject('tennis');
  assert.deepEqual(world.searchSubjects('soccer'), []);
});

// --- browsing ------------------------------------------------------------------

test('the catalogue is browsed a level at a time', () => {
  const world = seed(new World());

  const top = world.browse();
  assert.equal(top.at, null);
  assert.deepEqual(top.path, []);
  assert.equal(top.children.length, 12);
  const sport = top.children.find((c) => c.id === 'sport');
  assert.ok(sport.inside > 80, `${sport.inside} inside sport`);
  assert.equal(sport.sample.length, 3, 'a few of what is in it');

  const fields = world.browse('sport');
  assert.deepEqual(fields.path, ['sport']);
  assert.ok(fields.children.some((c) => c.id === 'racket sports'));

  const rackets = world.browse('racket sports');
  assert.deepEqual(rackets.path, ['sport', 'racket sports']);
  assert.deepEqual(
    rackets.children.map((c) => c.id),
    ['badminton', 'padel', 'pickleball', 'squash', 'table tennis', 'tennis'],
  );
  assert.ok(rackets.children.every((c) => c.inside === 0 && c.sample.length === 0), 'nothing beneath these');

  // A fourth level, where there is one.
  const games = world.browse('video games');
  assert.deepEqual(games.path, ['hobbies', 'games', 'video games']);
  assert.ok(games.children.some((c) => c.id === 'roguelikes'));

  // Head counts are the real ones.
  const arts = world.browse('arts');
  assert.ok(arts.children.find((c) => c.id === 'music').population > 0);
});

test('browsing somewhere that is not a category is the top, not an error', () => {
  const world = stock(new World());
  for (const at of ['no such place', '', 42, 'knowledge', '../../etc']) {
    assert.equal(world.browse(at).at, null, String(at));
    assert.equal(world.browse(at).children.length, 12);
  }
  // Tidied the way a subject name is.
  assert.equal(world.browse('  Sport ').at, 'sport');
});

test('a world that stocked its own short list is shown that list, arranged', () => {
  const world = new World();
  for (const name of ['sport', 'racket sports', 'tennis', 'padel']) world.addSubject(name);

  assert.deepEqual(world.browse().children.map((c) => c.id), ['sport']);
  assert.deepEqual(world.browse('racket sports').children.map((c) => c.id), ['padel', 'tennis']);
});
