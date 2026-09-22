import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { EMBLEMS, EMBLEM_SIZE, emblem, emblemOf } from '../lib/emblem.js';
import { glyphOf, phaseOf } from '../lib/glyph.js';
import { knowledge } from '../lib/knowledge.js';
import { definePattern, glyphSwatch, hasPattern } from '../public/glyphs.js';

/**
 * The emblems, and the promise that made them allowable.
 *
 * A table of drawings was ruled out once because it cannot answer for a name
 * nobody has drawn. What lets it back in is that it does not have to: the
 * table covers a closed layer of the hierarchy, everything beneath inherits,
 * and everything outside falls through to a pattern. Each of those three is a
 * claim, and a claim about a table somebody maintains by hand is exactly the
 * kind that goes quietly false — a field added to `knowledge.js` with nothing
 * drawn for it breaks nothing and is simply bare. So they are checked here.
 */

const divisions = Object.keys(knowledge).filter((name) => knowledge[name] === 'knowledge');
const fields = Object.keys(knowledge).filter((name) => divisions.includes(knowledge[name]));

test('every division and every field has been drawn', () => {
  for (const name of [...divisions, ...fields]) {
    assert.ok(EMBLEMS[name], `nothing drawn for ${name}`);
  }
  // And nothing is drawn for a name the hierarchy has dropped or respelled,
  // which is how a table like this collects dead entries.
  for (const name of Object.keys(EMBLEMS)) {
    assert.ok(name in knowledge, `${name} is drawn but is not in the hierarchy`);
  }
});

test('a subject wears the emblem of the field it sits in', () => {
  for (const [name, parent] of Object.entries(knowledge)) {
    const worn = emblemOf(name);
    assert.ok(worn, `${name} wears nothing`);
    if (EMBLEMS[name]) {
      assert.equal(worn, name);
      continue;
    }
    // Nothing of its own, so it wears the nearest thing above it that is
    // drawn. For most that is the field directly above; `roguelikes` sits
    // under `video games`, which is an interest and not a field, and so wears
    // what `video games` wears.
    let field = parent;
    while (field && !EMBLEMS[field]) field = knowledge[field];
    assert.equal(worn, field, `${name} is under ${parent} and wears ${worn}`);
  }

  assert.equal(emblemOf('roguelikes'), 'games');
  assert.equal(emblemOf('film photography'), 'visual art');
  assert.equal(emblemOf('fantasy football'), 'team sports');
});

test('a name that became a real category wears its own drawing, not an old alias', () => {
  // `sport` used to be another word for `movement`, and an alias is looked up
  // before the hierarchy is — so a division added later would have gone on
  // wearing somebody else's emblem, with nothing anywhere saying so.
  for (const name of ['sport', 'programming', 'languages', 'technology']) {
    assert.equal(emblemOf(name), name);
  }
  assert.equal(emblemOf('politics'), 'current affairs');
  // And the everyday words still land somewhere sensible.
  assert.equal(emblemOf('sports'), 'sport');
  assert.equal(emblemOf('coding'), 'programming');
  assert.equal(emblemOf('tv'), 'television');
});

test('the names people actually type find the right drawing', () => {
  // The three the demo opens with, none of which is the catalogue's word.
  assert.equal(emblemOf('art'), 'visual art');
  assert.equal(emblemOf('philosophy'), 'philosophy');
  assert.equal(emblemOf('math'), 'mathematics');
  assert.equal(emblemOf('music'), 'music');

  // Case and spacing are not a different subject.
  assert.equal(emblemOf('  Philosophy '), 'philosophy');
  assert.equal(emblemOf('Computer   Science'), 'computer science');

  // A facet on a subject the hierarchy knows lands where that subject is.
  assert.equal(emblemOf('modern painting'), 'visual art');
  assert.equal(emblemOf('history of jazz'), 'music');
  // But the whole name wins when the whole name is known: this is a kind of
  // history, not a kind of art.
  assert.equal(emblemOf('art history'), 'history');

  // A group's copy of a subject is that subject.
  assert.equal(emblemOf('kite-fox-9/art'), 'visual art');
  assert.equal(emblemOf('kite-fox-9/entomology'), 'biology');
});

test('a name the hierarchy cannot place wears no emblem, and still wears something', () => {
  const { document } = parseHTML('<!doctype html><html><body></body></html>');

  for (const name of ['topic 17', 'portal-w4qkz81', 'kite-fox-9/topic 3', 'zzyzx', '', null]) {
    assert.equal(emblemOf(name), null, `${name} wears ${emblemOf(name)}`);
    assert.equal(emblem(name), null);
    // The swatch is drawn regardless; what changes is what is on it.
    const swatch = glyphSwatch(document, name);
    assert.equal(swatch.querySelector('g[transform]'), null, `${name} was given an emblem`);
  }

  // Falling through means falling through to the pattern, not to nothing.
  const textured = ['topic 1', 'topic 2', 'topic 3', 'topic 4', 'topic 5', 'topic 6']
    .filter((name) => glyphOf(name).family !== 'plain');
  assert.ok(textured.length > 0);
  for (const name of textured) {
    assert.ok(hasPattern(name));
    assert.ok(glyphSwatch(document, name).querySelector('g[opacity]').childNodes.length > 0);
  }
});

