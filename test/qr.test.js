import test from 'node:test';
import assert from 'node:assert/strict';
import { qr, toText, capacity, totalCodewords, sizeOf, MAX_VERSION } from '../lib/qr.js';
import { hasPictographs } from '../lib/plain.js';

/**
 * The reference encoder, if somebody has installed it.
 *
 * `qrcode` is a well-exercised independent implementation, and comparing
 * against it module for module is the only check here that is actually worth
 * anything: every structural assertion below would still pass on a symbol that
 * no phone could read. Reed-Solomon in particular either agrees with another
 * implementation or is wrong, and there is no way to eyeball which.
 *
 * It is deliberately not a declared dependency. The library ships with two
 * runtime dependencies and having a QR encoder in devDependencies purely to
 * check the QR encoder invites the obvious question about why there are two of
 * them. So it is installed when the encoder is being worked on
 * (`npm install --no-save qrcode`) and absent the rest of the time, and these
 * tests skip rather than fail when it is missing — a test suite that goes red
 * on a clean checkout teaches people to ignore red.
 */
let QRCode = null;
try {
  QRCode = (await import('qrcode')).default;
} catch {
  QRCode = null;
}

/**
 * What the reference makes of the same text.
 *
 * Byte mode is forced. Left to itself `qrcode` inspects the text and picks the
 * tightest mode available, so an all-uppercase URL comes back as an
 * alphanumeric symbol a version smaller — correct, and a completely different
 * picture. Our encoder is byte mode by design, so the comparison has to ask
 * the reference for the same thing rather than for its best effort.
 */
const reference = (text, ec) =>
  QRCode.create([{ data: text, mode: 'byte' }], { errorCorrectionLevel: ec });

/** Every module, as a flat list of booleans, so two shapes can be compared. */
const flatten = ({ size, modules }) => {
  const out = [];
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) out.push(Boolean(modules[r][c]));
  return out;
};

/**
 * Inputs chosen to land on particular versions rather than to be realistic.
 *
 * The interesting boundaries are not the URLs, they are the version numbers:
 * version 1 has no alignment pattern, versions from 3 upward split the data
 * into several blocks and interleave them, and versions from 7 upward carry
 * version information in two extra corners. A test that only used plausible
 * cluster links would exercise versions 2 and 3 and nothing else.
 */
const CASES = [
  ['a short one', 'http://localhost:8787/?cluster=kite-fox-9'],
  ['barely anything', 'hi'],
  ['one byte', 'x'],
  ['a real origin', 'https://chat.example.org/?cluster=moss-lark-42'],
  ['uppercase, which byte mode does not shorten', 'HTTP://EXAMPLE.COM/?CLUSTER=YEW-ROOK-71'],
  ['non-ascii, so the UTF-8 byte count exceeds the character count', 'https://ex.ample/?cluster=café-naïve-12'],
  ['long enough to need several blocks', `https://chat.example.org/?cluster=silt-dune-33&${'q=1&'.repeat(20)}`],
  ['long enough to need version information', `https://chat.example.org/?cluster=birch-teal-58&${'padding=xxxxxxxx&'.repeat(9)}`],
  ['near the ceiling', 'z'.repeat(200)],
];

const LEVELS = ['L', 'M', 'Q', 'H'];

test('every module matches an independent encoder', (t) => {
  if (!QRCode) return t.skip('qrcode is not installed: run npm install --no-save qrcode');

  for (const [what, text] of CASES) {
    for (const ec of LEVELS) {
      const ref = reference(text, ec);
      if (ref.version > MAX_VERSION) continue; // Beyond what this encoder claims.

      const mine = qr(text, { ec });
      assert.equal(mine.version, ref.version, `${what} at ${ec}: version`);
      assert.equal(mine.size, ref.modules.size, `${what} at ${ec}: size`);
      assert.equal(mine.mask, ref.maskPattern, `${what} at ${ec}: chosen mask`);
      assert.deepEqual(
        flatten(mine),
        Array.from(ref.modules.data, Boolean),
        `${what} at ${ec}: modules differ`,
      );
    }
  }
});

test('versions 1 to 10 are all reached and all agree', (t) => {
  if (!QRCode) return t.skip('qrcode is not installed');

  // One input per version per level, sized to sit just under that version's
  // capacity, so that every row of the block table is actually used. Several
  // of those rows split the data unevenly between two block sizes, which is
  // the part most likely to be wrong and the part least likely to be reached
  // by a handful of sample URLs.
  const reached = new Set();

  for (const ec of LEVELS) {
    for (let version = 1; version <= MAX_VERSION; version++) {
      const text = 'u'.repeat(capacity(version, ec).bytes);
      const mine = qr(text, { ec });
      assert.equal(mine.version, version, `${text.length} bytes at ${ec} should be version ${version}`);

      const ref = reference(text, ec);
      assert.equal(ref.version, version, `reference disagrees about version for ${ec}`);
      assert.deepEqual(flatten(mine), Array.from(ref.modules.data, Boolean), `version ${version} at ${ec}`);
      reached.add(`${version}${ec}`);
    }
  }

  assert.equal(reached.size, MAX_VERSION * LEVELS.length, 'every version and level combination');
});

