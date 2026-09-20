/**
 * A cluster link, drawn as a square somebody can point a phone at.
 *
 * Cluster names are made to be said out loud — `kite-fox-9` survives a noisy
 * pub — but the link around the name does not. Nobody wants to type
 * `http://localhost:8787/?cluster=kite-fox-9` off somebody else's screen, and
 * asking them to is how a shared room becomes a room with two people in it. A
 * QR code turns the awkward part back into the easy part: hold up the laptop,
 * everyone else points a camera at it, and the name never has to be spelled.
 *
 * It is written out here rather than taken from a package, and that deserves a
 * reason, because "I implemented my own QR encoder" is usually a confession.
 * The reason is that this library has two runtime dependencies and would like
 * to keep it that way; the encoder is needed in the browser as well as the
 * server, so a dependency would have to be bundled rather than merely
 * installed; and the format is *finished*. ISO/IEC 18004 has not moved in
 * years and is not going to. Code that will never need updating is cheap to
 * own, whereas a dependency is a relationship that has to be maintained
 * whether or not anything about it changes.
 *
 * What is here is a real encoder and not a toy: Reed–Solomon error correction
 * over GF(256), block interleaving, every function pattern, the BCH-protected
 * format and version information, and all eight data masks scored against each
 * other. The test suite checks the output cell for cell against the `qrcode`
 * package, because an encoder that is *almost* right produces a picture that
 * looks exactly like a QR code and does not scan, which is worse than printing
 * the URL and admitting defeat.
 *
 * Deliberately narrow in two ways.
 *
 * Byte mode only. QR has numeric and alphanumeric modes that pack digits and
 * uppercase text more tightly, and they are worth real money if you are
 * printing a million labels. Here the payload is always a URL, which is mixed
 * case and full of characters the alphanumeric set does not have, so those
 * modes would never fire. They would be a few hundred lines of code that the
 * tests could only exercise artificially.
 *
 * Versions 1 to 10, which is 213 bytes at the default error correction level.
 * The longest thing this is ever asked to carry is an origin plus a short
 * query string, and a version 10 symbol is already 57 modules across — beyond
 * that a phone camera needs to be close enough that reading the URL aloud
 * would have been quicker. Anything longer throws rather than silently
 * producing something unusable.
 */

/**
 * The four error correction levels, with the two-bit code each one is written
 * as in the format information.
 *
 * Note that the codes are not in order of strength: L is 01 and M is 00. That
 * is not a mistake being copied forward, it is what the standard says, and it
 * matters because M is the default and 00 is what an uninitialised field looks
 * like. Written as a table so the surprise is visible rather than buried in an
 * expression somewhere.
 *
 * M is the default because it is the level everything else defaults to, and a
 * cluster link is displayed on a screen or on a sheet of paper on a table — it
 * is not going on the side of a van, and it does not need to survive being
 * rained on. H would cost roughly a quarter of the capacity to protect against
 * damage that is not going to happen.
 */
const LEVELS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

/**
 * How each version is cut up, by error correction level.
 *
 * `[ecPerBlock, blocks]`, where `blocks` is a list of `[count, dataCodewords]`.
 * Larger symbols split their data into several blocks and protect each one
 * separately, so that a coffee ring which destroys one block outright still
 * leaves the others recoverable — error correction defends against a scatter
 * of bad modules, but real damage is not scattered, it is a blob. Blocks are
 * then interleaved across the symbol precisely so that a blob on the paper
 * becomes a scatter in each block.
 *
 * Some versions have two block sizes differing by one codeword, because the
 * data does not divide evenly and the standard would rather waste nothing than
 * be tidy. There is no formula for any of this; it is a table in the standard
 * and it is a table here. The totals are checked in the tests against the
 * known total codeword count for each version, which catches a typo in a way
 * that reading the numbers again never does.
 */
