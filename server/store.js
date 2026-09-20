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
import { anchorsFor, ancestorsOf, normalise, radialLayout, resolve } from '../lib/taxonomy.js';
import { knowledge } from '../lib/knowledge.js';

/** Computed once: where subjects sit before anybody has joined them. */
const EXTENT = 1000;
const HIERARCHY = radialLayout(knowledge, { extent: EXTENT });

const EMPTY = new Set();

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
    /** subject -> who holds it. An inverted index; see `audienceFor`. */
    this._holders = new Map();
    /** @type {Set<(event: object) => void>} */ this._watchers = new Set();
  }

  // --- catalogue & membership -------------------------------------------

  addSubject(name) {
    // `theory of entomology` and `modern entomology` are entomology. Splitting
    // one small community into three rooms over a turn of phrase is the kind
    // of fragmentation nobody would defend if asked directly.
    const subject = normalise(name, this.hierarchy ?? HIERARCHY);
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

  join(userId, subject, options = {}) {
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

    for (const broader of ancestorsOf(subject, knowledge, reach)) {
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
      rail: this.rail(held, suggested),
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
    // Anchored to the knowledge hierarchy, so the map keeps its shape as people
    // come and go instead of rearranging itself around whoever is here now.
    const view = atlas(zones([...this.members.values()], subjects), {
      anchors: anchorsFor(subjects, this.hierarchy ?? HIERARCHY),
    });

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
        stats: this.stats(zone.key),
      })),
    };
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
    if (this._overview?.census === counts && this._overview.size === counts.size) {
      return this._overview.value;
    }

    const where = this.hierarchy ?? HIERARCHY;
    const { population } = this.index();
    // Fanned, so the facets of one subject are distinguishable rather than
    // stacked invisibly on top of it.
    const anchors = anchorsFor(population.keys(), where);
    const placed = [];
    const strays = [];

    for (const [id, n] of population) {
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

    const value = { subjects: placed, extent: EXTENT, classified: placed.length - strays.length };
    this._overview = { census: counts, size: counts.size, value };
    return value;
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
      last: { author: latest.author, body: latest.body.slice(0, 120), at: latest.at },
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