test('all eight masks are encoded correctly, not just the winning one', (t) => {
  if (!QRCode) return t.skip('qrcode is not installed');

  // Mask selection is a beauty contest, and agreeing with the reference about
  // which one wins says nothing about whether the other seven are right. A
  // future change to the scoring would quietly start shipping a mask that had
  // never once been compared against anything.
  const text = 'http://localhost:8787/?cluster=kite-fox-9';
  for (let mask = 0; mask < 8; mask++) {
    const mine = qr(text, { ec: 'M', mask });
    const ref = QRCode.create([{ data: text, mode: 'byte' }], {
      errorCorrectionLevel: 'M',
      maskPattern: mask,
    });
    assert.equal(mine.mask, mask);
    assert.deepEqual(flatten(mine), Array.from(ref.modules.data, Boolean), `mask ${mask}`);
  }
});

test('the block table and the geometry agree about how big a symbol is', () => {
  // Two independent routes to the same number: one adds up the block table,
  // the other counts the modules the function patterns leave behind. A typo in
  // the table shows up here and nowhere else, because a symbol built from a
  // wrong table is internally consistent and simply does not scan.
  for (let version = 1; version <= MAX_VERSION; version++) {
    for (const ec of LEVELS) {
      assert.equal(
        capacity(version, ec).total,
        totalCodewords(version),
        `version ${version} level ${ec}`,
      );
    }
  }
});

test('capacity grows with the version and shrinks with the protection', () => {
  for (let version = 1; version < MAX_VERSION; version++) {
    assert.ok(
      capacity(version + 1, 'M').bytes > capacity(version, 'M').bytes,
      `version ${version + 1} should hold more than ${version}`,
    );
  }
  for (const version of [1, 5, 10]) {
    const [l, m, q, h] = LEVELS.map((ec) => capacity(version, ec).bytes);
    assert.ok(l > m && m > q && q > h, `version ${version}: ${l} ${m} ${q} ${h}`);
  }
});

test('the smallest version that fits is the one chosen', () => {
  for (const ec of LEVELS) {
    for (let version = 1; version <= MAX_VERSION; version++) {
      const limit = capacity(version, ec).bytes;
      assert.equal(qr('u'.repeat(limit), { ec }).version, version, `${limit} bytes at ${ec}`);
      if (version < MAX_VERSION) {
        assert.equal(qr('u'.repeat(limit + 1), { ec }).version, version + 1, `${limit + 1} bytes at ${ec}`);
      }
    }
  }
});

test('the function patterns are where a scanner will look for them', () => {
  for (const [what, text] of CASES) {
    let mine;
    try {
      mine = qr(text, { ec: 'M' });
    } catch {
      continue; // Too long for level M; covered by the capacity tests.
    }
    const { size, modules, version } = mine;
    const at = (r, c) => Boolean(modules[r][c]);

    assert.equal(size, sizeOf(version), `${what}: size follows from the version`);
    assert.equal(size % 4, 1, `${what}: every version is 4n+17 modules across`);

    // Three finder patterns: a dark seven-by-seven ring around a dark
    // three-by-three core, with a light ring between them.
    const finder = (r, c) =>
      r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4);

    for (const [row, col] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
          assert.equal(at(row + r, col + c), finder(r, c), `${what}: finder at ${row},${col} cell ${r},${c}`);
        }
      }
    }

    // And only three. The missing fourth is how a scanner tells which way up
    // the symbol is, so a fourth appearing there by accident would be a code
    // that reads correctly at one rotation and nonsense at another. It is not
    // empty — from version 2 an alignment pattern sits in that corner — but it
    // must not be the finder shape.
    const fourth = [];
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) fourth.push(at(size - 7 + r, size - 7 + c) === finder(r, c));
    }
    assert.ok(fourth.includes(false), `${what}: the fourth corner must not look like a finder`);

    // Separators: a clear line between each finder and the data.
    for (let i = 0; i < 8; i++) {
      assert.equal(at(7, i), false, `${what}: top-left separator row`);
      assert.equal(at(i, 7), false, `${what}: top-left separator column`);
      assert.equal(at(7, size - 1 - i), false, `${what}: top-right separator row`);
      assert.equal(at(size - 1 - i, 7), false, `${what}: bottom-left separator column`);
    }

    // Timing patterns: strict alternation along row and column 6, which is
    // what lets a scanner measure the module pitch across the whole symbol.
    for (let i = 8; i < size - 8; i++) {
      assert.equal(at(6, i), i % 2 === 0, `${what}: horizontal timing at ${i}`);
      assert.equal(at(i, 6), i % 2 === 0, `${what}: vertical timing at ${i}`);
    }

    // The dark module, which is always dark and always here.
    assert.equal(at(size - 8, 8), true, `${what}: the dark module`);

    // Alignment patterns exist from version 2 upward: a dark five-by-five ring
    // with a single dark module at its centre, at the far corner from the
    // finders where it is certain not to collide with anything.
    if (version >= 2) {
      const centre = size - 7;
      assert.equal(at(centre, centre), true, `${what}: alignment centre`);
      assert.equal(at(centre - 1, centre - 1), false, `${what}: alignment inner ring is light`);
      assert.equal(at(centre - 2, centre - 2), true, `${what}: alignment outer ring is dark`);
    }
  }
});

