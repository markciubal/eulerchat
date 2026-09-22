import {
  MAX_ARITY,
  ROOM_ARITY,
  buildIndex,
  canonical,
  census,
  key,
  neighbourhood,
  parse,
  receives,
  restrict,
  subsets,
  zones,
} from '../lib/regions.js';
import { layout } from '../lib/euler.js';
import { atlas } from '../lib/atlas.js';
import {
  anchorsFor,
  ancestorsOf,
  distanceBetween,
  normalise,
  radialLayout,
  resolve,
} from '../lib/taxonomy.js';
import { alsoCalled, childrenOf, knowledge } from '../lib/knowledge.js';
import { DEFAULT_WORDS, REASON_NAMES, rank, scan } from '../lib/flag.js';
import { plain } from '../lib/plain.js';
import {
  clusterOf,
  groupRoom,
  isCluster,
  isGroupRoom,
  label,
  split as splitCluster,
  within,
} from '../lib/cluster.js';
import { commitmentInput, entryInput } from '../lib/receipt.js';
import { watchable } from '../lib/lurk.js';
import { activity } from '../lib/activity.js';
import { associations } from '../lib/association.js';
import { communities as findCommunities } from '../lib/communities.js';
import { isPortalRoom } from '../lib/portal.js';
import { createHash } from 'node:crypto';
import { MemoryLedger, isLedger } from './ledger.js';

// Synchronous here because deletion happens on a timer and the sweep should
// not become asynchronous for the sake of a hash. The browser verifies the
// same chain with WebCrypto; both sides build the string to be hashed from
// `lib/receipt.js`, so the two cannot drift.
const sha = (text) => createHash('sha256').update(String(text)).digest('hex');

/** Computed once: where subjects sit before anybody has joined them. */
const EXTENT = 1000;

/** How many of somebody's chats not drawn on their map are listed beside it. */
const OFF_MAP_KEPT = 100;

/** How many communities nearest its own a map offers to branch into. */
const NEAR_OFFERED = 2;

/** How many of a community's interests are named for joining; see `branchFor`. */
const COMMUNITY_OFFERED = 40;

/** A community as a map offers it: what it is called, and how big it is. */
const briefly = (c) => ({ lead: c.lead, name: c.name, size: c.members.length });
const HIERARCHY = radialLayout(knowledge, { extent: EXTENT });

/**
 * How far apart two subjects are in the hierarchy, 0 to 1. What the novelty
 * dial steers by; built once because it memoises each subject's chain upward
 * and a cache thrown away per call is not a cache.
 */
const APART = distanceBetween(knowledge);

/** What sits directly under each name in the bundled hierarchy. */
const UNDER = childrenOf(knowledge);

/** How many names sit beneath one, at any depth. Memoised: browsing asks a lot. */
const INSIDE = new Map();
function inside(name) {
  if (!INSIDE.has(name)) {
    INSIDE.set(name, (UNDER.get(name) ?? []).reduce((sum, kid) => sum + 1 + inside(kid), 0));
  }
  return INSIDE.get(name);
}

const EMPTY = new Set();

const now = () => Date.now();
const id = () => crypto.randomUUID().slice(0, 8);

/**
 * A name, without the one thing a name may not contain.
 *
 * A key is written after a name as `wren` then a dot then eight characters,
 * and it is drawn separately so that text cannot pass for it. That is not
 * quite enough: somebody with no key at all, calling themselves `wren` dot
 * `3fA9xQ2k`, would read at a glance as the person who holds that key. So the
 * dot, and the other dots that look like it, are not available in names.
 * Written as codepoints so that this file does not depend on anybody's editor
 * telling seven near-identical characters apart.
 */
const DOTS = [0x00b7, 0x2022, 0x2027, 0x2219, 0x22c5, 0x30fb, 0xff65]
  .map((c) => String.fromCodePoint(c))
  .join('');
const DOT = new RegExp(`[${DOTS}]`, 'g');
const nameFrom = (name) => String(name ?? '').replace(DOT, '').trim().slice(0, 40);

/** Bounds the cubic term in `census`; see `join`. */
export const MAX_SUBSCRIPTIONS = 32;

/** Bounds the catalogue, which is otherwise unbounded memory; see `addSubject`. */
export const MAX_SUBJECTS = 50_000;

/**
 * How long the server keeps anything. After this it forgets.
 *
 * Worth being exact about what that is and is not: it deletes the server's
 * copy. Everyone who was in the room was handed the words and can keep them
 * for as long as they like, and nothing here can tell whether they have. This
 * limits what a server breach yields, not what a person remembers.
 */
export const KEEP_FOR = 12 * 60 * 60 * 1000;

/**
 * How long a report is kept, which is longer, and deliberately.
 *
 * This is the one exception to the twelve hours above, and it should be stated
 * rather than discovered. A report is useless without the thing complained
 * about, and a message reported at hour eleven would otherwise take its own
 * evidence with it an hour later — so reporting a message copies it into the
 * report, and that copy outlives the conversation.
 *
 * The exception is kept as narrow as it can be: only a message somebody
 * actually reported, only that message, and only for as long as a moderator
 * plausibly needs to look. Everything else in the room still goes at twelve
 * hours. People are told this when they report.
 */
export const REPORTS_KEEP_FOR = 30 * 24 * 60 * 60 * 1000;

/**
 * How much it says about two people that they both hold a subject.
 *
 * Inverse document frequency, for the same reason search uses it: a word
 * everybody writes distinguishes nobody. Two people who both hold `art` share
 * almost nothing; two who both hold `entomology` are nearly the same person.
 * Held by everybody is worth exactly zero rather than a little.
 */
/**
 * How many solved atlases are kept: one for each different map somebody has
 * been shown lately. Past that the one used longest ago goes first.
 */
const ATLASES_KEPT = 256;

const rarity = (holders, people) => Math.max(0, Math.log(people / Math.max(1, holders)));

/**
 * Region addresses without the array `key()` would allocate. Same answer —
 * sorted and joined — but these run once per candidate per subject held, which
 * is the one place in this file where that matters.
 */
const pairKey = (a, b) => (a < b ? `${a}+${b}` : `${b}+${a}`);
const tripleKey = (a, b, c) => {
  let x = a;
  let y = b;
  let z = c;
  let t;
  if (x > y) { t = x; x = y; y = t; }
  if (y > z) { t = y; y = z; z = t; }
  if (x > y) { t = x; x = y; y = t; }
  return `${x}+${y}+${z}`;
};

/**
 * A subject this much of the world holds is a crowd, and two people standing
 * in a crowd have not met. Gathering candidates through one costs the most and
 * says the least — the rarity weighting would discount whatever it found to
 * nearly nothing anyway — so it is skipped, which is faster *and* better.
 *
 * The floor is there because a small world is all crowd: in a world of twenty
 * people every subject is a large share of it, and skipping everything would
 * leave the seeded world with no bridges at all.
 */
const CROWD_SHARE = 0.05;
const CROWD_FLOOR = 64;

/**
 * The size at which a room stops being a room and starts being a crowd —
 * the same number `lib/notify.js` calls `intimate`, and for the same reason.
 *
 * A room needs somebody in it, and the second person is worth far more than
 * the first, so population counts. But it counts up to here and no further: a
 * room of eighty is not ten times the find a room of eight is, and a weighting
 * that said so would quietly turn back into the popularity ranking that
 * `rail.popular` already is. Past this point what separates two suggestions is
 * how unusual they are, which is the whole point of the exercise.
 */
const INTIMATE = 8;
const INTIMATE_SCALE = Math.log1p(INTIMATE);

/**
 * How many of somebody's subjects are used as bridges: the rarest this many.
 *
 * Everything in this walk is multiplied by that number — the people visited,
 * the rooms looked up per candidate, and then the triples among the rooms that
 * matched — so an uncapped subscription of thirty-two turned a millisecond
 * into thirty. The rarest eight are where the information is, by the same
 * argument that orders them; the rest were going to be discounted to almost
 * nothing anyway, and paying for a thirtieth census lookup to add a room worth
 * 0.02 is not a trade to make on the only thread there is.
 *
 * Nobody is shown more than three subjects at once, and almost nobody holds
 * more than eight, so in practice this caps nothing at all.
 */
const MAX_BRIDGES = 8;

/**
 * A ceiling on how many people the walk may look at. Subjects are walked
 * rarest first, so what a truncation drops is the least informative end —
 * and without it a world where one subject is held by everybody would make
 * every other session on the thread wait for one person's rail.
 */
const DISCOVERY_BUDGET = 20_000;

/**
 * The group a subscription is in: the one whose own conversation it holds, or
 * null for the open world. The last one joined, if somebody is somehow in two.
 */
function groupIn(held) {
  let found = null;
  for (const subject of held) if (isGroupRoom(subject)) found = clusterOf(subject);
  return found;
}

/**
 * Whether a subject is in the same place as a person: inside their group, or
 * in the open world if they are in none. What is suggested, searched and
 * browsed stays on one side of that line — a group is not shown the busiest
 * rooms outside it, and nobody is shown another group's rooms at all.
 */
const scopedTo = (group) => (subject) => clusterOf(subject) === group;

/**
 * What a member of a group sees first of what they hold, when it is more than
 * the view has room for: the group's own conversation, which is the line round
 * everything else in it; then the rest of the group; then the world outside.
 * Nobody outside a group is ranked by anything but size.
 */
const groupFirst = (group) => (subject) => {
  if (!group || clusterOf(subject) !== group) return group ? 2 : 0;
  return isGroupRoom(subject) ? 0 : 1;
};

