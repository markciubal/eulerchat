import {
  MAX_ARITY,
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

const now = () => Date.now();
const id = () => crypto.randomUUID().slice(0, 8);

/** Bounds the cubic term in `census`; see `join`. */
export const MAX_SUBSCRIPTIONS = 32;

/** Bounds the catalogue, which is otherwise unbounded memory; see `addSubject`. */
export const MAX_SUBJECTS = 50_000;

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
    /** @type {Set<(event: object) => void>} */ this._watchers = new Set();
  }

  // --- catalogue & membership -------------------------------------------

  addSubject(name) {
    const subject = String(name).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9 -]{0,30}$/.test(subject)) throw new Error('unusable subject name');
    if (!this.subjects.has(subject) && this.subjects.size >= MAX_SUBJECTS) {
      throw new Error('the catalogue is full');
    }
    // No census change: a subject nobody holds occupies no region.
    this.subjects.add(subject);
    return subject;
  }

  addUser(name) {
    const userId = id();
    // No census change either: they hold nothing yet.
    this.profiles.set(userId, { id: userId, name: String(name).slice(0, 40) || 'anon' });
    this.members.set(userId, new Set());
    return userId;
  }

  subscription(userId) {
    return this.members.get(userId) ?? new Set();
  }

  join(userId, subject) {
    if (!this.subjects.has(subject)) throw new Error(`no such subject: ${subject}`);
    const held = this.members.get(userId);
    if (!held || held.has(subject)) return;

    // The census enumerates every subset of a subscription up to arity three,
    // so its cost is cubic in how much one person holds. Unbounded, a single
    // client holding three hundred subjects builds four and a half million
    // regions and puts every view — everyone's, not just theirs — over a
    // second. Nobody is shown more than three subjects at once, so there is no
    // legitimate reason to hold a hundred.
    if (held.size >= MAX_SUBSCRIPTIONS) {
      throw new Error(`you can hold at most ${MAX_SUBSCRIPTIONS} subjects — leave one first`);
    }

    // Announce only once the membership is actually true. Emitting from inside
    // `#touch` meant a room was declared open while the person who opened it
    // was still, as far as the subscription was concerned, not in it — so the
    // containment check quite correctly refused to tell them about it, and the
    // one event this design has that no flat chat model does never fired.
    const opened = this.#touch(held, subject, +1);
    held.add(subject);
    this.#flush(opened);
  }

  leave(userId, subject) {
    const held = this.members.get(userId);
    if (!held || !held.has(subject)) return;

    held.delete(subject);
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

  /** Everything a view depends on, without paying for the geometry. */
  context(userId) {
    const counts = this.census();
    const held = this.subscription(userId);
    const { subjects, hidden, suggested } = neighbourhood(counts, held, MAX_ARITY, this.index());
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
        };
      })
      .sort((a, b) => a.subjects.length - b.subjects.length || a.key.localeCompare(b.key));

    return {
      ...solved,
      rooms,
      hidden,
      suggested,
      subscription: [...held].sort(),
      rail: this.rail(held, suggested),
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
  rail(held, suggested = [], popular = 12) {
    const mine = [...held].sort();
    const shown = new Set([...mine, ...suggested]);
    const index = this.index();

    return {
      held: mine,
      suggested,
      popular: index.popular.filter((s) => !shown.has(s)).slice(0, popular),
      total: this.subjects.size,
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
    const { subjects } = neighbourhood(counts, held, limit, this.index());
    const view = atlas(zones([...this.members.values()], subjects));

    return {
      ...view,
      subscription: [...held].sort(),
      rooms: view.zones.map((zone) => ({
        key: zone.key,
        subjects: zone.subjects,
        // Both numbers matter and they differ: the ground a zone occupies is
        // the people holding exactly it, while the room it opens reaches
        // everyone holding at least it.
        here: zone.population,
        population: counts.get(zone.key) ?? zone.population,
        member: receives(held, zone.subjects),
        messages: (this.messages.get(zone.key) ?? []).length,
      })),
    };
  }

  /**
   * Substring search, largest rooms first.
   *
   * Over the whole catalogue rather than the census, so an interest that has
   * emptied out can still be found and revived — it is absent from the map,
   * not from the world.
   */
  searchSubjects(query, limit = 20) {
    const needle = String(query ?? '').trim().toLowerCase();
    if (!needle) return [];
    const { population } = this.index();

    return [...this.subjects]
      .filter((s) => s.includes(needle))
      .sort((a, b) => (population.get(b) ?? 0) - (population.get(a) ?? 0) || a.localeCompare(b))
      .slice(0, limit)
      .map((id) => ({ id, population: population.get(id) ?? 0 }));
  }

  // --- messages ----------------------------------------------------------

  post(userId, tags, body) {
    const room = canonical(tags);
    const text = String(body ?? '').trim();

    if (!room.length) throw new Error('a message needs at least one subject');
    if (room.length > MAX_ARITY) throw new Error(`at most ${MAX_ARITY} subjects per room`);
    if (!text) throw new Error('empty message');
    for (const s of room) if (!this.subjects.has(s)) throw new Error(`no such subject: ${s}`);

    // You may only post where you stand. Posting into a room you are not in
    // would put words in a context you do not hold.
    if (!receives(this.subscription(userId), room)) {
      throw new Error(`you are not in ${key(room)}`);
    }

    const roomKey = key(room);
    const message = {
      id: id(),
      room: roomKey,
      subjects: room,
      author: this.profiles.get(userId)?.name ?? 'anon',
      authorId: userId,
      body: text.slice(0, 2000),
      at: now(),
    };

    const log = this.messages.get(roomKey) ?? [];
    log.push(message);
    if (log.length > 500) log.shift();
    this.messages.set(roomKey, log);

    // How many this reaches is what decides whether it is worth interrupting
    // anyone for, and it is already known here.
    message.reach = this.census().get(roomKey) ?? 1;
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
  audienceFor(tags, among = this.members.keys()) {
    const room = canonical(tags);
    const out = [];
    for (const userId of among) {
      if (receives(this.subscription(userId), room)) out.push(userId);
    }
    return out;
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
export function seed(world) {
  for (const s of ['art', 'philosophy', 'music']) world.addSubject(s);

  const populate = (count, subjects, prefix) => {
    for (let i = 0; i < count; i++) {
      const userId = world.addUser(`${prefix}-${i + 1}`);
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
    if (!speakers.has(name)) speakers.set(name, world.addUser(name));
    const author = speakers.get(name);
    for (const s of subjects) world.join(author, s);
    world.post(author, subjects, body);
  };

  say(['art'], 'hila', 'started a large underpainting today, mostly raw umber.');
  say(['philosophy'], 'osmo', 'is akrasia a failure of reason or of desire?');
  say(['art', 'philosophy'], 'wren', 'does a painting assert anything, or only show?');
  say(['art', 'philosophy'], 'wren', "that's the room this whole place exists for, really.");
  say(['music'], 'dov', 'practising the same four bars until they stop being four bars.');
  say(['art', 'music'], 'kit', 'notation is a drawing that happens to be binding.');

  return world;
}