const BLOCKS = {
  1: { L: [7, [[1, 19]]], M: [10, [[1, 16]]], Q: [13, [[1, 13]]], H: [17, [[1, 9]]] },
  2: { L: [10, [[1, 34]]], M: [16, [[1, 28]]], Q: [22, [[1, 22]]], H: [28, [[1, 16]]] },
  3: { L: [15, [[1, 55]]], M: [26, [[1, 44]]], Q: [18, [[2, 17]]], H: [22, [[2, 13]]] },
  4: { L: [20, [[1, 80]]], M: [18, [[2, 32]]], Q: [26, [[2, 24]]], H: [16, [[4, 9]]] },
  5: {
    L: [26, [[1, 108]]],
    M: [24, [[2, 43]]],
    Q: [18, [[2, 15], [2, 16]]],
    H: [22, [[2, 11], [2, 12]]],
  },
  6: { L: [18, [[2, 68]]], M: [16, [[4, 27]]], Q: [24, [[4, 19]]], H: [28, [[4, 15]]] },
  7: {
    L: [20, [[2, 78]]],
    M: [18, [[4, 31]]],
    Q: [18, [[2, 14], [4, 15]]],
    H: [26, [[4, 13], [1, 14]]],
  },
  8: {
    L: [24, [[2, 97]]],
    M: [22, [[2, 38], [2, 39]]],
    Q: [22, [[4, 18], [2, 19]]],
    H: [26, [[4, 14], [2, 15]]],
  },
  9: {
    L: [30, [[2, 116]]],
    M: [22, [[3, 36], [2, 37]]],
    Q: [20, [[4, 16], [4, 17]]],
    H: [24, [[4, 12], [4, 13]]],
  },
  10: {
    L: [18, [[2, 68], [2, 69]]],
    M: [26, [[4, 43], [1, 44]]],
    Q: [24, [[6, 19], [2, 20]]],
    H: [28, [[6, 15], [2, 16]]],
  },
};

/**
 * Where the centres of the alignment patterns go, per version.
 *
 * Every pairing of these coordinates gets a pattern, except the three that
 * would land on a finder pattern. They exist so that a code photographed at an
 * angle, or printed on something curved, can be resampled: the three finders
 * fix the corners, and these fix the middle, which is where a perspective
 * error is largest. Version 1 is small enough not to need any.
 *
 * The spacing is not quite regular — the standard's own values are used rather
 * than a computed interval, because the published formula disagrees with the
 * published table for at least one version and the table is what scanners
 * were built against.
 */
const ALIGNMENT = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

/** The highest version this encoder knows how to build. */
const MAX_VERSION = 10;

/** How wide a symbol of a given version is, in modules. Version 1 is 21. */
const sizeOf = (version) => version * 4 + 17;

/**
 * Total codewords in a symbol, data and error correction together.
 *
 * Derived rather than tabulated: it is the module count minus everything the
 * function patterns take, divided by eight. The tests check it against the
 * block table, so the two independent routes to the same number have to agree.
 */
function totalCodewords(version) {
  const size = sizeOf(version);
  let modules = size * size;
  modules -= 3 * 64; // Three finder patterns with their separators.
  modules -= 2 * (size - 16); // The two timing patterns, minus finder overlap.
  modules -= 31; // Format information and the dark module.

  const centres = ALIGNMENT[version];
  if (centres.length) {
    const n = centres.length;
    // Every pairing except the three sitting on finders; each is 25 modules,
    // and the ones on a timing line overlap it by five modules already counted.
    modules -= (n * n - 3) * 25;
    modules += (2 * n - 5) * 5;
  }
  if (version >= 7) modules -= 36; // Two version information blocks.

  return Math.floor(modules / 8);
}

// --- Galois field arithmetic -----------------------------------------------

/**
 * Logarithm and antilogarithm tables for GF(256).
 *
 * Reed–Solomon needs to multiply and divide field elements constantly, and in
 * a field of 256 elements the cheapest way to do that is to turn both into
 * addition of exponents. 0x11D is the primitive polynomial the QR standard
 * specifies; any primitive polynomial gives a valid field, but only this one
 * gives the field that scanners are expecting.
 */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
