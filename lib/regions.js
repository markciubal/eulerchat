/**
 * Region algebra.
 *
 * A region is a set of subjects. A room is a region that somebody is actually
 * standing in. The difference between those two sentences is the difference
 * between a Venn diagram and an Euler diagram, and it is the reason this file
 * never enumerates a power set of the subject catalogue: regions are *derived
 * from membership*, so a room only exists once somebody can occupy it.
 */

/**
 * No arrangement of circles realises all fifteen regions of a 4-set Venn
 * diagram — that is a hard geometric fact, not a rendering budget. Ellipses
 * reach five and nothing convex goes further. We cap region arity at three so
 * that every room we create is a room we can draw.
 */
export const MAX_ARITY = 3;

/** Canonical form: sorted, de-duplicated, so a region has exactly one name. */
export function canonical(subjects) {
  return [...new Set(subjects)].sort();
}

/** The address of a region. `['philosophy','art']` and `['art','philosophy']` agree. */
export function key(subjects) {
  return canonical(subjects).join('+');
}

export function parse(regionKey) {
  return regionKey === '' ? [] : regionKey.split('+');
}

/** Non-empty subsets of `set`, up to `maxSize` members, in canonical order. */
export function subsets(set, maxSize = MAX_ARITY) {
  const members = canonical(set);
  const out = [];
  const walk = (start, picked) => {
    if (picked.length > 0) out.push([...picked]);
    if (picked.length === maxSize) return;
    for (let i = start; i < members.length; i++) {
      picked.push(members[i]);
      walk(i + 1, picked);
      picked.pop();
    }
  };
  walk(0, []);
  return out;
}

/**
 * The delivery rule: a message tagged `tags` reaches a reader subscribed to
 * `subscription` exactly when `tags ⊆ subscription`.
 *
 * This is the whole social design in one predicate. A post in the art-only
 * lune reaches everyone in art, including people who are also in philosophy —
 * so nobody is structurally hidden from anybody. A post in the overlap reaches
 * only people in both, because that content assumes both contexts.
 */
export function receives(subscription, tags) {
  const held = subscription instanceof Set ? subscription : new Set(subscription);
  return canonical(tags).every((t) => held.has(t));
}

/**
 * Population of every occupied region, keyed by region address.
 *
 * Population is a *containment* count: a region's population is the number of
 * people subscribed to all of its subjects, not the number subscribed to
 * exactly those subjects. That is the count the geometry needs (the drawn lens
 * between two circles should have the area of their shared membership) and it
 * agrees with the delivery rule above, so the picture and the routing can
 * never drift apart.
 *
 * Regions with population zero never acquire a key. That absence *is* the
 * Euler pruning — there is no separate filtering step.
 */
