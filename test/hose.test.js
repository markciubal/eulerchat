import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { KEEP, mountHose } from '../public/hose.js';

/** A page with the hose on it, and a note of where each press went. */
function page() {
  const { document } = parseHTML(`<!doctype html><html><body>
    <dialog id="hose">
      <span id="hose-held" hidden></span>
      <button id="hose-pause" aria-pressed="false">Pause</button>
      <button id="hose-close">Close</button>
      <ul id="hose-list"></ul>
      <p id="hose-none"></p>
    </dialog>
  </body></html>`);
  const went = [];
  const hose = mountHose(document, {
    subjectsOf: (key) => String(key).split('+'),
    swatch: (doc, subject) => {
      const mark = doc.createElement('span');
      mark.className = 'glyph';
      mark.dataset.subject = subject;
      return mark;
    },
    open: (key) => went.push(['open', key]),
    jump: (key, id) => went.push(['jump', key, id]),
    hidden: (message) => message.body === 'hidden',
  });
  const press = (node) => node.dispatchEvent(new document.defaultView.Event('click', { bubbles: true }));
  return { document, hose, went, press };
}

const said = (over = {}) => ({ id: 'm1', room: 'art', author: 'wren', body: 'a thought', at: 1_700_000_000_000, ...over });
const lines = (document) => [...document.querySelectorAll('.hose-line')];

test('it streams what arrives, newest first, wearing each chat’s own swatches', () => {
  const { document, hose } = page();
  hose.open();
  hose.add(said({ id: 'm1', room: 'art', body: 'first' }), 'art');
  hose.add(said({ id: 'm2', room: 'art+philosophy', body: 'second' }), 'art+philosophy');

  const rows = lines(document);
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /second/, 'newest at the top');
  assert.match(rows[1].textContent, /first/);
  // The swatches are the chat's interests, one square each.
  assert.deepEqual(
    [...rows[0].querySelectorAll('.glyph')].map((mark) => mark.dataset.subject),
    ['art', 'philosophy'],
  );
  assert.equal(rows[0].querySelector('.hose-where').textContent, 'art + philosophy');
  assert.equal(rows[0].querySelector('.hose-who').textContent, 'wren');
  assert.equal(document.getElementById('hose-none').hidden, true);
});

test('a line leads to the chat, or to the message itself', () => {
  const { document, hose, went, press } = page();
  hose.open();
  hose.add(said({ id: 'm7', room: 'art', body: 'about this' }), 'art');
  const row = lines(document)[0];

  press([...row.querySelectorAll('button')].find((b) => b.textContent === 'View context'));
  assert.deepEqual(went.at(-1), ['open', 'art']);
  assert.equal(hose.isOpen, false, 'and gets out of the way');

  hose.open();
  press([...lines(document)[0].querySelectorAll('button')].find((b) => b.textContent === 'Jump'));
  assert.deepEqual(went.at(-1), ['jump', 'art', 'm7']);
  assert.equal(hose.isOpen, false);
});

test('what a chat does not show, the hose does not show either', () => {
  const { document, hose } = page();
  hose.open();
  hose.add(said({ id: 'm1', body: 'hidden' }), 'art');
  assert.equal(lines(document).length, 0, 'nothing there');
  assert.equal(document.getElementById('hose-none').hidden, false);
  hose.add(said({ id: 'm2', body: 'shown' }), 'art');
  assert.equal(lines(document).length, 1);
  // The same message twice is one line: history and the live frame overlap.
  hose.add(said({ id: 'm2', body: 'shown' }), 'art');
  assert.equal(lines(document).length, 1);
});

test('an encrypted message says so rather than showing an envelope', () => {
  const { document, hose } = page();
  hose.open();
  hose.add(said({ id: 'm1', sealed: true, body: '' }), 'art');
  const body = document.querySelector('.hose-said');
  assert.ok(body.classList.contains('sealed'));
  assert.match(body.textContent, /Encrypted\. Open the chat to read it\./);
});

test('a system message is labelled as one, here as everywhere', () => {
  const { document, hose } = page();
  hose.open();
  hose.add(said({ id: 'm1', machine: true, body: 'What got you into art?' }), 'art');
  assert.equal(document.querySelector('.hose-tag').textContent, 'system message');
});

test('paused, it holds what arrives and says how much', () => {
  const { document, hose, press } = page();
  hose.open();
  hose.add(said({ id: 'm1', body: 'before' }), 'art');
  press(document.getElementById('hose-pause'));
  assert.equal(document.getElementById('hose-pause').getAttribute('aria-pressed'), 'true');

  hose.add(said({ id: 'm2', body: 'during' }), 'art');
  hose.add(said({ id: 'm3', body: 'during too' }), 'art');
  assert.equal(lines(document).length, 1, 'the line under the pointer stays put');
  assert.equal(document.getElementById('hose-held').textContent, '2 more while paused');

  press(document.getElementById('hose-pause'));
  assert.equal(document.getElementById('hose-held').hidden, true);
  hose.add(said({ id: 'm4', body: 'after' }), 'art');
  assert.equal(lines(document).length, 2, 'and it runs again');
});

test('it keeps the last of it, not all of it', () => {
  const { document, hose } = page();
  hose.open();
  for (let i = 0; i < KEEP + 20; i++) hose.add(said({ id: `m${i}`, body: `number ${i}` }), 'art');
  assert.equal(hose.lines, KEEP);
  assert.equal(lines(document).length, KEEP);
  assert.match(lines(document)[0].textContent, new RegExp(`number ${KEEP + 19}`), 'the newest is still on top');
});