// The table is doubled so that a sum of two exponents never has to be reduced
// modulo 255 at the point of use, which is the inner loop of the whole file.
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/**
 * The generator polynomial for `count` error correction codewords: the product
 * of `(x - a^i)` for i from 0 to count-1.
 *
 * Cached, because a symbol with several blocks wants the same one repeatedly
 * and building it is quadratic in the degree.
 */
const GENERATORS = new Map();
function generator(count) {
  const cached = GENERATORS.get(count);
  if (cached) return cached;

  let poly = [1];
  for (let i = 0; i < count; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= mul(poly[j], EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  GENERATORS.set(count, poly);
  return poly;
}

/**
 * The error correction codewords for one block.
 *
 * This is polynomial long division: the remainder of the data, shifted up by
 * the degree of the generator, divided by the generator. Everything a scanner
 * can do to repair a damaged symbol follows from the data and the remainder
 * together being an exact multiple of a polynomial with known roots.
 */
function remainder(data, count) {
  const gen = generator(count);
  const out = new Uint8Array(count);

  for (const byte of data) {
    const factor = byte ^ out[0];
    out.copyWithin(0, 1);
    out[count - 1] = 0;
    if (factor !== 0) {
      for (let i = 0; i < count; i++) out[i] ^= mul(gen[i + 1], factor);
    }
  }

  return out;
}

// --- Bits and codewords -----------------------------------------------------

/**
 * How many bits the character count indicator takes.
 *
 * Eight up to version 9 and sixteen from version 10, in byte mode. The jump is
 * why version selection cannot simply be "find the smallest version with
 * enough room": crossing from 9 to 10 costs an extra byte of overhead, so a
 * payload can in principle fit version 9 and not fit version 10's data area by
 * the same margin. In practice the capacity step between versions is far
 * larger than one byte, but the count is computed per candidate version rather
 * than once, so the question never arises.
 */
const countBits = (version) => (version < 10 ? 8 : 16);

/**
 * Turn the text into the data codewords for a chosen version and level.
 *
 * The padding at the end is the part that looks arbitrary and is not. After
 * the terminator and the alignment to a byte boundary, any remaining capacity
 * is filled with 0xEC and 0x11 alternating. Those two bytes are 11101100 and
 * 00010001, chosen because they are busy — a long run of identical bytes would
 * produce large blank areas in the symbol, which the mask scoring would then
 * have to fight, and which a scanner finds harder to lock onto.
 */
function codewords(bytes, version, level) {
  const [, blocks] = BLOCKS[version][level];
  const capacity = blocks.reduce((sum, [count, size]) => sum + count * size, 0);

  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };

  push(0b0100, 4); // Byte mode.
  push(bytes.length, countBits(version));
  for (const byte of bytes) push(byte, 8);

  // The terminator is up to four zero bits, and only up to: if the data ends
  // flush against the capacity there is no room and none is required, because
  // a decoder that has consumed the declared character count already knows to
  // stop.
  const room = capacity * 8 - bits.length;
  push(0, Math.min(4, room));
  while (bits.length % 8 !== 0) bits.push(0);

  const out = new Uint8Array(capacity);
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    out[i / 8] = byte;
  }
  for (let i = bits.length / 8, alternate = 0; i < capacity; i++, alternate++) {
    out[i] = alternate % 2 === 0 ? 0xec : 0x11;
  }

  return out;
}

/**
 * Interleave the blocks into the final codeword stream.
 *
 * Every block's first codeword, then every block's second, and so on; then the
 * same for the error correction codewords. This is the step that makes
 * multi-block error correction actually work, and it is also the step that is
 * easiest to get subtly wrong, because a symbol built without it decodes
 * perfectly under laboratory conditions and fails the moment anything is
 * smudged.
 *
 * Where blocks differ in length by one codeword, the shorter ones simply have
 * nothing to contribute on the last pass and are skipped. Error correction
 * blocks are always the same length as each other, so they need no such care.
 */