test('a hierarchy of somebody else\'s, cycle and all, does not hang', () => {
  const theirs = { a: 'b', b: 'c', c: 'a', sonnets: 'literature' };
  assert.equal(emblemOf('a', theirs), null);
  assert.equal(emblemOf('sonnets', theirs), 'literature');
});

test('every alias ends at something drawn', async () => {
  // Read from the source, since the table is not exported and should not be.
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../lib/emblem.js', import.meta.url), 'utf8');
  const table = source.slice(source.indexOf('const ALIASES = {'), source.indexOf('};', source.indexOf('const ALIASES = {')));
  const names = [...table.matchAll(/^\s+'?([a-z0-9 ]+)'?:\s+'([a-z ]+)',$/gm)];
  assert.ok(names.length > 10, `found only ${names.length} aliases`);
  for (const [, alias, target] of names) {
    assert.ok(EMBLEMS[target], `${alias} points at ${target}, which is not drawn`);
    assert.equal(emblemOf(alias), target);
  }
});

test('an emblem is geometry, and only geometry', () => {
  // Drawn, not loaded. A shape here is one of four kinds with numbers in it,
  // and a path is numbers and the commands that join them — no reference to
  // anything outside the file is expressible.
  const allowed = new Set(['line', 'circle', 'rect', 'path']);
  for (const [name, shapes] of Object.entries(EMBLEMS)) {
    assert.ok(shapes.length > 0 && shapes.length <= 8, `${name}: ${shapes.length} shapes`);
    for (const shape of shapes) {
      assert.ok(allowed.has(shape.shape), `${name} drew a ${shape.shape}`);
      for (const [key, value] of Object.entries(shape)) {
        if (key === 'shape') continue;
        if (key === 'hollow' || key === 'solid') {
          assert.equal(value, true);
          continue;
        }
        if (key === 'd') {
          assert.match(value, /^[MLHVCAZmlhvcaz0-9 .-]+$/, `${name} path: ${value}`);
          continue;
        }
        assert.ok(Number.isFinite(value), `${name}.${key} is ${value}`);
      }
      // Something stroked has to say how heavily.
      if (shape.hollow || (shape.shape === 'path' && !shape.solid)) {
        assert.ok(shape.width >= 1 && shape.width <= 3, `${name}: stroke of ${shape.width}`);
      }
      // Whatever has plain coordinates stays on the square.
      if (shape.shape === 'circle') {
        assert.ok(shape.cx - shape.r >= 0 && shape.cx + shape.r <= EMBLEM_SIZE, `${name} circle leaves the square`);
        assert.ok(shape.cy - shape.r >= 0 && shape.cy + shape.r <= EMBLEM_SIZE, `${name} circle leaves the square`);
      }
      if (shape.shape === 'rect') {
        assert.ok(shape.x >= 0 && shape.x + shape.w <= EMBLEM_SIZE, `${name} rect leaves the square`);
        assert.ok(shape.y >= 0 && shape.y + shape.h <= EMBLEM_SIZE, `${name} rect leaves the square`);
      }
    }
  }
});

test('no two fields have been given the same drawing', () => {
  const seen = new Map();
  for (const [name, shapes] of Object.entries(EMBLEMS)) {
    const drawing = JSON.stringify(shapes);
    assert.ok(!seen.has(drawing), `${name} and ${seen.get(drawing)} are the same drawing`);
    seen.set(drawing, name);
  }
});

test('the rail and the map draw the same emblem', () => {
  const { document } = parseHTML('<!doctype html><html><body></body></html>');
  const NS = 'http://www.w3.org/2000/svg';

  const swatch = glyphSwatch(document, 'ethics');
  const worn = swatch.querySelector('g[transform]');
  assert.ok(worn, 'ethics has no emblem on its swatch');
  assert.equal(worn.childNodes.length, EMBLEMS.philosophy.length);
  // White at full strength: an emblem is there to be read.
  assert.equal(worn.getAttribute('opacity'), null);

  const defs = document.createElementNS(NS, 'defs');
  const id = definePattern(document, defs, 'ethics');
  const pattern = defs.querySelector(`#${id}`);
  const sown = pattern.querySelectorAll('g[transform]');
  assert.equal(sown.length, 2, 'two to a tile, the second half a step across and down');
  for (const each of sown) assert.equal(each.childNodes.length, EMBLEMS.philosophy.length);

  // Asked twice, defined once.
  assert.equal(definePattern(document, defs, 'ethics'), id);
  assert.equal(defs.childNodes.length, 1);
});

test('two subjects under one field do not land their emblems on each other', () => {
  // Every subfield of biology is sown with the same helix. Where two of them
  // overlap at the same spacing and the same start, each mark sits exactly on
  // its twin and the room between them looks like either one alone.
  const siblings = Object.keys(knowledge).filter((name) => knowledge[name] === 'biology');
  const starts = new Set(
    siblings.map((name) => `${glyphOf(name).dense}/${phaseOf(name).x}/${phaseOf(name).y}`),
  );
  assert.ok(starts.size >= siblings.length - 2, `${starts.size} distinct sowings among ${siblings.length}`);

  for (const name of siblings) {
    const { x, y } = phaseOf(name);
    assert.ok(x >= 0 && x < 1 && y >= 0 && y < 1);
    assert.deepEqual(phaseOf(name), phaseOf(name));
  }
});
