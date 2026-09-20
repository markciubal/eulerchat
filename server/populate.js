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

const DOMAINS = [
  'painting', 'sculpture', 'poetry', 'cinema', 'photography', 'architecture',
  'jazz', 'opera', 'techno', 'folk music', 'guitar', 'piano',
  'philosophy', 'ethics', 'logic', 'metaphysics', 'linguistics', 'history',
  'archaeology', 'anthropology', 'cartography', 'astronomy', 'geology', 'botany',
  'mycology', 'birding', 'entomology', 'marine biology', 'genetics', 'neuroscience',
  'mathematics', 'topology', 'cryptography', 'compilers', 'databases', 'robotics',
  'typography', 'ceramics', 'weaving', 'woodwork', 'blacksmithing', 'bookbinding',
  'baking', 'fermentation', 'coffee', 'tea', 'cocktails', 'cheese',
  'cycling', 'climbing', 'sailing', 'running', 'chess', 'go',
];

const FACETS = [
  '', 'modern', 'early', 'history of', 'theory of', 'practical',
  'amateur', 'field', 'digital', 'analogue', 'experimental', 'traditional',
  'urban', 'rural', 'nordic', 'pacific', 'teaching', 'writing on',
  'collecting', 'restoring',
];

/** Plausible, lowercase, and short enough for `World.addSubject`. */
function* names() {
  for (const facet of FACETS) {
    for (const domain of DOMAINS) {
      const name = facet ? `${facet} ${domain}` : domain;
      if (name.length <= 31) yield name;
    }
  }
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
    subjects = 1000,
    users = 4000,
    themeSize = 25,
    seed = 1,
    minInterests = 2,
    maxInterests = 6,
    importChance = 0.25,
    chatter = 400,
  } = options;

  const random = rng(seed);
  const catalogue = [];

  for (const name of names()) {
    if (catalogue.length >= subjects) break;
    catalogue.push(world.addSubject(name));
  }
  // Past the word bank, fall back to numbered variants rather than silently
  // building a smaller world than was asked for.
  for (let i = 2; catalogue.length < subjects; i++) {
    for (const base of names()) {
      if (catalogue.length >= subjects) break;
      const name = `${base} ${i}`;
      if (name.length <= 31 && !world.subjects.has(name)) catalogue.push(world.addSubject(name));
    }
  }

  const themes = [];
  for (let i = 0; i < catalogue.length; i += themeSize) {
    themes.push(catalogue.slice(i, i + themeSize));
  }

  /** Zipf-ish pick: low indices are the theme's hubs. */
  const pick = (pool) => pool[Math.floor(pool.length * random() ** 2.2)];

  for (let u = 0; u < users; u++) {
    const userId = world.addUser(`p${u}`);
    const home = themes[Math.floor(random() * themes.length)];
    const wanted = minInterests + Math.floor(random() * (maxInterests - minInterests + 1));

    const held = new Set();
    while (held.size < wanted) {
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
    world.post(userId, room, OPENERS[Math.floor(random() * OPENERS.length)]);
  }
}