function interleave(data, version, level) {
  const [ecCount, layout] = BLOCKS[version][level];

  const pieces = [];
  let offset = 0;
  for (const [count, size] of layout) {
    for (let i = 0; i < count; i++) {
      const block = data.subarray(offset, offset + size);
      offset += size;
      pieces.push({ data: block, ec: remainder(block, ecCount) });
    }
  }

  const longest = Math.max(...pieces.map((p) => p.data.length));
  const out = [];
  for (let i = 0; i < longest; i++) {
    for (const piece of pieces) if (i < piece.data.length) out.push(piece.data[i]);
  }
  for (let i = 0; i < ecCount; i++) {
    for (const piece of pieces) out.push(piece.ec[i]);
  }

  return Uint8Array.from(out);
}

// --- BCH-protected metadata -------------------------------------------------

/** The position of the highest set bit, used to drive the BCH divisions. */
function degree(value) {
  let n = 0;
  while (value !== 0) {
    n++;
    value >>>= 1;
  }
  return n;
}

/**
 * The fifteen bits of format information: level, mask, and error correction
 * over both.
 *
 * Format information is the one thing a scanner cannot recover without: it has
 * to know the mask before it can unmask anything, so the format bits cannot
 * themselves be masked by the data mask. They get their own BCH code instead,
 * and are written twice in different places, so that losing a whole corner of
 * the symbol still leaves a readable copy.
 *
 * The final XOR with 0x5412 exists so that the all-zero case — level M, mask
 * 0 — does not produce fifteen blank modules next to the finder pattern, which
 * a scanner would struggle to distinguish from a quiet zone.
 */
function formatBits(level, mask) {
  const data = (LEVELS[level] << 3) | mask;
  let value = data << 10;
  const g = 0b10100110111; // 0x537
  while (degree(value) - degree(g) >= 0) value ^= g << (degree(value) - degree(g));
  return ((data << 10) | value) ^ 0b101010000010010; // 0x5412
}

/**
 * The eighteen bits of version information, present from version 7 upward.
 *
 * Below version 7 a scanner works the version out by counting modules, which
 * is reliable while the symbol is small. Once it is large enough that a
 * miscount by one is plausible, the version is written down explicitly with
 * six bits of data and twelve of BCH — an unusually generous ratio, because
 * getting the version wrong means misreading every module position after it.
 */
function versionBits(version) {
  let value = version << 12;
  const g = 0b1111100100101; // 0x1F25
  while (degree(value) - degree(g) >= 0) value ^= g << (degree(value) - degree(g));
  return (version << 12) | value;
}

// --- The symbol itself ------------------------------------------------------

/**
 * The eight data masks, as predicates on a module's position.
 *
 * A mask exists to break up the picture. Encoded data is perfectly capable of
 * coming out as a large white rectangle or as something that looks like a
 * finder pattern, and either would confuse a scanner badly; XORing the data
 * region with a regular pattern guarantees that whatever the payload, the
 * result has texture. All eight are tried and the least bad is kept.
 *
 * The row and column arguments are that way round — row first — throughout
 * this file, which is worth stating once because the standard's own formulae
 * are written with i as the row and j as the column and it is very easy to
 * transpose masks 2 and 4 without noticing, since the others are symmetric.
 */
const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/**
 * Lay down everything that is not data: the parts whose position and colour
 * are fixed by the version alone.
 *
 * Returns the module grid alongside a parallel grid of which cells are spoken
 * for. The second grid is not an optimisation — the data placement walk and
 * the masking both need to know which cells to step over, and working it out
 * from coordinates each time is how off-by-one errors get in.
 */