test('nothing but booleans, and the right number of them', () => {
  const { size, modules } = qr('http://localhost:8787/?cluster=kite-fox-9');
  assert.equal(modules.length, size);
  for (const row of modules) {
    assert.equal(row.length, size);
    for (const cell of row) assert.equal(typeof cell, 'boolean');
  }
});

test('the same text encodes the same way every time', () => {
  const a = qr('http://localhost:8787/?cluster=kite-fox-9', { ec: 'Q' });
  const b = qr('http://localhost:8787/?cluster=kite-fox-9', { ec: 'Q' });
  assert.deepEqual(flatten(a), flatten(b));
  assert.equal(a.mask, b.mask);
});

test('a level is a level, in either case, and anything else is an error', () => {
  assert.equal(qr('hello', { ec: 'q' }).ec, 'Q');
  assert.equal(qr('hello').ec, 'M', 'M by default');
  assert.throws(() => qr('hello', { ec: 'Z' }), /error correction/);
});

test('text too long to encode says so rather than producing a broken symbol', () => {
  const tooMuch = 'x'.repeat(capacity(MAX_VERSION, 'H').bytes + 1);
  assert.throws(() => qr(tooMuch, { ec: 'H' }), /will not fit/);
  assert.doesNotThrow(() => qr('x'.repeat(capacity(MAX_VERSION, 'H').bytes), { ec: 'H' }));
});

test('toText draws the symbol with a quiet zone around it', () => {
  const code = qr('http://localhost:8787/?cluster=kite-fox-9');
  const lines = toText(code).split('\n');

  // Four clear modules on every side. Two module rows to a line, so the four
  // rows above and below are two blank lines each. This is the requirement
  // most often skipped and most often responsible for a code that will not
  // scan: without it a scanner cannot find the symbol's edge at all.
  assert.equal(lines.length, Math.ceil((code.size + 8) / 2));
  assert.equal(lines[0].trim(), '', 'first line is quiet');
  assert.equal(lines[1].trim(), '', 'second line is quiet');
  assert.equal(lines.at(-1).trim(), '', 'last line is quiet');
  assert.equal(lines.at(-2).trim(), '', 'second to last line is quiet');

  for (const [i, line] of lines.entries()) {
    assert.equal(line.length, code.size + 8, `line ${i} width`);
    assert.equal(line.slice(0, 4), '    ', `line ${i} left margin`);
    assert.equal(line.slice(-4), '    ', `line ${i} right margin`);
  }

  // And it did draw something.
  assert.ok(lines.some((line) => line.trim().length > 0));
});

test('toText uses block elements and nothing else', () => {
  const drawn = toText(qr('https://chat.example.org/?cluster=moss-lark-42', { ec: 'H' }));

  // Upper half, lower half, full block, space. Referred to by codepoint so
  // that this file, like the one it tests, contains no solid rectangles for
  // somebody to mistake for corruption in a diff.
  const allowed = new Set([' ', '▀', '▄', '█', '\n']);
  for (const character of drawn) {
    assert.ok(allowed.has(character), `unexpected U+${character.codePointAt(0).toString(16)}`);
  }
  assert.ok(drawn.includes('█'), 'some modules are dark in both rows');
});

test('nothing drawn is a pictograph', () => {
  // This place is words only, and the rule covers what the product draws as
  // well as what people type. Block Elements are drawing characters and not
  // emoji, but that is a claim worth checking against the actual test rather
  // than asserting in a comment.
  for (const ec of LEVELS) {
    const drawn = toText(qr('http://localhost:8787/?cluster=kite-fox-9', { ec }));
    assert.equal(hasPictographs(drawn), false, `level ${ec}`);
  }
});

test('toText takes either the result or the bare matrix', () => {
  const code = qr('hello');
  assert.equal(toText(code), toText(code.modules));
  assert.throws(() => toText('not a matrix'), TypeError);
});

test('inverting swaps the quiet zone too', () => {
  const code = qr('hello');
  const normal = toText(code).split('\n');
  const inverted = toText(code, { invert: true }).split('\n');

  // A light quiet zone on a dark symbol is what a camera needs; on a dark
  // terminal both have to flip together or the margin vanishes into the
  // background and the code stops scanning.
  assert.equal(normal[0].trim(), '');
  assert.equal(inverted[0], '█'.repeat(code.size + 8));
  assert.equal(normal.length, inverted.length);
});

test('a wider quiet zone is still a quiet zone', () => {
  const code = qr('hello');
  const lines = toText(code, { quiet: 6 }).split('\n');
  assert.equal(lines[0].length, code.size + 12);
  assert.equal(lines[0].trim(), '');
  assert.equal(lines[2].trim(), '');
});