/** Region populations, canonically ordered — identical censuses, identical string. */
const censusSignature = (counts) =>
  [...counts]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k}:${n}`)
    .join('|');

export class World {
  constructor() {
    /** @type {Set<string>} */ this.subjects = new Set();
    /** @type {Map<string, {id: string, name: string}>} */ this.profiles = new Map();
    /** @type {Map<string, Set<string>>} */ this.members = new Map();
    /** @type {Map<string, Array>} */ this.messages = new Map();
    this._census = null;
    this._layouts = new Map();
    /** subject -> who holds it. An inverted index; see `audienceFor`. */
    this._holders = new Map();
    /** @type {Set<(event: object) => void>} */ this._watchers = new Set();
    /** roomKey -> reports about messages in it. See `report`. */
    /** @type {Map<string, Array>} */ this.reports = new Map();
    /** roomKey -> how many messages matched the word list; a hint, never a verdict. */
    /** @type {Map<string, number>} */ this.flagged = new Map();
    /** Rooms a moderator has looked at and judged fine, with when. */
    /** @type {Map<string, {at: number, by: string}>} */ this.cleared = new Map();
    /** Off unless an operator asks for it; see `watchWords`. */
    this._words = null;
    /**
     * Reports go to their own listeners, not to `watch`.
     *
     * `watch` is what feeds people's notifications, and a report is
     * confidential: who complained about whom is not something to put on the
     * same wire as "somebody said your name", where one future `if` in the
     * notification rules would hand it to the room. Two pipes, so that
     * mistaking one for the other has to be deliberate.
     */
    /** @type {Set<(report: object) => void>} */ this._reportWatchers = new Set();
    /** messageId -> who voted which way. One person, one vote, changeable. */
    /** @type {Map<string, Map<string, 1 | -1>>} */ this.votes = new Map();
    /**
     * Every deletion, in order, each entry bound to the one before it.
     *
     * Published so that a server which says it forgets on a schedule can be
     * checked against its own record, and caught if it goes back and edits
     * that record. It does not and cannot show that no copy was kept
     * elsewhere; see `lib/receipt.js`, which says so at more length.
     */
    /** @type {Array<object>} */ this.deletions = [];
    /**
     * Every message the server has ever seen, by hash, so that a copy handed
     * back later can be told from a forgery. Small: a commitment is the same
     * size whatever the message was.
     */
    /** @type {Map<string, {room: string, at: number, seq: number}>} */ this.committed = new Map();
    /** Where the two above are written down. Nothing durable unless set. */
    this.ledger = null;
  }

  // --- catalogue & membership -------------------------------------------

  addSubject(name) {
    // A cluster prefix is held aside while the rest is tidied up, then put
    // back. Normalising the whole string would treat `kite-fox-9/art` as one
    // long subject name and mangle it; the prefix is an address, not a word.
    const { cluster, subject: bare } = splitCluster(String(name ?? '').trim());
    if (cluster && !isCluster(cluster)) throw new Error('unusable cluster name');

    // `theory of entomology` and `modern entomology` are entomology. Splitting
    // one small community into three rooms over a turn of phrase is the kind
    // of fragmentation nobody would defend if asked directly.
    const tidied = normalise(bare, this.hierarchy ?? HIERARCHY);
    if (!/^[a-z0-9][a-z0-9 -]{0,30}$/.test(tidied)) throw new Error('unusable subject name');
    const subject = within(cluster, tidied);
    if (!this.subjects.has(subject) && this.subjects.size >= MAX_SUBJECTS) {
      throw new Error('the catalogue is full');
    }
    // No census change: a subject nobody holds occupies no region.
    this.subjects.add(subject);
    return subject;
  }

  /**
   * Somebody new. `synthetic` marks one of the sample people a demo world is
   * filled with rather than a person: they are the only ones the server will
   * ever write a machine question as, so that nobody real — online or not — is
   * made to seem to have asked something they did not. See `server/questions.js`.
   */
  addUser(name, options = {}) {
    const userId = id();
    // No census change either: they hold nothing yet.
    const profile = { id: userId, name: nameFrom(name) || 'anon' };
    if (options.synthetic) profile.synthetic = true;
    this.profiles.set(userId, profile);
    this.members.set(userId, new Set());
    return userId;
  }

  /** Change what somebody is called. An unusable name leaves the old one. */
  rename(userId, name) {
    const profile = this.profiles.get(userId);
    if (!profile) return null;
    profile.name = nameFrom(name) || profile.name;
    return profile.name;
  }


  subscription(userId) {
    return this.members.get(userId) ?? new Set();
  }

  join(userId, subject, options = {}) {
    if (!this.subjects.has(subject)) throw new Error(`no such subject: ${subject}`);
    const held = this.members.get(userId);
    if (!held || held.has(subject)) return;

    // Inside a group, the group's own conversation comes first. It wraps every
    // room in the group: everybody holding anything there holds it too, so
    // the group's rooms are always drawn inside its outline and a message to
    // the whole group reaches everybody in it. See `lib/cluster.js`.
    const cluster = clusterOf(subject);
    const wrap = cluster && !isGroupRoom(subject) ? groupRoom(cluster) : null;
    const wrapping = wrap !== null && !held.has(wrap);

    // The census enumerates every subset of a subscription up to arity three,
    // so its cost is cubic in how much one person holds. Unbounded, a single
    // client holding three hundred subjects builds four and a half million
    // regions and puts every view — everyone's, not just theirs — over a
    // second. Nobody is shown more than three subjects at once, so there is no
    // legitimate reason to hold a hundred.
    if (held.size + (wrapping ? 1 : 0) >= MAX_SUBSCRIPTIONS) {
      throw new Error(`you can hold at most ${MAX_SUBSCRIPTIONS} subjects — leave one first`);
    }

    if (wrapping) {
      if (!this.subjects.has(wrap)) this.addSubject(wrap);
      this.join(userId, wrap, { reach: 0 });
    }

    // Announce only once the membership is actually true. Emitting from inside
    // `#touch` meant a room was declared open while the person who opened it
    // was still, as far as the subscription was concerned, not in it — so the
    // containment check quite correctly refused to tell them about it, and the
    // one event this design has that no flat chat model does never fired.
    const opened = this.#touch(held, subject, +1);
    held.add(subject);
    this.#hold(subject).add(userId);
    this.#flush(opened);

    this.#funnel(userId, subject, options.reach ?? this.profiles.get(userId)?.reach ?? 0);
  }

  /**
   * Widen a join upward: also join the broader subjects this one sits inside.
   *
   * A catalogue of two hundred subfields is finer-grained than most
   * communities are large, so the person in entomology and the person in
   * mycology never meet — they share nothing, which is true of their subjects
   * and false of them. Reaching a step up puts them both in biology without
   * either having to claim their real interest is something broader.
   *
   * The broader room is created if it does not exist yet, because a funnel
   * that quietly does nothing when the field happens to be missing is worse
   * than no funnel.
   */
  #funnel(userId, subject, reach) {
    if (reach <= 0) return;
    const held = this.members.get(userId);

    // Inside a group the widening stays inside it: `kite-fox-9/painting`
    // widens into the group's own `visual art`, not into the open one, because
    // the group is a copy of the whole hierarchy and not a hole in it.
    const cluster = clusterOf(subject);
    for (const above of ancestorsOf(label(subject), knowledge, reach)) {
      const broader = within(cluster, above);
      if (!held || held.size >= MAX_SUBSCRIPTIONS) break;
      if (!this.subjects.has(broader)) {
        if (this.subjects.size >= MAX_SUBJECTS) break;
        this.subjects.add(broader);
      }
      this.join(userId, broader, { reach: 0 });
    }
  }

  /**
   * How far up a join should carry, for this person, from now on.
   *
   * A preference rather than a property of the subject: somebody who wants
   * only the people who share their exact interest and somebody who wants the
   * whole field are both asking for something reasonable.
   */
  setFunnel(userId, reach) {
    const profile = this.profiles.get(userId);
    if (!profile) return 0;
    profile.reach = Math.max(0, Math.min(2, Number(reach) || 0));
    return profile.reach;
  }

  funnel(userId) {
    return this.profiles.get(userId)?.reach ?? 0;
  }

  leave(userId, subject) {
    const held = this.members.get(userId);
    if (!held || !held.has(subject)) return;

    // Leaving a group's own conversation is leaving the group. Everything
    // inside it goes first, so no room of the group is ever held outside the
    // outline that wraps it — not even for the moment between two leaves.
    if (isGroupRoom(subject)) {
      const cluster = clusterOf(subject);
      for (const other of [...held]) {
        if (other !== subject && clusterOf(other) === cluster) this.leave(userId, other);
      }
    }

    held.delete(subject);
    const holders = this._holders.get(subject);
    if (holders) {
      holders.delete(userId);
      if (!holders.size) this._holders.delete(subject);
    }
    this.#flush(this.#touch(held, subject, -1));
  }

  /** Drop someone from the world entirely, region counts included. */
  removeUser(userId) {
    const held = this.members.get(userId);
    if (held) for (const subject of [...held]) this.leave(userId, subject);
    this.members.delete(userId);
    this.profiles.delete(userId);
  }

  /**
   * Fold one person's membership change into the census in place.
   *
   * Rebuilding meant re-expanding every member of the world into every region
   * they occupy — on a thousand interests that is tens of thousands of regions
   * recomputed because one person clicked join, and it dominated the cost of a
   * join entirely. But joining a subject can only affect regions that contain
   * that subject, and there are at most a handful of those: the subject alone,
   * plus each pair and triple it forms with what the person already held.
   *
   * `held` must exclude `subject` — the caller adds or removes it around this.
   */
  #touch(held, subject, delta) {
    // Every change of membership, counted, for whatever is worked out from
    // the census and kept: the census is the same Map before and after, with
    // the same size unless a region came or went, so neither says whether a
    // count inside it moved.
    this._changes = (this._changes ?? 0) + 1;
    if (!this._census) return []; // nothing built yet; the cold path will be right
    const events = [];

    const regions = [[subject]];
    for (const rest of subsets([...held], MAX_ARITY - 1)) {
      regions.push(canonical([...rest, subject]));
    }

    for (const region of regions) {
      const k = key(region);
      const next = (this._census.get(k) ?? 0) + delta;

      // A region that empties loses its key rather than keeping a zero. That
      // is the Euler property, and it has to survive incremental updates or
      // rooms would linger after the last person left them.
      //
      // Crossing that boundary in either direction is a room coming into or
      // going out of existence — something a flat chat model has no equivalent
      // of, and worth telling people about. It is known exactly here and
      // nowhere else, so it is announced from here.
      const existed = this._census.has(k);
      if (next > 0) this._census.set(k, next);
      else this._census.delete(k);

      if (!existed && next > 0) {
        events.push({ type: 'room-opened', room: k, subjects: region, population: next });
      } else if (existed && next <= 0) {
        events.push({ type: 'room-closed', room: k, subjects: region, population: 0 });
      }

      if (this._index) this.#reindex(region, k, next);
    }
    return events;
  }

  #hold(subject) {
    let holders = this._holders.get(subject);
    if (!holders) this._holders.set(subject, (holders = new Set()));
    return holders;
  }

  /** Announce a batch of events, once the change they describe has landed. */
  #flush(events) {
    for (const event of events) this.#announce(event);
  }

  /**
   * Listen to what happens in the world: rooms opening and closing, and
   * messages posted. Domain events, not transport — they carry no connection
   * and no socket, so a caller can turn them into frames, push notifications,
   * a webhook or a log.
   *
   * @param {(event: object) => void} listener
   * @returns {() => void} stop listening
   */
  watch(listener) {
    this._watchers.add(listener);
    return () => this._watchers.delete(listener);
  }

  #announce(event) {
    if (!this._watchers.size) return;
    const stamped = { at: now(), ...event };
    for (const listener of this._watchers) {
      // One bad listener must not break a join for everybody else.
      try {
        listener(stamped);
      } catch {
        /* a listener's problem is its own */
      }
    }
  }

  #reindex(region, k, population) {
    const index = this._index;

    if (region.length === 1) {
      if (population > 0) index.population.set(region[0], population);
      else index.population.delete(region[0]);
      if (!index.adjacency.has(region[0])) index.adjacency.set(region[0], new Set());
      index.dirty = true;
    } else if (region.length === 2) {
      const [a, b] = region;
      const edge = (from, to) => {
        const set = index.adjacency.get(from);
        if (!set) return;
        if (population > 0) set.add(to);
        else set.delete(to);
      };
      if (!index.adjacency.has(a)) index.adjacency.set(a, new Set());
      if (!index.adjacency.has(b)) index.adjacency.set(b, new Set());
      edge(a, b);
      edge(b, a);
    }
  }

  // --- the diagram -------------------------------------------------------

  /** Cached because every membership change invalidates it and reads are frequent. */
  census() {
    if (!this._census) {
      this._census = census([...this.members.values()], MAX_ARITY);
      this._index = null;
    }
    return this._census;
  }

  /**
   * Rebuilt once per census, not once per viewer — and after that kept up to
   * date in place. Only the popularity ordering is redone wholesale, because
   * sorting a thousand names costs a fraction of a millisecond whereas
   * rescanning the census costs tens.
   */
  index() {
    const counts = this.census();
    if (!this._index) this._index = buildIndex(counts);

    if (this._index.dirty) {
      const { population } = this._index;
      this._index.popular = [...population.keys()].sort(
        (a, b) => population.get(b) - population.get(a) || a.localeCompare(b),
      );
      this._index.dirty = false;
    }
    return this._index;
  }

  /**
   * Solving is the expensive step, and it depends only on the restricted
   * census — not on who is looking. Sessions sharing a neighbourhood share a
   * solve, which is what keeps a join from costing one full layout per
   * connected client. Keyed by the census contents, so an entry is either
   * correct or never consulted again; the cap is there to bound memory, not to
   * expire anything.
   */
  solve(local) {
    const signature = censusSignature(local);

    let solved = this._layouts.get(signature);
    if (!solved) {
      if (this._layouts.size > 256) this._layouts.clear();
      solved = layout(local);
      this._layouts.set(signature, solved);
    }
    return solved;
  }

  /** The group somebody is in, or null. See `groupIn`. */
  groupOf(userId) {
    return groupIn(this.subscription(userId));
  }

  /** Everything a view depends on, without paying for the geometry. */
  context(userId) {
    const counts = this.census();
    const held = this.subscription(userId);
    const { subjects, hidden, suggested } = neighbourhood(counts, held, MAX_ARITY, this.index(), {
      allowed: scopedTo(groupIn(held)),
      first: groupFirst(groupIn(held)),
    });
    return { held, subjects, hidden, suggested, local: restrict(counts, subjects) };
  }

  /**
   * A cheap fingerprint of what this person's screen would show.
   *
   * Solving is orders of magnitude more expensive than deciding whether a
   * solve is needed, and in a large world almost no membership change matters
   * to almost anybody: someone joining an obscure interest cannot move a
   * diagram that does not contain it. Comparing this against what a session
   * was last sent turns a broadcast from one layout per connected client into
   * one layout per client whose picture genuinely changed.
   */
  viewSignature(userId) {
    const { held, hidden, local } = this.context(userId);
    return [
      this.subjects.size, // the catalogue in the rail
      [...held].sort().join(','),
      hidden.join(','),
      censusSignature(local),
    ].join('#');
  }

  /**
   * The view for one person: never the whole world, always their own
   * neighbourhood, so the geometry stays inside the range where it can be true.
   */
  diagramFor(userId) {
    const { held, hidden, suggested, local } = this.context(userId);
    const solved = this.solve(local);

    const rooms = [...local]
      .map(([roomKey, population]) => {
        const tags = parse(roomKey);
        return {
          key: roomKey,
          subjects: tags,
          population,
          member: receives(held, tags),
          messages: (this.messages.get(roomKey) ?? []).length,
          stats: this.stats(roomKey),
        };
      })
      .sort((a, b) => a.subjects.length - b.subjects.length || a.key.localeCompare(b.key));

    return {
      ...solved,
      rooms,
      hidden,
      suggested,
      subscription: [...held].sort(),
      funnel: this.funnel(userId),
      rail: this.rail(held, suggested, { userId }),
    };
  }

  /**
   * What to list beside the diagram.
   *
   * Not the catalogue. A thousand interests is a thousand rows rebuilt on
   * every push, and it is the same mistake the diagram avoids by projecting to
   * a neighbourhood: a list of everything is a list of nothing. What a person
   * needs to hand is what they hold, what is being suggested to them, and a
   * few large rooms to fall into — anything else they can search for.
   */
  rail(held, suggested = [], options = {}) {
    const { popular = 12, discover = 5, userId = null, novelty } = options;
    const group = groupIn(held);
    const here = scopedTo(group);
    const mine = [...held].sort();
    const related = group ? this.#mirror(held, group, suggested) : suggested;
    const shown = new Set([...mine, ...related]);
    const index = this.index();

    // The group's own busiest first, then the busiest outside, as the group's
    // copies: a group of six has no popular rooms of its own on its first day.
    const busiest = index.popular.filter(here);
    if (group) {
      for (const s of index.popular) if (clusterOf(s) === null) busiest.push(within(group, s));
    }

    return {
      held: mine,
      suggested: related,
      popular: [...new Set(busiest)].filter((s) => !shown.has(s)).slice(0, popular),
      // Not filtered against the three lists above, and that is deliberate.
      // `popular` hides what is already shown because it is a fallback — a few
      // big rooms to fall into when nothing better is on offer. A discovery is
      // not a fallback: it is a room with people in it that this person cannot
      // reach today, and dropping the evidence because the same word appears
      // further up the rail would delete the one thing worth saying about it.
      discoveries: this.#discover(held, {
        limit: discover,
        novelty: this.#novelty(userId, novelty),
        allowed: here,
      }),
      // The catalogue, which a group has all of: every interest outside has
      // its copy inside, waiting for somebody in the group to open it.
      total: this.#catalogue(),
    };
  }

  /**
   * What the world outside would suggest, brought inside the group.
   *
   * A group of six is too few people for its own overlaps to say much; the
   * outside has thousands, and art sits beside philosophy out there because a
   * great many people hold both. So a group is offered its own suggestions
   * first and then exactly what somebody outside holding the same interests
   * would be offered — each as the group's copy. The structure of the world,
   * with the group's own people in it.
   */
  #mirror(held, group, own) {
    const twins = [...held].filter((s) => clusterOf(s) === group && !isGroupRoom(s)).map(label);
    const { suggested } = neighbourhood(this.census(), twins, MAX_ARITY, this.index(), {
      allowed: scopedTo(null),
    });
    const out = new Set(own);
    for (const s of suggested) {
      const copy = within(group, s);
      if (!held.has(copy)) out.add(copy);
    }
    return [...out];
  }

  /**
   * How many interests there are to choose from: the open catalogue, not
   * every group's copy of it counted again. Only recounted when something has
   * been added, since nothing is ever taken away.
   */
  #catalogue() {
    if (this._catalogue?.size !== this.subjects.size) {
      let open = 0;
      for (const s of this.subjects) if (clusterOf(s) === null) open += 1;
      this._catalogue = { size: this.subjects.size, open };
    }
    return this._catalogue.open;
  }

  /**
   * The novelty dial for one person: 0 goes deeper into what they already
   * hold, 1 reaches for something they got to through people but which sits
   * far away in the hierarchy.
   *
   * Zero by default rather than the middle, because that is what
   * `neighbourhood` defaults to and the two suggestion paths in one world
   * disagreeing about the same dial would be worse than either setting. The
   * middle belongs to `adapt`, where a missing column is a missing answer
   * rather than somebody's choice.
   */
  #novelty(userId, override) {
    const value = override ?? this.profiles.get(userId)?.novelty ?? 0;
    return Math.max(0, Math.min(1, Number(value) || 0));
  }

  /**
   * Subjects somebody does not hold, and the rooms joining one would open.
   *
   * Not "people who held what you hold also held this", which is a claim about
   * taste that any shop can make. It is that a room exists, with people
   * already in it, one subject away from where this person is standing: three
   * people in `entomology+mycology`, and they hold entomology. Rooms here are
   * derived from membership rather than enumerated, so that sentence is a fact
   * about the world and not a guess — and it is the discovery this shape of
   * product can make and a flat one structurally cannot.
   *
   * Ranked by rarity rather than by size, which is the whole difference
   * between this and `rail.popular`. That list is ordered by how many people
   * are in a room and is deliberately the other thing; a room of three
   * entomologists says far more about whoever would join it than a room of
   * four hundred people who all like art.
   *
   * **What it does not offer**, which matters more than what it does:
   *
   * - **The single-subject room.** Joining anything opens the room named after
   *   it, so every suggestion would carry the same fact about itself and none
   *   of them would carry any information. The rail lists subjects by size
   *   already; what nobody finds unaided is the overlap. The exception is
   *   somebody holding nothing at all, who has no overlaps to be one step
   *   from — see below.
   * - **Rooms that do not exist.** No combination is invented to be suggested.
   *   If nobody occupies `entomology+poetry` it is not offered, however good a
   *   pairing it sounds, because the point of the offer is that there are
   *   people in there.
   * - **A say in `viewSignature`.** Discoveries move on almost any membership
   *   change anywhere near a person, and putting them in the fingerprint would
   *   turn "redraw the few sessions whose picture moved" back into "redraw
   *   everybody". So a rail's discoveries can be a change or two out of date
   *   until something that person can actually see moves.
   *
   * @param {string} userId
   * @param {object} [options]
   * @param {number} [options.limit=5]    how many subjects to return
   * @param {number} [options.rooms=3]    how many rooms to carry per subject
   * @param {number} [options.novelty]    0 goes deeper, 1 reaches further out
   */
  discoveries(userId, options = {}) {
    const held = this.subscription(userId);
    return this.#discover(held, {
      allowed: scopedTo(groupIn(held)),
      ...options,
      novelty: this.#novelty(userId, options.novelty),
    });
  }

  /**
   * The walk behind `discoveries`, over a subscription rather than a person,
   * so the rail can ask for it without a second lookup.
   *
   * Cost is the reason this is written the way it is. It runs on every
   * membership change, on the only thread there is, in a world of a thousand
   * subjects and four thousand people — so there is no pass over the
   * population anywhere in it and nothing that is quadratic in anything large:
   *
   * 1. Candidates come from walking `_holders` for the subjects this person
   *    holds, rarest first and skipping the crowds. That is a few hundred
   *    people, not four thousand, and it is the only part that touches people
   *    at all.
   * 2. Whether a room exists, and how many are in it, is one lookup in the
   *    census. No set intersection is ever computed here — the census already
   *    counted every occupied region and is kept up to date in place.
   * 3. A triple can only be occupied if both of its pairs are, so the search
   *    for one runs over the subjects that already matched rather than over
   *    everything the person holds. Somebody holding thirty-two subjects has
   *    496 pairs and almost never more than two or three that matter.
   */
  #discover(held, options = {}) {
    const limit = Math.max(0, options.limit ?? 5);
    const perSubject = Math.max(1, options.rooms ?? 3);
    const novelty = Math.max(0, Math.min(1, options.novelty ?? 0));
    // Which side of a group's outline this person is on; see `scopedTo`.
    // Somebody in the open world who shares a room with a group's member is
    // not one subject away from that group.
    const allowed = options.allowed ?? (() => true);
    if (!limit) return [];

    const counts = this.census();
    const { population } = this.index();
    const people = Math.max(1, this.members.size);

    const idf = (s) => rarity(population.get(s) ?? 0, people);
    // A room is worth what it says about the people standing in it — how
    // unusual it is to hold all of its subjects — discounted only if there is
    // hardly anybody there. Rarity is the ranking; population is a floor under
    // it, and it stops counting at the size where a room stops being one.
    const worth = (specificity, n) =>
      specificity * Math.min(1, Math.log1p(n) / INTIMATE_SCALE);

    // Rarest first, so that a cap or a budget spends what it has on the
    // subjects that say the most about whoever holds them.
    const crowd = Math.max(CROWD_FLOOR, people * CROWD_SHARE);
    const mine = [...held]
      .filter((s) => population.has(s))
      .sort((a, b) => population.get(a) - population.get(b) || a.localeCompare(b));
    const bridges = mine.filter((s) => (this._holders.get(s)?.size ?? 0) <= crowd).slice(0, MAX_BRIDGES);
    // Worked out once rather than once per candidate, which is the difference
    // between a few thousand logarithms and a few dozen.
    const bridgeIdf = bridges.map(idf);

    const candidates = new Set();
    let visits = 0;
    for (const subject of bridges) {
      const holders = this._holders.get(subject) ?? EMPTY;
      if (visits >= DISCOVERY_BUDGET) break;
      visits += holders.size;
      for (const other of holders) {
        for (const theirs of this.members.get(other) ?? EMPTY) {
          if (!held.has(theirs) && allowed(theirs)) candidates.add(theirs);
        }
      }
    }

    const found = [];
    const matched = [];
    for (const subject of candidates) {
      const rooms = [];
      const self = idf(subject);
      // Which bridges this candidate already shares a room with. There is
      // always at least one, since it was reached through somebody standing in
      // both — and a triple can only be occupied if both of its pairs are, so
      // this is also the only place a triple can be hiding.
      matched.length = 0;
      for (let i = 0; i < bridges.length; i++) {
        const k = pairKey(bridges[i], subject);
        const n = counts.get(k);
        if (n === undefined) continue;
        matched.push(i);
        rooms.push({ key: k, population: n, weight: worth(self + bridgeIdf[i], n) });
      }
      for (let i = 0; i < matched.length; i++) {
        for (let j = i + 1; j < matched.length; j++) {
          const a = matched[i];
          const b = matched[j];
          const k = tripleKey(bridges[a], bridges[b], subject);
          const n = counts.get(k);
          if (n === undefined) continue;
          rooms.push({ key: k, population: n, weight: worth(self + bridgeIdf[a] + bridgeIdf[b], n) });
        }
      }
      if (rooms.length) found.push(this.#discovery(subject, rooms, population));
    }

    // Somebody holding nothing — everybody, once — is not one subject away
    // from any overlap, because there is no bridge for them to be standing on.
    // Neither is somebody whose every subject is held by nobody else. The only
    // honest evidence left is the room a subject is on its own, so that is
    // what is offered rather than an empty list or an invented pairing.
    //
    // Ranked with the population uncapped, which the rooms above deliberately
    // are not, because it is not the same question. Which room a step away is
    // worth the step is a question about how unusual it is; where to stand in
    // the first place is a question about where there is anybody to talk to.
    // Rarity still pulls against size, so what comes out is the middle —
    // subjects with enough people to have a conversation in and few enough to
    // be about something — rather than `rail.popular` a second time. Capped,
    // it would be a hundred subjects tied at eight people each and an answer
    // settled by the alphabet.
    if (!found.length) {
      for (const [subject, n] of population) {
        if (held.has(subject) || !allowed(subject)) continue;
        const room = { key: subject, population: n, weight: idf(subject) * Math.log1p(n) };
        found.push(this.#discovery(subject, [room], population));
      }
    }

    let strongest = 0;
    for (const entry of found) strongest = Math.max(strongest, entry.score);

    for (const entry of found) {
      // Scored against the strongest rather than in absolute terms, so that
      // novelty trades against it on the same scale whatever the size of the
      // world — the same bargain `neighbourhood` strikes, and the same sense:
      // 0 is the strongest overlap, 1 is somewhere reached through people but
      // a long way off in the hierarchy.
      const near = strongest > 0 ? entry.score / strongest : 0;
      let far = 0;
      if (novelty > 0 && mine.length) {
        for (const s of mine) far += APART(entry.subject, s);
        far = Math.min(1, far / mine.length);
      }
      // Rounded before it is sorted on, so that two genuinely equal scores are
      // equal numbers and the tie goes to the name rather than to whichever
      // way the last floating-point bit fell.
      entry.score = Math.round(((1 - novelty) * near + novelty * far) * 1000) / 1000;
    }

    found.sort((a, b) => b.score - a.score || a.subject.localeCompare(b.subject));
    return found.slice(0, limit).map((entry) => ({
      subject: entry.subject,
      population: entry.population,
      // Small enough to ride in a frame sent on every membership change: a
      // handful of subjects, a handful of rooms each, and nothing in any of
      // them that is not a string or a number.
      rooms: entry.rooms.slice(0, perSubject).map((room) => ({
        key: room.key,
        population: room.population,
      })),
      opens: entry.rooms.length,
      score: entry.score,
    }));
  }

  /** One candidate, with its rooms strongest first and their weights summed. */
  #discovery(subject, rooms, population) {
    rooms.sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));
    let score = 0;
    for (const room of rooms) score += room.weight;
    return { subject, population: population.get(subject) ?? 0, rooms, score };
  }

  /**
   * What a person needs to know, without drawing anything.
   *
   * The interface used to carry two pictures and this pushed a solved circle
   * layout to every session on every change to feed one of them. With only the
   * atlas left, that layout went to nobody — so this is the same information
   * minus the geometry, and the atlas is asked for when it is actually wanted.
   */
  stateFor(userId) {
    const { held, suggested } = this.context(userId);
    return {
      subscription: [...held].sort(),
      funnel: this.funnel(userId),
      rail: this.rail(held, suggested, { userId }),
    };
  }

  /**
   * The atlas: many subjects at once, drawn with routed boundaries.
   *
   * A different bargain from `diagramFor`. That one is a live surface and is
   * kept continuous — a join nudges a radius and nothing jumps — at the cost
   * of only ever showing three subjects and of circles inventing regions
   * nobody occupies. This one shows as many subjects as asked for and draws
   * exactly the occupied regions at exactly the right sizes, but is regrown
   * from scratch each time, so it is a snapshot to be asked for rather than a
   * surface to live on.
   */
  atlasFor(userId, limit = 5) {
    const counts = this.census();
    const held = this.subscription(userId);
    const { subjects } = neighbourhood(counts, held, limit, this.index(), {
      allowed: scopedTo(groupIn(held)),
      first: groupFirst(groupIn(held)),
    });
    const group = groupIn(held);
    const { view, shape, rooms, room } = this.#drawn(subjects, held, group);

    // The group's own conversation, whether or not it has ground of its own.
    // It wraps the group, so as soon as everybody in it holds something else
    // too, nobody holds it alone and it has no patch of the map to be opened
    // from — and the one room the whole group can talk in would vanish from
    // the list of rooms exactly when the group got going.
    const own = group ? groupRoom(group) : null;
    if (own && !rooms.some((r) => r.key === own)) rooms.push(room(own, [own], 0));

    // Every other chat they are in, drawn on this map or not. Holding more
    // interests than the map draws left some of somebody's own chats with no
    // way in at all; these are listed beside the map, flagged, since they
    // have no ground on it to be found on. The busiest hundred, so a person
    // holding thirty interests is not sent five thousand.
    const drawn = new Set(rooms.map((r) => r.key));
    const theirs = [];
    for (const region of subsets([...held], MAX_ARITY)) {
      // Joined by hand: `key` in here is the drawing's, not the room's.
      const k = canonical(region).join('+');
      // With somebody else in it: a chat of one is not a chat.
      if (!drawn.has(k) && (counts.get(k) ?? 0) > 1) theirs.push({ ...room(k, region, 0), offMap: true });
    }
    theirs.sort((a, b) => b.activity - a.activity || b.population - a.population || (a.key < b.key ? -1 : 1));
    rooms.push(...theirs.slice(0, OFF_MAP_KEPT));

    // How busy each room is, and whether they are in it, afresh every time:
    // those are what change between one ask and the next.
    return { ...view, shape, subscription: [...held].sort(), rooms, communities: this.#communitiesOf(subjects) };
  }

  /**
   * The map branched out from one interest into a community: the interest,
   * and the community's interests most linked with it, drawn as the atlas
   * draws anything. Somebody's own map says where they are; this says where
   * they could go from there, and what they would find, before they go.
   *
   * `toward` names another community by any interest in it — one of those
   * nearest `from`'s own — and then it is that community's interests most
   * linked with `from`'s that are drawn beside `from`: the ones that bridge
   * the two. Without it, `from`'s own community.
   *
   * Nothing is joined. Their own rooms in it are theirs as always, and the
   * rest are drawn as rooms they are not in yet, to open, look in on and join
   * like any other. The open world only: a community is read off links, and
   * nothing inside a group is ever linked.
   *
   * @returns {object | null}  an atlas with `branch` saying what it is, or null
   *   where there is nothing to branch into
   */
  branchFor(userId, from, { toward = null, limit = 5 } = {}) {
    const start = String(from ?? '');
    const aim = toward == null ? start : String(toward);
    if (!this.subjects.has(start) || clusterOf(start) !== null || clusterOf(aim) !== null) return null;
    const { list, of } = this.communities();
    const target = of.get(aim);
    if (target === undefined) return null;

    // What the branch grows from: the interest, or, into a community next to
    // its own, the whole of its own.
    const home = of.get(start);
    const origin = home !== undefined && home !== target ? new Set(list[home].members) : new Set([start]);
    const pull = new Map();
    for (const [a, b, , share] of this._communities.links) {
      if (origin.has(a) && of.get(b) === target) pull.set(b, (pull.get(b) ?? 0) + share);
      if (origin.has(b) && of.get(a) === target) pull.set(a, (pull.get(a) ?? 0) + share);
    }
    const { population } = this.index();
    const chosen = list[target].members
      .filter((s) => s !== start)
      .sort(
        (a, b) =>
          (pull.get(b) ?? 0) - (pull.get(a) ?? 0) ||
          (population.get(b) ?? 0) - (population.get(a) ?? 0) ||
          (a < b ? -1 : 1),
      )
      .slice(0, Math.max(1, limit - 1));
    const subjects = [start, ...chosen];

    const held = this.subscription(userId);
    const { view, shape, rooms } = this.#drawn(subjects, held, null);
    return {
      ...view,
      shape,
      subscription: [...held].sort(),
      rooms,
      communities: this.#communitiesOf(subjects),
      branch: {
        from: start,
        toward: toward == null ? null : aim,
        // With everything in it, not only what is drawn: what is offered to
        // be joined is the community, and the map can only draw a handful.
        community: { ...briefly(list[target]), members: list[target].members.slice(0, COMMUNITY_OFFERED) },
      },
    };
  }

  /**
   * Communities of interests, read off the links; see `lib/communities.js`.
   * Worked out again only when who holds what changes, as the chart is.
   */
  communities() {
    const counts = this.census();
    const cached = this._communities;
    if (cached?.census === counts && cached.changes === this._changes && cached.subjects === this.subjects.size) {
      return cached.value;
    }
    // The open world only, as for everything else on the sheet.
    const links = associations(counts, { open: (s) => clusterOf(s) === null });
    const value = findCommunities(links, this.index().population);
    this._communities = { census: counts, changes: this._changes, subjects: this.subjects.size, links, value };
    return value;
  }

  /**
   * The community each of some interests is in, and the ones nearest it, for
   * a map to offer branching into. Only those in one.
   */
  #communitiesOf(subjects) {
    const { list, of } = this.communities();
    const out = {};
    for (const s of subjects) {
      const i = of.get(s);
      if (i === undefined) continue;
      out[s] = { ...briefly(list[i]), near: list[i].near.slice(0, NEAR_OFFERED).map((j) => briefly(list[j])) };
    }
    return out;
  }

  /**
   * Some subjects drawn: the shapes, and a room for each patch of them.
   *
   * @returns {{view: object, shape: string, rooms: object[], room: Function}}  `room`
   *   makes a room like the others, for one with no patch of its own
   */
  #drawn(subjects, held, group) {
    // Anchored to the knowledge hierarchy, so the map keeps its shape as people
    // come and go instead of rearranging itself around whoever is here now.
    // Inside a group each subject is anchored where its outside twin is, so
    // the group is drawn as the same map with its own people on it.
    const regions = zones([...this.members.values()], subjects);

    // The drawing is a function of nothing but which subjects are in it, how
    // many hold each region of them, and the group round them, so it is
    // solved once for those and kept. Every open page asks again every ten
    // seconds for how busy the rooms are, and solving each time was a tenth
    // to a fifth of a second, per page, of the only thread there is. `shape`
    // names the drawing, so a page that has it already need not be sent it.
    const key = JSON.stringify([subjects, [...regions].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)), group]);
    this._atlases ??= new Map();
    let solved = this._atlases.get(key);
    if (solved) {
      // Most recently used last, so the oldest is the first to go.
      this._atlases.delete(key);
    } else {
      solved = {
        view: atlas(regions, {
          anchors: anchorsFor(subjects, this.hierarchy ?? HIERARCHY),
          // The group's own conversation wraps its rooms: drawn round them,
          // and left out of where they go, so they are laid out as they are
          // outside.
          frames: group ? [groupRoom(group)] : [],
        }),
        shape: createHash('sha1').update(key).digest('hex').slice(0, 16),
      };
    }
    this._atlases.set(key, solved);
    if (this._atlases.size > ATLASES_KEPT) this._atlases.delete(this._atlases.keys().next().value);
    const { view, shape } = solved;

    const room = (key, subjects, here) => ({
      key,
      subjects,
      // Both numbers matter and they differ: the ground a zone occupies is
      // the people holding exactly it, while the room it opens reaches
      // everyone holding at least it.
      here,
      population: this.populationOf(key),
      member: receives(held, subjects),
      messages: (this.messages.get(key) ?? []).length,
      stats: this.stats(key),
      // How high the map raises it: how lively it has been lately, against
      // the liveliest room on the platform; see `activity`.
      activity: lively.rooms.get(key) ?? 0,
    });
    const lively = this.activity();
    const rooms = view.zones.map((zone) => room(zone.key, zone.subjects, zone.population));
    return { view, shape, rooms, room };
  }

  /**
   * Every occupied subject at its place in the hierarchy — the whole map, not
   * a neighbourhood of it.
   *
   * The atlas can only draw a handful of subjects legibly, so a view is always
   * a few of them; that leaves someone with no idea what else is out there or
   * whereabouts in it they are. This is the overview the minimap draws: small
   * enough to send whole, complete enough that nothing is missing from it.
   *
   * Subjects the hierarchy has never heard of still appear. They are given a
   * deterministic place on an outer ring rather than dropped, so the ring
   * reads as exactly what it is — everything not yet classified — and the
   * promise that every subject is somewhere on the map holds.
   */
  overview() {
    const counts = this.census();
    if (this._overview?.census === counts && this._overview.changes === this._changes) {
      return this._overview.value;
    }

    const { population } = this.index();
    // The open world only. A group's rooms are copies of the ones outside,
    // sitting on exactly the same spots, and are nobody else's business.
    const placed = this.#place([...population].filter(([id]) => clusterOf(id) === null));
    const value = { subjects: placed, extent: EXTENT, classified: placed.filter((s) => s.known).length };
    this._overview = { census: counts, changes: this._changes, value };
    return value;
  }

  /**
   * Subjects at their places in the hierarchy, and the ones it has never heard
   * of round an outer ring rather than dropped.
   *
   * @param {Array<[string, number]>} entries  subject and how many hold it
   */
  #place(entries) {
    const where = this.hierarchy ?? HIERARCHY;
    // Fanned, so the facets of one subject are distinguishable rather than
    // stacked invisibly on top of it.
    const anchors = anchorsFor(entries.map(([id]) => id), where);
    const placed = [];
    const strays = [];

    for (const [id, n] of entries) {
      const at = anchors.get(id);
      if (at) placed.push({ id, n, x: Math.round(at.x), y: Math.round(at.y), known: true });
      else strays.push({ id, n });
    }

    // The unclassified ring, ordered by name so it does not reshuffle.
    strays.sort((a, b) => a.id.localeCompare(b.id));
    const radius = EXTENT * 0.46;
    strays.forEach((s, i) => {
      const angle = ((i + 0.5) / strays.length) * Math.PI * 2;
      placed.push({
        id: s.id,
        n: s.n,
        x: Math.round(Math.cos(angle) * radius),
        y: Math.round(Math.sin(angle) * radius),
        known: false,
      });
    });
    return placed;
  }

  /**
   * The whole catalogue on one sheet, for finding a way round it.
   *
   * The overview is what the minimap draws: every subject somebody holds, to
   * say where the people are. This is for somebody looking for what to join,
   * so it is every interest there is, held or not, with the names of the
   * divisions and fields written over the patches of the map they cover — the
   * same catalogue the interests list walks a level at a time, laid out flat.
   *
   * Only the open world, as everywhere a catalogue is shown: a group's copies
   * sit exactly where the originals do and are the group's business. Cached
   * against the census, so it is worked out once per change of membership and
   * only when somebody asks.
   */
  chart() {
    const counts = this.census();
    if (
      !(
        this._chartBase?.census === counts &&
        this._chartBase.changes === this._changes &&
        this._chartBase.subjects === this.subjects.size
      )
    ) {
      this._chartBase = { census: counts, changes: this._changes, subjects: this.subjects.size, value: this.#chartBase(counts) };
      this._chart = null;
    }
    if (this._chart && this._chart.said === this._said) return this._chart.value;

    // How lively each has been lately, against the liveliest; the height the
    // explorer raises it to. Left off where it is nought, which is most. Put
    // on the sheet afresh after every message, which is all a message changes.
    const base = this._chartBase.value;
    const lively = this.activity().subjects;
    const value = {
      ...base,
      subjects: base.subjects.map((s) => {
        const a = lively.get(s.id);
        return a ? { ...s, a } : s;
      }),
    };
    this._chart = { said: this._said, value };
    return value;
  }

  /**
   * The chart without how lively anything is: where every interest goes, how
   * many hold it, what it is under, the names over the patches and the links.
   * Worked out again only when who holds what changes. `shape` names it, so a
   * page that has this one already is sent only how lively each is.
   */
  #chartBase(counts) {
    const { population } = this.index();
    const open = [...this.subjects].filter((s) => clusterOf(s) === null);
    const placed = this.#place(open.map((id) => [id, population.get(id) ?? 0]));

    // Where each division and field is: the middle of everything under it,
    // which is where its name reads as the name of that patch.
    const sums = new Map();
    for (const subject of placed) {
      subject.up = [];
      for (let at = knowledge[subject.id]; at && at in knowledge; at = knowledge[at]) {
        subject.up.push(at);
        const sum = sums.get(at) ?? { x: 0, y: 0, count: 0 };
        sum.x += subject.x;
        sum.y += subject.y;
        sum.count += 1;
        sums.set(at, sum);
      }
    }
    const depthOf = (name) => {
      let depth = 0;
      for (let at = name; at && at in knowledge; at = knowledge[at]) depth += 1;
      return depth;
    };
    const labels = [];
    for (const [name, { x, y, count }] of sums) {
      const depth = depthOf(name);
      if (depth !== 1 && depth !== 2) continue;
      labels.push({ name, x: Math.round(x / count), y: Math.round(y / count), depth, count });
    }

    // Which of them people hold together; see `lib/association.js`. The open
    // world only, as for everything else on the sheet. And the communities
    // those make, each interest marked with the one it is in.
    const { list, of } = this.communities();
    const { links } = this._communities;
    for (const subject of placed) {
      const c = of.get(subject.id);
      if (c !== undefined) subject.c = c;
    }
    const found = list.map((c) => ({ name: c.name, size: c.members.length, near: c.near.slice(0, NEAR_OFFERED) }));

    const shape = createHash('sha1').update(JSON.stringify([placed, labels, links, EXTENT])).digest('hex').slice(0, 16);
    return { subjects: placed, labels, links, communities: found, extent: EXTENT, shape };
  }

  /**
   * How lively each room and each interest has been lately, from 0 to 1
   * against the liveliest on the platform: what the map and the explorer
   * raise things by. See `lib/activity.js` for what counts and why.
   *
   * Worked out again only when a message comes or goes. Every message ages
   * at the same rate, so between those the answer does not change.
   */
  activity() {
    if (this._activity && this._activity.said === this._said) return this._activity.value;
    const value = activity(this.messages, {
      skip: isPortalRoom,
      open: (subject) => clusterOf(subject) === null,
    });
    this._activity = { said: this._said, value };
    return value;
  }

  /** Something was said or unsaid: what depends on the messages is stale. */
  #said() {
    this._said = (this._said ?? 0) + 1;
  }

  /**
   * One room as somebody outside it sees it: a lurker, come in by a quick-join
   * code (see `lib/lurk.js`). What is said in it, how many are in it, and how
   * busy it is — everything the open read API would hand anybody anyway, since
   * this place is public — and nothing about who is watching, because nothing
   * here records that they are.
   *
   * Null for anything that could not be a room, and for a portal: those are
   * not found, and a quick-join code is a way of finding.
   */
  look(roomKey) {
    const room = watchable(roomKey);
    if (!room) return null;
    const subjects = parse(room);
    return {
      room,
      subjects,
      // Whether there is anything there yet. A code can outlive the room it
      // was made for, or be made for one nobody has opened.
      here: subjects.every((s) => this.subjects.has(s)),
      population: this.populationOf(room),
      stats: this.stats(room),
      messages: [...(this.messages.get(room) ?? [])],
    };
  }

  /**
   * How busy a room is, and what was said in it last.
   *
   * A population on its own does not tell anybody whether it is worth walking
   * into: forty people who last spoke in March is a different room from four
   * who are talking now. Counted from the tail of the log, so the cost is the
   * length of the recent window rather than the length of the history.
   */
  stats(roomKey, window = 5 * 60_000) {
    const log = this.messages.get(roomKey);
    if (!log?.length) return { messages: 0, perMinute: 0, last: null };

    const since = now() - window;
    let recent = 0;
    for (let i = log.length - 1; i >= 0; i--) {
      if (log[i].at < since) break;
      recent++;
    }

    const latest = log[log.length - 1];
    return {
      messages: log.length,
      perMinute: Number((recent / (window / 60_000)).toFixed(2)),
      last: {
        author: latest.author,
        body: latest.body.slice(0, 120),
        at: latest.at,
        // So the card that shows it can say a machine wrote it.
        ...(latest.machine ? { machine: true } : {}),
      },
    };
  }

  /**
   * Substring search, largest rooms first.
   *
   * Over the whole catalogue rather than the census, so an interest that has
   * emptied out can still be found and revived — it is absent from the map,
   * not from the world.
   *
   * A word that is another name for something here finds that thing, and
   * finds it first: `soccer` is `football`, and somebody who is shown nothing
   * for it makes an empty room called `soccer` next door to the full one.
   */
  searchSubjects(query, limit = 20, options = {}) {
    const needle = String(query ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!needle) return [];
    const { population } = this.index();
    const group = options.group ?? null;

    // The exact word outranks everything. A word only begun finds it too, but
    // from three letters: `ar` is augmented reality and also most of `art`.
    const meant = new Set();
    const named = alsoCalled[needle];
    if (named && this.subjects.has(named)) meant.add(named);
    const begun = new Set();
    if (needle.length >= 3) {
      for (const [word, subject] of Object.entries(alsoCalled)) {
        if (word.startsWith(needle) && this.subjects.has(subject)) begun.add(subject);
      }
    }

    // The open catalogue is what is searched, in a group as out of it: a group
    // has a copy of every interest, and somebody else's group has nothing to
    // do with either. Inside a group each match comes back as the group's
    // copy, counted by the group's own people, along with anything the group
    // made up that the outside has no word for.
    const names = new Set();
    for (const s of this.subjects) {
      const cluster = clusterOf(s);
      if (cluster !== null && cluster !== group) continue;
      const name = label(s);
      if (name.includes(needle) || meant.has(name) || begun.has(name)) names.add(name);
    }

    const here = (name) => population.get(within(group, name)) ?? 0;
    const outside = (name) => population.get(name) ?? 0;
    const rank = (s) => (meant.has(s) ? 0 : s === needle ? 1 : 2);
    return [...names]
      .sort(
        (a, b) =>
          rank(a) - rank(b) ||
          here(b) - here(a) ||
          outside(b) - outside(a) ||
          a.localeCompare(b),
      )
      .slice(0, limit)
      .map((name) => ({ id: within(group, name), population: here(name) }));
  }

  /**
   * One level of the catalogue: what sits directly under a category.
   *
   * Search finds a thing somebody can already name. This is for everybody
   * else — the person who arrives with no word in mind and wants to see what
   * there is. A thousand names is not a list anybody reads, so it is walked a
   * level at a time: the dozen broad divisions, the fields in one of them,
   * the interests in one of those.
   *
   * Only what this world actually has. The hierarchy says where things sit;
   * the catalogue says what exists, and a host that stocked its own short
   * list is shown that list, arranged, rather than a thousand rooms it never
   * asked for.
   *
   * Inside a group it is the same tree, because a group is a copy of all of
   * it: every row is the group's copy of that interest, with the group's own
   * head count, and joining one opens it for the group.
   *
   * @param {string|null} [at]  a category, or nothing for the top
   * @param {{group?: string|null}} [options]  the group being browsed from
   */
  browse(at = null, options = {}) {
    const group = options.group ?? null;
    const wanted = at === null || at === undefined ? '' : label(String(at).trim().toLowerCase());
    const here = wanted && wanted in knowledge ? wanted : null;
    const { population } = this.index();
    const count = (name) => population.get(within(group, name)) ?? 0;

    // The way back up, broadest first, without the root nobody can join.
    const path = [];
    for (let up = here; up && up in knowledge; up = knowledge[up]) path.unshift(up);

    const children = (UNDER.get(here ?? 'knowledge') ?? [])
      .filter((name) => this.subjects.has(name))
      .map((name) => {
        const beneath = (UNDER.get(name) ?? []).filter((kid) => this.subjects.has(kid));
        // A few of what is in it, so a category says what it is for before it
        // is opened: `sport` is a word, `team sports, motorsport` is a reason.
        // The busiest first and then the biggest, since the first three in
        // the alphabet are nobody's idea of what a category is about.
        const telling = [...beneath].sort(
          (a, b) =>
            count(b) - count(a) ||
            (population.get(b) ?? 0) - (population.get(a) ?? 0) ||
            inside(b) - inside(a) ||
            a.localeCompare(b),
        );
        return {
          id: within(group, name),
          population: count(name),
          inside: beneath.length ? inside(name) : 0,
          sample: telling.slice(0, 3),
        };
      });

    return { at: here, path, children };
  }

  // --- messages ----------------------------------------------------------

  /**
   * Forget everything older than the retention window.
   *
   * By looking at every message rather than assuming the old ones are a
   * prefix. Logs are appended to and timestamps are monotonic, so in practice
   * they are in order — but "in practice" is a poor thing for a promise about
   * deletion to rest on, and a single message out of order would have left
   * everything before it sitting there for good. Filtering costs the same.
   */
  forgetOld(now = Date.now()) {
    const cutoff = now - KEEP_FOR;
    let dropped = 0;
    const gone = [];

    for (const [roomKey, log] of this.messages) {
      const keep = log.filter((message) => message.at >= cutoff);
      if (keep.length === log.length) continue;

      for (const message of log) if (message.at < cutoff) gone.push(message);
      dropped += log.length - keep.length;
      if (keep.length) this.messages.set(roomKey, keep);
      else this.messages.delete(roomKey);
      this.#said();
    }

    if (gone.length) this.#receipt(gone, 'expired');

    // A vote is about a message, so it goes when the message does. Keeping
    // them would slowly fill memory with tallies nothing can display.
    const alive = new Set();
    for (const log of this.messages.values()) for (const m of log) alive.add(m.id);
    for (const messageId of [...this.votes.keys()]) {
      if (!alive.has(messageId)) this.votes.delete(messageId);
    }

    // Reports go too, on their own longer clock. Sweeping them here rather
    // than somewhere else means there is one answer to "when does the server
    // forget", not two that can drift apart.
    const reportCutoff = now - REPORTS_KEEP_FOR;
    for (const [roomKey, list] of this.reports) {
      const keep = list.filter((report) => report.at >= reportCutoff);
      if (keep.length === list.length) continue;

      dropped += list.length - keep.length;
      if (keep.length) this.reports.set(roomKey, keep);
      else {
        this.reports.delete(roomKey);
        this.flagged.delete(roomKey);
      }
    }
    return dropped;
  }

  /**
   * Write one deletion into the chain.
   *
   * Each message is named by a hash of itself rather than by its text, so the
   * receipt can be handed to anybody without handing them the conversation:
   * only somebody who already kept the message can recognise it here.
   */
  /**
   * Write to whatever durable place has been given, if any.
   *
   * Silent when there is none: a world with no ledger is the ordinary
   * in-memory case, and it works exactly as before.
   */
  #record(entry) {
    try {
      this.ledger?.append(entry);
    } catch (err) {
      // Losing the anchor for one message is bad; refusing to carry the
      // conversation because the disk is full is worse.
      console.error('eulerchat: could not write to the ledger -', err.message);
    }
    return entry;
  }

  /**
   * Attach a durable ledger and read back what it already holds.
   *
   * Only commitments and deletions come back. The messages themselves are not
   * here and are not meant to be; they come from the people who kept them,
   * and `restore` is what checks them against this.
   */
  useLedger(ledger = new MemoryLedger()) {
    if (!isLedger(ledger)) throw new Error('a ledger needs append() and load()');
    this.ledger = ledger;

    for (const entry of ledger.load()) {
      if (entry.kind === 'post') {
        this.committed.set(entry.commitment, {
          room: entry.room,
          at: entry.at,
          seq: entry.seq ?? this.committed.size,
        });
      } else if (entry.kind === 'delete') {
        this.deletions.push(entry.receipt);
      }
    }
    return {
      messages: this.committed.size,
      deletions: this.deletions.length,
    };
  }

  /**
   * Take back copies people kept, and accept only what can be proved.
   *
   * Each candidate is hashed the same way it was hashed when it was posted. If
   * that hash is not in the ledger the message is not one this server ever
   * saw, whatever it claims about itself - so a forged message, or a genuine
   * one with a word changed, or one attributed to somebody who did not write
   * it, all fail here rather than being taken on trust.
   *
   * Two further refusals, which are the ones that make this safe to offer at
   * all. A message named in the deletion chain does not come back: somebody
   * pressed delete, or it aged out, and a restart must not be a way of undoing
   * that. And a message older than the retention window does not come back
   * either, even if it was never explicitly deleted, because the promise was
   * twelve hours rather than twelve hours and a restart.
   *
   * @returns {{restored: number, refused: {unknown: number, deleted: number, expired: number, duplicate: number}}}
   */
  restore(messages, { now: at = now() } = {}) {
    const refused = { unknown: 0, deleted: 0, expired: 0, duplicate: 0 };
    const buried = new Set(this.deletions.flatMap((entry) => entry.commitments ?? []));
    let restored = 0;

    for (const candidate of messages ?? []) {
      const message = this.#asMessage(candidate);
      if (!message) {
        refused.unknown += 1;
        continue;
      }

      const mark = sha(commitmentInput(message));
      const anchor = this.committed.get(mark);
      if (!anchor) {
        refused.unknown += 1;
        continue;
      }
      // Where it sat when it was said, which the client does not get a vote on.
      message.seq = anchor.seq;
      if (buried.has(mark)) {
        refused.deleted += 1;
        continue;
      }
      if (at - message.at > KEEP_FOR) {
        refused.expired += 1;
        continue;
      }

      const log = this.messages.get(message.room) ?? [];
      if (log.some((held) => held.id === message.id)) {
        refused.duplicate += 1;
        continue;
      }

      log.push(message);
      log.sort((a, b) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0));
      this.messages.set(message.room, log);
      this.#said();
      restored += 1;
    }

    return { restored, refused };
  }

  /**
   * A candidate from a browser, reduced to the fields a message actually has.
   *
   * Anything else it carries is dropped rather than trusted. Only the fields
   * below go into the hash, so a client that adds its own are not smuggling
   * them in - they would simply fail to match.
   */
  #asMessage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const room = String(raw.room ?? '');
    const subjects = parse(room);
    if (!subjects.length || !raw.id || !Number.isFinite(raw.at)) return null;

    for (const subject of subjects) this.subjects.add(subject);

    const message = {
      id: String(raw.id),
      room,
      subjects,
      author: String(raw.author ?? 'anon'),
      authorId: String(raw.authorId ?? ''),
      body: raw.sealed ? '' : String(raw.body ?? ''),
      at: Number(raw.at),
      restored: true,
    };
    if (raw.sealed) {
      message.sealed = true;
      message.envelope = raw.envelope ?? null;
    }
    if (raw.replyTo) message.replyTo = raw.replyTo;
    // Which form it claims to be named by, and the key it claims was beside
    // the name. Both are claims, and both are in the hash: say the wrong form,
    // or a different key, and the result is a hash the server never wrote.
    //
    // The key is only taken together with the second form. The first form
    // does not cover it, so a first-form copy carrying a key would be a
    // genuine message with an unchecked signature stuck on.
    if (raw.v === 2) {
      message.v = 2;
      if (raw.authorKey) message.authorKey = String(raw.authorKey);
      // Also a claim, also in the hash: a machine question handed back without
      // its label, or a person's words handed back with one, does not match.
      if (raw.machine) message.machine = true;
    }
    return message;
  }

  #receipt(messages, reason) {
    const previous = this.deletions.at(-1)?.hash ?? '';
    const entry = {
      seq: this.deletions.length,
      at: now(),
      reason,
      count: messages.length,
      commitments: messages.map((m) => sha(commitmentInput(m))),
      previous,
    };
    entry.hash = sha(entryInput(entry));
    this.deletions.push(entry);
    this.#record({ kind: 'delete', receipt: entry });
    // Said to whoever keeps copies on the place's behalf, so that they forget
    // too: the open side's dumps, which must not outlive what is in them.
    // Each with its commitment, for telling the world by that rather than by
    // its id.
    this.#announce({
      type: 'forgotten',
      reason,
      seq: entry.seq,
      hash: entry.hash,
      messages: messages.map((m, i) => ({ id: m.id, room: m.room, commitment: entry.commitments[i] })),
    });
    return entry;
  }

  /**
   * Delete a single message now, on request, with a receipt like any other.
   *
   * Somebody asking for their own words back is the commonest reason anything
   * gets deleted early, and it should leave the same trail as the clock does.
   */
  forget(userId, messageId) {
    const found = this.#findMessage(messageId);
    if (!found) throw new Error('no such message, or it has already been forgotten');
    if (found.message.authorId !== userId) throw new Error('you can only delete your own');

    const log = this.messages.get(found.roomKey).filter((m) => m.id !== messageId);
    if (log.length) this.messages.set(found.roomKey, log);
    else this.messages.delete(found.roomKey);
    this.#said();
    this.votes.delete(messageId);

    return this.#receipt([found.message], 'asked');
  }

  /** The deletion chain, for anybody who wants to check it. */
  receipts({ since = 0 } = {}) {
    return this.deletions.filter((entry) => entry.seq >= since);
  }

  // --- votes -------------------------------------------------------------

  /**
   * Up, down, or neither.
   *
   * One person one vote, and changing your mind replaces your vote rather than
   * adding to it. Voting the same way twice takes the vote back, which is what
   * people expect from a button that is already lit.
   *
   * Votes are not moderation. A message everybody dislikes is not a message
   * that broke a rule, and nothing here feeds `concerns` - the two would
   * corrupt each other, since the quickest way to get somebody moderated would
   * otherwise be to organise a few friends.
   */
  vote(userId, messageId, value) {
    if (!this.profiles.has(userId)) throw new Error('no such person');
    const found = this.#findMessage(messageId);
    if (!found) throw new Error('no such message, or it has already been forgotten');
    if (!receives(this.subscription(userId), found.message.subjects)) {
      throw new Error(`you are not in ${found.roomKey}`);
    }

    const wanted = Number(value) > 0 ? 1 : Number(value) < 0 ? -1 : 0;
    const cast = this.votes.get(messageId) ?? new Map();

    if (!wanted || cast.get(userId) === wanted) cast.delete(userId);
    else cast.set(userId, wanted);

    if (cast.size) this.votes.set(messageId, cast);
    else this.votes.delete(messageId);

    return { messageId, room: found.roomKey, ...this.tally(messageId, userId) };
  }

  /** How a message stands, and how this person voted on it. */
  tally(messageId, userId = null) {
    const cast = this.votes.get(messageId);
    if (!cast) return { up: 0, down: 0, score: 0, yours: 0 };

    let up = 0;
    let down = 0;
    for (const value of cast.values()) if (value > 0) up += 1; else down += 1;
    return { up, down, score: up - down, yours: (userId && cast.get(userId)) || 0 };
  }

  // --- reports -----------------------------------------------------------

  /**
   * Turn on the word scanner, with whatever vocabulary the operator brings.
   *
   * Off by default. It cannot see sealed messages at all, it cannot tell a
   * quotation from an insult, and in a place with channels for criminology and
   * linguistics it will find the subject of the room. What it produces is a
   * hint that somebody might look, which is why its contribution to a room's
   * standing is capped. Passing nothing turns it off again.
   */
  watchWords(words = DEFAULT_WORDS) {
    this._words = words ?? null;
    return Boolean(this._words);
  }

  /**
   * Somebody says a message is wrong.
   *
   * The report copies the message into itself, and that is worth being plain
   * about: it is how the complaint survives the twelve hours, and it is the
   * one place where saying something and it being forgotten come apart. The
   * person reporting is told.
   *
   * For a sealed message the server has nothing to copy — it never could read
   * it — so the reporter's own client sends the text it was able to decrypt.
   * That is a person choosing to show a moderator something that was private,
   * which is theirs to choose and nobody else's, and it is recorded as a
   * disclosure rather than as something the server knew.
   *
   * @param {string} userId    who is reporting
   * @param {string} messageId which message
   * @param {string} reason    one of REASONS
   * @param {{disclosed?: string, note?: string}} [options]
   */
  report(userId, messageId, reason, options = {}) {
    if (!this.profiles.has(userId)) throw new Error('no such person');
    const why = REASON_NAMES.includes(reason) ? reason : 'other';

    const found = this.#findMessage(messageId);
    if (!found) throw new Error('no such message, or it has already been forgotten');
    const { message, roomKey } = found;

    // You can only report what you could see. Otherwise anyone could complain
    // about rooms they have never been in, which is a way of attacking a room
    // rather than of moderating one.
    if (!receives(this.subscription(userId), message.subjects)) {
      throw new Error(`you are not in ${roomKey}`);
    }
    if (message.authorId === userId) throw new Error('you cannot report your own message');

    const list = this.reports.get(roomKey) ?? [];
    // One person, one message, one report. Pressing the button twice is not
    // twice the evidence, and allowing it would make the count meaningless.
    if (list.some((r) => r.by === userId && r.messageId === messageId)) {
      return { already: true, room: roomKey };
    }

    const disclosed = message.sealed ? String(options.disclosed ?? '').slice(0, 2000) : '';
    const report = {
      id: id(),
      messageId,
      room: roomKey,
      subjects: message.subjects,
      by: userId,
      reason: why,
      note: String(options.note ?? '').slice(0, 500),
      at: now(),
      // The evidence, kept because the message itself will not be.
      message: {
        author: message.author,
        authorId: message.authorId,
        // The one part of "who said it" that means anything a day later: the
        // id above was made for a connection and goes when it does.
        authorKey: message.authorKey ?? null,
        at: message.at,
        sealed: Boolean(message.sealed),
        body: message.sealed ? disclosed : message.body,
        // Said explicitly so nobody later mistakes a reader's disclosure for
        // something the server was able to read on its own.
        disclosedByReporter: Boolean(message.sealed && disclosed),
      },
    };

    list.push(report);
    this.reports.set(roomKey, list);
    // A room that was looked at and passed is being complained about again.
    this.cleared.delete(roomKey);

    for (const listener of this._reportWatchers) {
      try {
        listener(report);
      } catch {
        /* a moderation feed that throws must not stop the report being filed */
      }
    }
    return { already: false, room: roomKey, report };
  }

  /** Told when somebody reports something. Not the same feed as `watch`. */
  onReport(listener) {
    this._reportWatchers.add(listener);
    return () => this._reportWatchers.delete(listener);
  }

  /** The message with this id, wherever it is. */
  #findMessage(messageId) {
    for (const [roomKey, log] of this.messages) {
      const message = log.find((m) => m.id === messageId);
      if (message) return { message, roomKey };
    }
    return null;
  }

  /**
   * Which rooms need a moderator's attention, worst first.
   *
   * The answer to the question that was asked — which channels, not which
   * messages. See `lib/flag.js` for how reports become an order, and for why
   * several different people count for more than several reports.
   */
  concerns({ now: at = now(), includeCleared = false } = {}) {
    const rooms = [];
    const keys = new Set([...this.reports.keys(), ...this.flagged.keys()]);

    for (const roomKey of keys) {
      if (!includeCleared && this.cleared.has(roomKey)) {
        // Judged fine already, and nothing new since — see `report`, which
        // undoes this the moment somebody complains again.
        continue;
      }
      rooms.push({
        room: roomKey,
        subjects: parse(roomKey),
        reports: this.reports.get(roomKey) ?? [],
        messages: (this.messages.get(roomKey) ?? []).length,
        flags: this.flagged.get(roomKey) ?? 0,
        population: this.populationOf(roomKey),
      });
    }

    return rank(rooms, { now: at });
  }

  /** Everything held about one room, for somebody about to make a decision. */
  concern(roomKey) {
    const [entry] = this.concerns({ includeCleared: true }).filter((r) => r.room === roomKey);
    if (!entry) return null;
    return { ...entry, cleared: this.cleared.get(roomKey) ?? null, detail: this.reports.get(roomKey) ?? [] };
  }

  /**
   * A moderator has looked and thinks the room is fine.
   *
   * It stops appearing until somebody reports it again, which is what stops a
   * list of concerns from being a list of the same six rooms forever. The
   * reports themselves are not deleted; a judgement is not evidence.
   */
  clear(roomKey, by = 'moderator') {
    if (!this.reports.has(roomKey) && !this.flagged.has(roomKey)) return false;
    this.cleared.set(roomKey, { at: now(), by });
    return true;
  }

  /**
   * Whether somebody wants their own client to keep a transcript.
   *
   * Their setting, about their own copy. It is not a request anybody else is
   * bound by, and the interface says so rather than implying otherwise.
   */
  setRecording(userId, on) {
    const profile = this.profiles.get(userId);
    if (!profile) return false;
    profile.recording = Boolean(on);
    return profile.recording;
  }

  recording(userId) {
    return Boolean(this.profiles.get(userId)?.recording);
  }

  post(userId, tags, body, options = {}) {
    const room = canonical(tags);
    // Cleaned here as well as in the browser. The browser does it first and
    // shows the result, so nobody is edited without seeing it; this is the
    // backstop for everything that is not the browser, which is anything
    // holding a socket open.
    //
    // A sealed message cannot be cleaned here at all - there is nothing
    // readable to clean - so for those the rule lives entirely in the client.
    const scrubbed = plain(body);
    const text = scrubbed.text;

    if (!room.length) throw new Error('a message needs at least one subject');
    if (room.length > ROOM_ARITY) throw new Error(`at most ${ROOM_ARITY} subjects per room`);
    if (!text && !options.envelope) throw new Error('empty message');
    for (const s of room) if (!this.subjects.has(s)) throw new Error(`no such subject: ${s}`);

    // You may only post where you stand. Posting into a room you are not in
    // would put words in a context you do not hold.
    if (!receives(this.subscription(userId), room)) {
      throw new Error(`you are not in ${key(room)}`);
    }

    const roomKey = key(room);
    const profile = this.profiles.get(userId);
    const message = {
      // Which form of commitment names this message; see `lib/receipt.js`.
      v: 2,
      id: id(),
      room: roomKey,
      subjects: room,
      author: profile?.name ?? 'anon',
      authorId: userId,
      body: text.slice(0, 2000),
      at: now(),
    };

    // The key written beside the name. For one that has been SHOWN to belong
    // to whoever is posting - `challenge` in `lib/proof.js` is how - and for
    // nothing else: the only reason it means anything to a reader is that
    // nobody gets one by asking. The world cannot check, because it holds no
    // connections; whoever passes this is vouching. Absent rather than empty
    // otherwise, so that "no key" is one thing to test for and not two.
    if (options.authorKey) message.authorKey = String(options.authorKey);

    // Written by the server, not by a person: see `server/questions.js`. Set
    // only by whoever calls this directly — nothing a connection sends can
    // reach it — and part of the message's hash, so it cannot be taken off.
    if (options.machine) message.machine = true;

    // Replying to something. Held as an id plus enough of the original to
    // show, because the thing being replied to may be deleted before this is
    // read - and a reply to nothing is a conversation with a hole in it.
    if (options.replyTo) {
      const parent = this.#findMessage(String(options.replyTo));
      if (parent && parent.roomKey === roomKey) {
        message.replyTo = {
          id: parent.message.id,
          author: parent.message.author,
          // A sealed parent has nothing readable to quote, so nothing is quoted.
          excerpt: parent.message.sealed ? '' : parent.message.body.slice(0, 120),
          sealed: Boolean(parent.message.sealed),
        };
      }
    }

    // A sealed message travels and is stored as an envelope. The server holds
    // it, routes it and forgets it on schedule, and at no point can open it —
    // which also means it cannot see a name in it, so a sealed message can
    // notify a room but never a mention.
    if (options.envelope) {
      message.envelope = options.envelope;
      message.sealed = true;
      message.body = '';
    }

    const log = this.messages.get(roomKey) ?? [];
    log.push(message);
    if (log.length > 500) log.shift();
    this.messages.set(roomKey, log);
    this.#said();

    // If an operator asked for it, note that the words are worth a look. Only
    // ever a count, and only for messages the server can actually read: a
    // sealed one is opaque here and is left alone rather than guessed at.
    if (this._words && !message.sealed && !scan(message.body, { words: this._words }).clean) {
      this.flagged.set(roomKey, (this.flagged.get(roomKey) ?? 0) + 1);
    }

    // The anchor: a hash of this message, so a copy handed back after a
    // restart can be told from something invented. Written before anybody is
    // told the message exists.
    //
    // The sequence number is part of the anchor rather than an afterthought.
    // Several messages can share a millisecond - in a busy room they often do
    // - so `at` alone cannot put a restored room back in the order it was
    // actually said. The ledger already knows that order, because it was
    // written in it.
    const mark = sha(commitmentInput(message));
    const seq = this.committed.size;
    message.seq = seq;
    this.committed.set(mark, { room: roomKey, at: message.at, seq });
    this.#record({ kind: 'post', commitment: mark, room: roomKey, at: message.at, seq });

    // How many this reaches is what decides whether it is worth interrupting
    // anyone for, and it is already known here.
    message.reach = this.populationOf(roomKey) || 1;
    this.#announce({ type: 'message', room: roomKey, message });
    return message;
  }

  /**
   * Who a message reaches: every user whose subscription contains `tags`.
   *
   * Returns user ids, not connections. The World used to hold the live sockets
   * itself and hand back sessions, which meant anyone wanting the routing for
   * a different transport — polling, server-sent events, a queue, a game loop
   * — had to invent a socket-shaped object to satisfy it. Who should hear a
   * message is a question about membership; turning that into bytes is not.
   *
   * `among` narrows the search, since a caller with connections open knows the
   * few thousand members can be skipped in favour of the few dozen present.
   */
  /**
   * How many hold every subject of a room: the people a message there reaches.
   *
   * Read from the census for rooms of up to `MAX_ARITY`, which it counts as
   * it goes. A bigger room is counted when it is asked for, from the holders
   * of the rarest of its subjects: see `audienceFor`, and `ROOM_ARITY` for why
   * the census does not keep those.
   */
  populationOf(roomKey) {
    const subjects = parse(String(roomKey ?? ''));
    if (!subjects.length) return 0;
    if (subjects.length <= MAX_ARITY) return this.census().get(key(subjects)) ?? 0;
    return this.audienceFor(subjects).length;
  }

  audienceFor(tags, among = null) {
    const room = canonical(tags);
    if (!room.length) return [];

    // Walking every member to find the few who hold a room cost a millisecond
    // a message, which the notifier then paid on behalf of all four thousand
    // of them. But the audience for a room cannot be larger than the smallest
    // of its subjects, so the smallest is the only set worth walking — sorting
    // the subjects by how few people hold them turns a scan of the world into
    // a scan of the rarest thing in the room.
    //
    // `among` narrows the answer, not the search. Letting the caller's list
    // drive the scan was slower than this whenever the rarest subject in the
    // room had fewer holders than they had candidates, which for any room
    // worth notifying about is most of the time.
    const sets = room.map((s) => this._holders.get(s) ?? EMPTY);
    sets.sort((a, b) => a.size - b.size);
    if (!sets[0].size) return [];

    const out = [];
    for (const userId of sets[0]) {
      let everywhere = true;
      for (let i = 1; i < sets.length; i++) {
        if (!sets[i].has(userId)) {
          everywhere = false;
          break;
        }
      }
      if (everywhere) out.push(userId);
    }

    if (!among) return out;
    const present = among instanceof Set ? among : new Set(among);
    return out.filter((userId) => present.has(userId));
  }

  /** Backlog for every room this person can see, newest last. */
  historyFor(userId) {
    const held = this.subscription(userId);
    const out = {};
    for (const [roomKey, log] of this.messages) {
      if (receives(held, parse(roomKey))) out[roomKey] = log.slice(-100);
    }
    return out;
  }
}