function skeleton(version) {
  const size = sizeOf(version);
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));

  const set = (r, c, dark) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    modules[r][c] = dark;
    fixed[r][c] = true;
  };

  // Finder patterns, swept one module wider than themselves so that the same
  // loop lays the separators down as light modules.
  for (const [row, col] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const ring = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        set(row + r, col + c, ring || core);
      }
    }
  }

  // Timing patterns: the alternating row and column that let a scanner count
  // module widths across a symbol it is seeing at an angle.
  for (let i = 8; i < size - 8; i++) {
    set(i, 6, i % 2 === 0);
    set(6, i, i % 2 === 0);
  }

  // Alignment patterns at every pairing of the version's coordinates, minus
  // the three corners already occupied by finders.
  const centres = ALIGNMENT[version];
  for (let i = 0; i < centres.length; i++) {
    for (let j = 0; j < centres.length; j++) {
      const corner = (i === 0 && j === 0)
        || (i === 0 && j === centres.length - 1)
        || (i === centres.length - 1 && j === 0);
      if (corner) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const edge = r === -2 || r === 2 || c === -2 || c === 2;
          set(centres[i] + r, centres[j] + c, edge || (r === 0 && c === 0));
        }
      }
    }
  }

  // Reserve the format information with a placeholder; the real bits depend on
  // which mask wins, which is not known until the data is in place.
  writeFormat(modules, fixed, 'M', 0);
  if (version >= 7) writeVersion(modules, fixed, version);

  return { size, modules, fixed };
}

/**
 * Write the fifteen format bits into their two homes.
 *
 * The layout is the least regular thing in the specification: a run down the
 * left of the top-left finder and along the top, mirrored as a run along the
 * right edge and up the bottom-left, with column and row 6 skipped because the
 * timing patterns own them. There is no pattern to extract here; the
 * conditionals are the specification, written out.
 */
function writeFormat(modules, fixed, level, mask) {
  const size = modules.length;
  const bits = formatBits(level, mask);

  const set = (r, c, dark) => {
    modules[r][c] = dark;
    fixed[r][c] = true;
  };

  for (let i = 0; i < 15; i++) {
    const dark = ((bits >> i) & 1) === 1;

    if (i < 6) set(i, 8, dark);
    else if (i < 8) set(i + 1, 8, dark);
    else set(size - 15 + i, 8, dark);

    if (i < 8) set(8, size - i - 1, dark);
    else if (i < 9) set(8, 15 - i, dark);
    else set(8, 15 - i - 1, dark);
  }

  // The dark module: one permanently black cell just above the bottom-left
  // finder. It carries no information and exists, as far as anyone can tell,
  // to make the format area's bit count come out right.
  set(size - 8, 8, true);
}

/** The version information, in the two blocks beside the far finders. */
function writeVersion(modules, fixed, version) {
  const size = modules.length;
  const bits = versionBits(version);

  for (let i = 0; i < 18; i++) {
    const dark = ((bits >> i) & 1) === 1;
    const row = Math.floor(i / 3);
    const col = (i % 3) + size - 11;
    modules[row][col] = dark;
    fixed[row][col] = true;
    modules[col][row] = dark;
    fixed[col][row] = true;
  }
}

/**
 * Thread the codeword stream through the symbol.
 *
 * The path is two modules wide and snakes upward from the bottom right, then
 * downward, then upward, skipping anything already occupied and skipping
 * column 6 entirely because the vertical timing pattern sits there and would
 * otherwise put a permanent kink in the middle of every column pair.
 *
 * Any modules left over once the codewords run out stay light. Those are the
 * remainder bits — some versions have a few modules more than the codewords
 * fill — and the standard says they are zero and are masked like everything
 * else, which falls out of doing nothing special here.
 */
function placeData(modules, fixed, data) {
  const size = modules.length;
  let bit = 7;
  let byte = 0;
  let row = size - 1;
  let upward = true;

  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (;;) {
      for (let i = 0; i < 2; i++) {
        if (fixed[row][col - i]) continue;
        modules[row][col - i] = byte < data.length && ((data[byte] >>> bit) & 1) === 1;
        if (--bit < 0) {
          bit = 7;
          byte++;
        }
      }
      row += upward ? -1 : 1;
      if (row < 0 || row >= size) {
        row -= upward ? -1 : 1;
        upward = !upward;
        break;
      }
    }
  }
}