export function census(subscriptions, maxArity = MAX_ARITY) {
  const counts = new Map();
  for (const subscription of subscriptions) {
    for (const region of subsets(subscription, maxArity)) {
      const k = key(region);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  return counts;
}

/** Occupied regions of a given arity, as `[subjects[], population]` pairs. */
export function regionsOfArity(counts, arity) {
  const out = [];
  for (const [k, population] of counts) {
    const subjects = parse(k);
    if (subjects.length === arity) out.push([subjects, population]);
  }
  return out;
}

/** Every room a given subscriber can post into or read: the subsets they hold. */
export function reachableRooms(subscription, maxArity = MAX_ARITY) {
  return subsets(subscription, maxArity).map(key);
}

/**
 * Exclusive populations: how many people hold *exactly* this combination of
 * the shown subjects, rather than at least it.
 *
 * The census counts by containment, because that is how delivery works and how
 * a circle's area reads. A drawn map needs the other quantity: every patch of
 * ground belongs to one combination, so the patches partition the diagram
 * rather than nest inside one another.
 *
 * Deliberately uncapped. Arity is limited elsewhere because circles cannot
 * draw a fourth set; a routed boundary has no such limit, so someone holding
 * six of the shown subjects forms a genuine six-subject zone here.
 */
export function zones(subscriptions, subjects) {
  const shown = new Set(subjects);
  const counts = new Map();

  for (const subscription of subscriptions) {
    const held = canonical([...subscription].filter((s) => shown.has(s)));
    if (!held.length) continue; // outside the diagram entirely
    const k = key(held);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

/**
 * The census as it would look if only `subjects` existed.
 *
 * By enumerating the subsets of `subjects` rather than filtering the whole
 * census. Identical result, but the cost is bounded by the view (at most seven
 * lookups for three circles) instead of growing with the size of the world —
 * which matters because this runs per viewer, and a thousand-interest census
 * has tens of thousands of regions in it.
 */
export function restrict(counts, subjects, maxArity = MAX_ARITY) {
  const out = new Map();
  for (const region of subsets(subjects, maxArity)) {
    const k = key(region);
    const population = counts.get(k);
    if (population !== undefined) out.set(k, population);
  }
  return out;
}

/** Address of a pair, without the allocation `key()` would cost. */
const pairKey = (a, b) => (a < b ? `${a}+${b}` : `${b}+${a}`);

/**
 * Derived once per census, so that choosing a view is not a scan of the world.
 *
 * `population` is every subject's size, `popular` is them ranked, and
 * `adjacency` maps each subject to the subjects it genuinely shares members
 * with. That last one is what keeps suggestion local: the candidates for "what
 * should I show next to this circle" are its actual neighbours, a handful,
 * rather than the entire catalogue.
 */
export function buildIndex(counts) {
  const population = new Map();
  const adjacency = new Map();
  const adj = (s) => {
    let set = adjacency.get(s);
    if (!set) adjacency.set(s, (set = new Set()));
    return set;
  };

  for (const [k, n] of counts) {
    const tags = parse(k);
    if (tags.length === 1) {
      population.set(tags[0], n);
      adj(tags[0]);
    } else if (tags.length === 2) {
      adj(tags[0]).add(tags[1]);
      adj(tags[1]).add(tags[0]);
    }
  }

  const popular = [...population.keys()].sort(
    (a, b) => population.get(b) - population.get(a) || a.localeCompare(b),
  );
  // `dirty` lets a caller keep the maps current in place and re-sort lazily.
  return { population, adjacency, popular, dirty: false };
}

/**
 * Which circles to put in front of one person.
 *
 * Nobody is ever shown a global diagram. Beyond three circles the geometry
 * stops being able to tell the truth, so each person gets their own local
 * view: the subjects they hold, and — if they hold fewer than three — whichever
 * neighbouring subjects share the most members with what they already have.
 * That second part is the discovery mechanism. An adjacent circle you are not
 * yet in is visible precisely because it overlaps the ones you are.
 *
 * Runs per viewer on every membership change, so it is written to touch only
 * the neighbourhood rather than the catalogue.
 */
export function neighbourhood(counts, subscription, limit = MAX_ARITY, index) {
  const { population, adjacency, popular } = index ?? buildIndex(counts);
  const rank = (a, b) =>
    (population.get(b) ?? 0) - (population.get(a) ?? 0) || a.localeCompare(b);

  const mine = canonical(subscription).filter((s) => population.has(s)).sort(rank);
  const chosen = mine.slice(0, limit);
  const hidden = mine.slice(limit);

  // Greedy fill, re-scored each round so the suggested circle is the one most
  // connected to the set as it actually stands, not as it started.
  while (chosen.length < limit) {
    if (!chosen.length) {
      // Nothing to be adjacent to yet: start from the largest subject there is.
      if (!popular.length) break;
      chosen.push(popular[0]);
      continue;
    }

    const pool = new Set();
    for (const c of chosen) for (const n of adjacency.get(c) ?? []) pool.add(n);
    for (const c of chosen) pool.delete(c);

    let best = null;
    let bestScore = -1;
    for (const s of pool) {
      let score = 0;
      for (const c of chosen) score += counts.get(pairKey(s, c)) ?? 0;
      if (best === null || score > bestScore || (score === bestScore && rank(s, best) < 0)) {
        best = s;
        bestScore = score;
      }
    }

    // An island: nothing overlaps what is chosen, so fall back to size.
    best ??= popular.find((s) => !chosen.includes(s)) ?? null;
    if (best === null) break;
    chosen.push(best);
  }

  return { subjects: canonical(chosen), hidden, suggested: chosen.filter((s) => !mine.includes(s)) };
}