/**
 * A world with enough people in it to have a shape.
 *
 * Note what this population does *not* contain: nobody holds both music and
 * philosophy. So `music+philosophy` never acquires a key, never gets drawn and
 * cannot be walked into. That absence is the whole point of the Euler path —
 * the room does not exist rather than existing and being empty.
 */
/**
 * Put the whole bundled catalogue into a world: every name in
 * `lib/knowledge.js`, a little over eleven hundred of them, from the broad
 * divisions down to `narrowboats`.
 *
 * Interests only. Nobody is added and nothing is said, so this is the right
 * start for a real deployment: an interest with nobody in it costs a string
 * in a set, takes up no room on the map, and is there to be found when the
 * first person who wants it turns up. Three interests was enough to show how
 * the place works and not enough to give anybody a reason to stay.
 */
export function stock(world) {
  for (const name of Object.keys(knowledge)) world.addSubject(name);
  return world;
}

/**
 * The world a fresh install opens with: the whole catalogue, and a few
 * made-up people talking in three corners of it so the map has something on
 * it and the rooms show what a conversation looks like.
 */
export function seed(world) {
  stock(world);
  for (const s of ['art', 'philosophy', 'music']) world.addSubject(s);

  const populate = (count, subjects, prefix) => {
    for (let i = 0; i < count; i++) {
      const userId = world.addUser(`${prefix}-${i + 1}`, { synthetic: true });
      for (const s of subjects) world.join(userId, s);
    }
  };

  populate(7, ['art'], 'painter');
  populate(5, ['philosophy'], 'thinker');
  populate(4, ['art', 'philosophy'], 'aesthete');
  populate(4, ['music'], 'player');
  populate(2, ['art', 'music'], 'performer');

  const speakers = new Map();
  const say = (subjects, name, body) => {
    if (!speakers.has(name)) speakers.set(name, world.addUser(name, { synthetic: true }));
    const author = speakers.get(name);
    for (const s of subjects) world.join(author, s);
    // Written here, not by anybody, and labelled so: a system message. The
    // names are sample people's; nobody said these.
    world.post(author, subjects, body, { machine: true });
  };

  say(['art'], 'hila', 'started a large underpainting today, mostly raw umber.');
  say(['philosophy'], 'osmo', 'is akrasia a failure of reason or of desire?');
  say(['art', 'philosophy'], 'wren', 'does a painting assert anything, or only show?');
  say(['art', 'philosophy'], 'wren', "that's the room this whole place exists for, really.");
  say(['music'], 'dov', 'practising the same four bars until they stop being four bars.');
  say(['art', 'music'], 'kit', 'notation is a drawing that happens to be binding.');

  return world;
}