/**
 * How bad a masked symbol looks, by the standard's four criteria.
 *
 * Lower is better, and the absolute number means nothing — it exists only to
 * order the eight candidates. The four rules penalise, in turn: long runs of
 * one colour, which make it hard to tell where one module ends and the next
 * begins; solid blocks, for the same reason in two dimensions; anything
 * resembling a finder pattern, which could send a scanner looking for a corner
 * that is not there; and an imbalance between dark and light overall, which
 * costs a scanner its contrast margin.
 *
 * The third rule is the one that earns its forty points: a false finder
 * pattern does not degrade a read, it derails it.
 */
function penalty(modules) {
  const size = modules.length;
  let score = 0;

  // Rule 1: runs of five or more, three points plus one per module over four.
  for (let a = 0; a < size; a++) {
    let runRow = 1;
    let runCol = 1;
    for (let b = 1; b < size; b++) {
      if (modules[a][b] === modules[a][b - 1]) runRow++;
      else {
        if (runRow >= 5) score += 3 + runRow - 5;
        runRow = 1;
      }
      if (modules[b][a] === modules[b - 1][a]) runCol++;
      else {
        if (runCol >= 5) score += 3 + runCol - 5;
        runCol = 1;
      }
    }
    if (runRow >= 5) score += 3 + runRow - 5;
    if (runCol >= 5) score += 3 + runCol - 5;
  }

  // Rule 2: every two-by-two square of one colour, three points. Overlapping
  // squares each count, so a solid four-by-four is nine squares, not one.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const n = Number(modules[r][c]) + Number(modules[r][c + 1])
        + Number(modules[r + 1][c]) + Number(modules[r + 1][c + 1]);
      if (n === 0 || n === 4) score += 3;
    }
  }

  // Rule 3: the finder pattern's own 1:1:3:1:1 signature with four light
  // modules on one side, in either direction. Tracked as an eleven-bit sliding
  // window rather than by comparing runs, because the two patterns to look for
  // are then just two constants: 10111010000 and 00001011101.
  for (let a = 0; a < size; a++) {
    let windowRow = 0;
    let windowCol = 0;
    for (let b = 0; b < size; b++) {
      windowRow = ((windowRow << 1) & 0x7ff) | Number(modules[a][b]);
      windowCol = ((windowCol << 1) & 0x7ff) | Number(modules[b][a]);
      if (b >= 10) {
        if (windowRow === 0x5d0 || windowRow === 0x05d) score += 40;
        if (windowCol === 0x5d0 || windowCol === 0x05d) score += 40;
      }
    }
  }

  // Rule 4: ten points for every five percent the dark proportion strays from
  // half. Rounded the way the widely deployed encoders round it, which is
  // upward to the next multiple of five rather than to the nearer one. The
  // difference only ever changes which of two acceptable masks is chosen, and
  // agreeing with everybody else is worth more than agreeing with a strict
  // reading of a tie-break rule.
  let dark = 0;
  for (const line of modules) for (const cell of line) if (cell) dark++;
  const proportion = (dark * 100) / (size * size);
  score += Math.abs(Math.ceil(proportion / 5) - 10) * 10;

  return score;
}

/** Apply a mask to every module the function patterns have not claimed. */
function applyMask(modules, fixed, mask) {
  const size = modules.length;
  const rule = MASKS[mask];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!fixed[r][c] && rule(r, c)) modules[r][c] = !modules[r][c];
    }
  }
}

/**
 * Encode text as a QR symbol.
 *
 * @param {string} text what the code should resolve to, normally a URL
 * @param {{ec?: 'L'|'M'|'Q'|'H'}} [options]
 * @returns {{size: number, version: number, ec: string, mask: number, modules: boolean[][]}}
 *   `modules[row][col]` is true where the module is dark.
 */
