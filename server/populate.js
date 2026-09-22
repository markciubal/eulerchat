/**
 * Synthetic populations, for asking whether the thing survives its own scale.
 *
 * The generator is clustered on purpose. Spreading people uniformly over a
 * thousand interests is the one distribution guaranteed to make this product
 * look fine and be useless: every pair would share about nobody, so every
 * circle would be drawn disjoint and there would be no overlap rooms at all.
 * Real interest graphs are lumpy — people hold several interests from one
 * neighbourhood plus the occasional import from somewhere else, and it is
 * those imports that produce the surprising intersections worth having.
 */

import { parse, reachableRooms } from '../lib/regions.js';
import { knowledge } from '../lib/knowledge.js';

/** Deterministic PRNG, so a benchmark run is comparable to the last one. */
export function rng(seed = 1) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The catalogue is the taxonomy: fields and the subfields under them, which
 * are the real things people join. Inventing names by gluing a facet onto a
 * domain — `modern painting`, `field painting`, `theory of painting` — made a
 * catalogue that looked large and was mostly one subject wearing hats.
 *
 * Asked for more than the taxonomy holds, the rest are plainly numbered and
 * go unanchored, which is honest: a real catalogue always has things no
 * taxonomy has heard of, and they belong on the unclassified ring.
 */
function catalogueOf(wanted) {
  const known = Object.keys(knowledge).filter((name) => knowledge[name] !== undefined);
  const names = known.filter((name) => name !== 'knowledge');
  for (let i = 1; names.length < wanted; i++) names.push(`topic ${i}`);
  return names.slice(0, wanted);
}

/**
 * Fill a world with `subjects` interests and `users` people.
 *
 * Interests are laid out in themes of `themeSize`; a person draws most of
 * their interests from one theme and imports the rest from elsewhere.
 * Popularity within a theme is Zipf-ish, so each theme has a couple of hubs
 * that most of its members hold — which is what gives neighbouring circles
 * enough shared membership to be worth drawing.
 */
export function populate(world, options = {}) {
  const {
    subjects = 209,
    users = 4000,
    themeSize = 25,
    seed = 1,
    minInterests = 2,
    maxInterests = 6,
    importChance = 0.25,
    chatter = 400,
  } = options;

  const random = rng(seed);
  const catalogue = catalogueOf(subjects).map((name) => world.addSubject(name));

  // A theme is a field, and its members are the subfields beneath it — so the
  // people who hold several things tend to hold several things from one
  // corner of the map, which is what real interest graphs look like and what
  // gives the overlaps anybody to put in them.
  const byField = new Map();
  const unclassified = [];
  for (const subject of catalogue) {
    const field = knowledge[subject];
    if (!field) {
      unclassified.push(subject);
      continue;
    }
    if (!byField.has(field)) byField.set(field, []);
    byField.get(field).push(subject);
  }

  const themes = [...byField.values()].filter((group) => group.length);
  // Anything outside the taxonomy would otherwise form one enormous theme, and
  // a Zipf-ish pick from a list of hundreds only ever reaches the first few —
  // which left most of the catalogue with nobody in it at all. Chunked, they
  // behave like the fields do.
  for (let i = 0; i < unclassified.length; i += themeSize) {
    themes.push(unclassified.slice(i, i + themeSize));
  }

  /** Zipf-ish pick: low indices are the theme's hubs. */
  const pick = (pool) => pool[Math.floor(pool.length * random() ** 2.2)];

  for (let u = 0; u < users; u++) {
    // Sample people, and marked as such; see `World.addUser`.
    const userId = world.addUser(`p${u}`, { synthetic: true });
    const home = themes[Math.floor(random() * themes.length)];
    // Never ask for more distinct interests than exist. Wanting six out of a
    // catalogue of three is a loop that cannot finish, and it hung the whole
    // test suite the first time anyone built a small world.
    const ceiling = Math.min(catalogue.length, maxInterests);
    const floor = Math.min(minInterests, ceiling);
    const wanted = floor + Math.floor(random() * (ceiling - floor + 1));

    const held = new Set();
    for (let tries = 0; held.size < wanted && tries < wanted * 40; tries++) {
      const pool = random() < importChance ? themes[Math.floor(random() * themes.length)] : home;
      held.add(pick(pool));
    }
    for (const subject of held) world.join(userId, subject);
  }

  if (chatter) converse(world, chatter, random);
  return world;
}

const OPENERS = [
  'been circling this one for a while and still no closer.',
  'anyone got a reading list for this?',
  'tried the obvious approach, it did not survive contact.',
  'the received wisdom here seems to be wrong and nobody says so.',
  'small breakthrough today, mostly by accident.',
  'what changed your mind about this?',
  'the two halves of this fit together better than people admit.',
  'starting over from the beginning, third time now.',
];

/**
 * A little traffic, so the rooms are not all empty on arrival.
 *
 * Posts are drawn from a person's own reachable rooms rather than from the
 * room list, which keeps every message legal under the same rule the server
 * enforces — a seeded world that could not have arisen from real use would be
 * a poor thing to test against.
 */
function converse(world, count, random) {
  const userIds = [...world.members.keys()];

  for (let i = 0; i < count; i++) {
    const userId = userIds[Math.floor(random() * userIds.length)];
    const rooms = reachableRooms(world.subscription(userId));
    if (!rooms.length) continue;

    const room = parse(rooms[Math.floor(random() * rooms.length)]);
    // A system message, labelled as one: nobody said this.
    world.post(userId, room, OPENERS[Math.floor(random() * OPENERS.length)], { machine: true });
  }
}
