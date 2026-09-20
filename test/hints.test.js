import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseHTML } from 'linkedom';
import { HELP, attachHelp, busyness, createCard, when } from '../public/hints.js';
import { World, seed } from '../server/store.js';

const page = () => parseHTML(fs.readFileSync('public/index.html', 'utf8'));

test('nothing is explained in words that need explaining', () => {
  // A non-technical reader stopped at every one of these. An explanation
  // written in the vocabulary of the thing being explained is not one.
  const jargon = /\b(region|arity|census|euler|node|render|taxonomy|zone|patch|phantom|lune|topolog)/i;
  for (const [key, entry] of Object.entries(HELP)) {
    assert.ok(entry.title && entry.short, `${key} needs a title and a sentence`);
    assert.ok(!jargon.test(entry.short), `${key}: "${entry.short}"`);
    if (entry.more) assert.ok(!jargon.test(entry.more), `${key} (more)`);
    assert.ok(!entry.short.includes('∩'), `${key} uses a symbol nobody recognises`);
  }
});

test('every control that needs explaining has an (i)', () => {
  const { document } = page();
  const asked = [...document.querySelectorAll('[data-help]')].map((n) => n.dataset.help);

  assert.ok(asked.length >= 8, `only ${asked.length} controls offer help`);
  for (const key of asked) assert.ok(HELP[key], `no help written for "${key}"`);

  attachHelp(document);
  assert.equal(document.querySelectorAll('.info').length, asked.length);
});

test('help opens, and offers the longer version behind a second click', () => {
  const { document } = page();
  const card = createCard(document);
  const near = { getBoundingClientRect: () => ({ left: 10, bottom: 20, right: 40, top: 10 }) };

  card.explain('funnel', near);
  assert.equal(card.element.hidden, false);
  assert.match(card.element.textContent, /somewhere broader/, 'the short answer first');

  const more = card.element.querySelector('.more');
  assert.ok(more, 'there should be a way to ask for more');
  more.dispatchEvent(new document.defaultView.Event('click'));
  // The longer one is worked through an example rather than defined.
  assert.match(card.element.textContent, /Roman archaeology/);
  assert.match(card.element.textContent, /medieval archaeology/);
  assert.equal(card.element.querySelector('.more'), null, 'and the button is spent');

  // An opened explanation stays put until it is dismissed.
  card.hide();
  assert.equal(card.element.hidden, false);
  card.hide(true);
  assert.equal(card.element.hidden, true);
});

test('hovering a conversation says whether it is worth going into', () => {
  // A count alone does not settle it: forty people who last spoke in March is
  // a different room from four who are talking now.
  const world = seed(new World());
  const someone = world.addUser('wren');
  world.join(someone, 'art');
  world.post(someone, ['art'], 'is anyone else underpainting today');

  const room = world.diagramFor(someone).rooms.find((r) => r.key === 'art');
  const { document } = page();
  const card = createCard(document);
  card.room(room, { getBoundingClientRect: () => ({ left: 0, bottom: 0, right: 0, top: 0 }) });

  const text = card.element.textContent;
  assert.match(text, /people/);
  assert.match(text, /you are in this one/);
  assert.match(text, /underpainting/, 'the last thing said');
  assert.match(text, /just now|min ago/, 'and when');
});

test('busyness and time are said in words, not numbers', () => {
  assert.equal(busyness(null), 'nothing said here yet');
  assert.equal(busyness({ messages: 0 }), 'nothing said here yet');
  assert.equal(busyness({ messages: 9, perMinute: 0 }), 'quiet at the moment');
  assert.equal(busyness({ messages: 9, perMinute: 0.4 }), 'someone is talking');
  assert.equal(busyness({ messages: 9, perMinute: 5 }), 'very busy right now');

  assert.equal(when(Date.now()), 'just now');
  assert.match(when(Date.now() - 20 * 60_000), /min ago/);
  assert.match(when(Date.now() - 5 * 3600_000), /hours ago/);
  assert.equal(when(null), '');
});

test('a room reports how busy it is and what was said last', () => {
  const world = seed(new World());
  const a = world.addUser('ana');
  world.join(a, 'art');
  for (let i = 0; i < 3; i++) world.post(a, ['art'], `message ${i}`);

  const stats = world.stats('art');
  assert.ok(stats.messages >= 3);
  assert.ok(stats.perMinute > 0);
  assert.equal(stats.last.author, 'ana');
  assert.equal(stats.last.body, 'message 2');

  assert.deepEqual(world.stats('nothing here'), { messages: 0, perMinute: 0, last: null });
});

test('the page says what it is, where somebody looks first', () => {
  const { document } = page();
  const lede = document.getElementById('lede');
  assert.ok(lede, 'there should be an opening instruction');
  assert.match(lede.textContent, /interested in/);
  assert.match(lede.textContent, /conversation/);

  // And it sits above the drawing rather than across the page from it.
  const main = document.querySelector('.map').innerHTML;
  assert.ok(main.indexOf('id="lede"') < main.indexOf('id="diagram"'));
});