export function qr(text, { ec = 'M' } = {}) {
  const level = String(ec).toUpperCase();
  if (!(level in LEVELS)) throw new Error(`unknown error correction level: ${ec}`);

  const bytes = new TextEncoder().encode(String(text ?? ''));

  // The smallest version that fits. Byte mode's character count indicator
  // widens at version 10, so the overhead is recomputed for each candidate
  // rather than assumed.
  let version = 0;
  for (let v = 1; v <= MAX_VERSION; v++) {
    const capacity = BLOCKS[v][level][1].reduce((sum, [count, size]) => sum + count * size, 0);
    if (4 + countBits(v) + bytes.length * 8 <= capacity * 8) {
      version = v;
      break;
    }
  }
  if (!version) {
    throw new Error(
      `${bytes.length} bytes will not fit a version ${MAX_VERSION} symbol at level ${level}`,
    );
  }

  const data = interleave(codewords(bytes, version, level), version, level);
  const { size, modules, fixed } = skeleton(version);
  placeData(modules, fixed, data);

  // Try every mask and keep the best. The format information is rewritten for
  // each candidate before scoring, because those thirty-one modules are part
  // of the picture a scanner sees and a mask that happens to make them awkward
  // should be charged for it.
  let best = 0;
  let lowest = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    writeFormat(modules, fixed, level, mask);
    applyMask(modules, fixed, mask);
    const score = penalty(modules);
    applyMask(modules, fixed, mask); // XOR is its own inverse; put it back.
    if (score < lowest) {
      lowest = score;
      best = mask;
    }
  }

  writeFormat(modules, fixed, level, best);
  applyMask(modules, fixed, best);

  return { size, version, ec: level, mask: best, modules };
}

/**
 * Render a symbol as text, two module rows to a line.
 *
 * Half-height block characters are what make this readable at all. A QR module
 * has to be square, and a terminal cell is about twice as tall as it is wide,
 * so drawing one module per cell gives a symbol stretched vertically by two —
 * which some scanners cope with and many do not. Packing two module rows into
 * each line using the upper and lower half blocks restores the aspect ratio,
 * and has the pleasant side effect of halving the number of lines, so a
 * version 10 symbol fits a normal terminal window.
 *
 * The quiet zone is not decoration. The standard requires four clear modules
 * on every side, and a symbol printed flush against other text is a symbol
 * that will not scan — it is the single most common way a working encoder
 * produces an unreadable code.
 *
 * Dark modules are drawn as filled blocks, which assumes a light background.
 * On a dark terminal the whole thing is inverted and most phones will refuse
 * it, so `invert` swaps the two; there is no way to detect which is needed
 * from here, so it has to be asked for.
 *
 * @param {{modules: boolean[][]}|boolean[][]} matrix
 * @param {{quiet?: number, invert?: boolean}} [options]
 */
export function toText(matrix, { quiet = 4, invert = false } = {}) {
  const grid = Array.isArray(matrix) ? matrix : matrix?.modules;
  if (!Array.isArray(grid)) throw new TypeError('toText wants a module matrix');

  const size = grid.length;
  const width = size + quiet * 2;
  const dark = (r, c) => {
    if (r < quiet || r >= quiet + size || c < quiet || c >= quiet + size) return invert;
    return Boolean(grid[r - quiet][c - quiet]) !== invert;
  };

  // Block Elements, by codepoint. Written as escapes deliberately: these are
  // drawing characters rather than pictographs, but a source file full of
  // solid black rectangles is hard to edit and harder to diff, and spelling
  // them out means nobody has to wonder which of the four is which.
  const FULL = '█'; // both rows dark
  const UPPER = '▀'; // top row only
  const LOWER = '▄'; // bottom row only
  const NONE = ' ';

  const lines = [];
  for (let r = 0; r < quiet * 2 + size; r += 2) {
    let line = '';
    for (let c = 0; c < width; c++) {
      const top = dark(r, c);
      // An odd number of rows leaves the last line with nothing underneath;
      // the quiet zone below is light, so treating the missing row as light is
      // both correct and what makes the bottom edge come out square.
      const bottom = r + 1 < quiet * 2 + size ? dark(r + 1, c) : invert;
      line += top && bottom ? FULL : top ? UPPER : bottom ? LOWER : NONE;
    }
    lines.push(line);
  }

  return lines.join('\n');
}

export { totalCodewords as _totalCodewords, sizeOf as _sizeOf, MAX_VERSION as _MAX_VERSION };
