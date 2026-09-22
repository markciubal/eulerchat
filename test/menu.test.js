import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { contextMenu } from '../public/menu.js';

/**
 * A page with a menu on it, and a note of what has the focus, which linkedom
 * does not keep: `focus()` says so instead, as the browser would.
 */
function page() {
  const { document } = parseHTML('<!doctype html><html><body><button id="opener">Open</button></body></html>');
  let active = null;
  for (const name of ['HTMLElement', 'Element', 'SVGElement']) {
    const proto = document.defaultView[name]?.prototype;
    if (proto) {
      proto.focus = function focus() {
        active = this;
      };
    }
  }
  Object.defineProperty(document, 'activeElement', { get: () => active, configurable: true });
  return { document, opener: document.getElementById('opener'), menu: contextMenu(document) };
}

const items = (document) => [...document.querySelectorAll('.menu-item')];
const labels = (document) => items(document).map((b) => b.querySelector('.menu-label').textContent);
const key = (document, k) =>
  document.activeElement.dispatchEvent(
    Object.assign(new document.defaultView.Event('keydown', { bubbles: true, cancelable: true }), { key: k }),
  );

const SECTIONS = (run = () => {}) => [
  { items: [{ label: 'Open the chat', icon: 'chat', run }] },
  {
    heading: 'Branch out',
    items: [
      { label: 'Branch out from art', detail: 'Into art, drawing and painting · 9 interests', run },
      { label: 'Nothing else yet', disabled: true },
      { label: 'Pinned to the top', checked: true, run },
    ],
  },
];

test('a menu is its sections, with the first thing in it ready to be chosen', () => {
  const { document, opener, menu } = page();
  menu.open({ x: 20, y: 30, title: 'art', sections: SECTIONS(), returnTo: opener });
  const el = document.querySelector('.context-menu');
  assert.equal(el.getAttribute('role'), 'menu');
  assert.equal(el.getAttribute('aria-label'), 'art');
  assert.equal(el.querySelector('.menu-title').textContent, 'art');
  assert.deepEqual(labels(document), ['Open the chat', 'Branch out from art', 'Nothing else yet', 'Pinned to the top']);
  assert.equal(el.querySelector('.menu-section[role="group"]').getAttribute('role'), 'group');
  assert.equal(el.querySelectorAll('.menu-heading')[0].textContent, 'Branch out');
  assert.equal(items(document)[1].querySelector('.menu-detail').textContent, 'Into art, drawing and painting · 9 interests');
  assert.equal(items(document)[2].getAttribute('aria-disabled'), 'true');
  assert.equal(items(document)[3].getAttribute('role'), 'menuitemcheckbox');
  assert.equal(items(document)[3].getAttribute('aria-checked'), 'true');
  assert.equal(document.activeElement, items(document)[0], 'the first has the focus');
  assert.equal(el.style.left, '20px');
  assert.equal(el.style.top, '30px');
});

test('the arrows go up and down it, past anything that cannot be chosen, and round', () => {
  const { document, menu } = page();
  menu.open({ x: 0, y: 0, sections: SECTIONS() });
  const at = () => labels(document)[items(document).indexOf(document.activeElement)];
  key(document, 'ArrowDown');
  assert.equal(at(), 'Branch out from art');
  key(document, 'ArrowDown');
  assert.equal(at(), 'Pinned to the top', 'what cannot be chosen is stepped over');
  key(document, 'ArrowDown');
  assert.equal(at(), 'Open the chat', 'and round to the top again');
  key(document, 'ArrowUp');
  assert.equal(at(), 'Pinned to the top');
  key(document, 'End');
  assert.equal(at(), 'Pinned to the top');
  key(document, 'Home');
  assert.equal(at(), 'Open the chat');
});

test('choosing something shuts it first, and does it after', () => {
  const { document, opener, menu } = page();
  const done = [];
  menu.open({ x: 0, y: 0, sections: SECTIONS(() => done.push(menu.isOpen)), returnTo: opener });
  items(document)[0].dispatchEvent(new document.defaultView.Event('click', { bubbles: true }));
  assert.deepEqual(done, [false], 'shut by the time it runs, so it can open something else');
  assert.equal(document.querySelector('.context-menu'), null);
  assert.equal(document.activeElement, opener, 'and the focus goes back');
});

test('nothing happens for an item that cannot be chosen', () => {
  const { document, menu } = page();
  let ran = 0;
  menu.open({ x: 0, y: 0, sections: SECTIONS(() => (ran += 1)) });
  items(document)[2].dispatchEvent(new document.defaultView.Event('click', { bubbles: true }));
  assert.equal(ran, 0);
  assert.ok(menu.isOpen, 'and it stays open');
});

test('Escape shuts it, and so does pressing anywhere else', () => {
  const { document, opener, menu } = page();
  menu.open({ x: 0, y: 0, sections: SECTIONS(), returnTo: opener });
  key(document, 'Escape');
  assert.equal(menu.isOpen, false);
  assert.equal(document.activeElement, opener);

  menu.open({ x: 0, y: 0, sections: SECTIONS(), returnTo: opener });
  document.body.dispatchEvent(new document.defaultView.Event('pointerdown', { bubbles: true }));
  assert.equal(menu.isOpen, false);
  // Opening another closes the first: there is only ever one.
  menu.open({ x: 0, y: 0, sections: SECTIONS() });
  menu.open({ x: 0, y: 0, sections: SECTIONS() });
  assert.equal(document.querySelectorAll('.context-menu').length, 1);
  menu.close();
  assert.equal(menu.isOpen, false);
});

test('a menu opened from a modal sheet goes inside it, where it can be pressed', () => {
  const { document, menu } = page();
  const sheet = document.createElement('dialog');
  document.body.append(sheet);
  menu.open({ x: 0, y: 0, sections: SECTIONS(), within: sheet });
  assert.equal(document.querySelector('.context-menu').parentElement, sheet);
});

test('a menu of nothing does not open', () => {
  const { document, menu } = page();
  menu.open({ x: 0, y: 0, sections: [{ heading: 'Branch out', items: [] }] });
  assert.equal(menu.isOpen, false);
  assert.equal(document.querySelector('.context-menu'), null);
});
