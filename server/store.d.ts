import type {
  Atlas,
  Census,
  Concern,
  Receipt,
  Envelope,
  Layout,
  Reason,
  RegionKey,
  SubjectIndex,
} from '../lib/index.js';

/** Bounds the cubic term in `census`: the census enumerates subsets. */
export const MAX_SUBSCRIPTIONS: number;
export const MAX_SUBJECTS: number;

export interface Message {
  /**
   * Which form of commitment names this message. Everything posted now is 2,
   * which covers the name and the key; absent on what an older ledger holds.
   */
  v?: 2;
  id: string;
  room: RegionKey;
  subjects: string[];
  author: string;
  authorId: string;
  /**
   * The fingerprint of the key it was said under, written after the name.
   * Present only when whoever posted it had shown they hold that key.
   */
  authorKey?: string;
  /** Empty when `sealed`: the server has no readable copy of one of those. */
  body: string;
  at: number;
  /**
   * A system message: written by the server, not by a person — a sample
   * world's lines, or a question from `questions`. Set only by the server, and
   * part of the message's hash, so a restored copy cannot drop or add it.
   */
  machine?: boolean;
  /** How many people it reaches, which is what decides whether to interrupt. */
  reach?: number;
  sealed?: boolean;
  /** The envelope, opaque to the server. See `eulerchat/seal`. */
  envelope?: Envelope | null;
}

/** One person saying a message is wrong. See `World.report`. */
export interface Report {
  id: string;
  messageId: string;
  room: RegionKey;
  subjects: string[];
  /** Who reported it. Never sent to the room. */
  by: string;
  reason: Reason;
  note: string;
  at: number;
  /** The message, copied so that the complaint outlives the conversation. */
  message: {
    author: string;
    authorId: string;
    at: number;
    sealed: boolean;
    body: string;
    /**
     * True when the text above came from the reporter rather than from the
     * server — which is the only way it can exist for a sealed message, and is
     * recorded so that nobody mistakes it for something the server could read.
     */
    disclosedByReporter: boolean;
  };
}

export interface Room {
  key: RegionKey;
  subjects: string[];
  /** Everyone holding all of these subjects. */
  population: number;
  /** Whether the viewer may post here. */
  member: boolean;
  messages: number;
}

/**
 * A subject somebody does not hold, and the rooms joining it would open for
 * them: occupied regions containing it whose other subjects they already hold.
 *
 * Ranked by how unusual those rooms are rather than by how large — the
 * opposite of `Rail.popular`, deliberately. See `World.discoveries`.
 */
export interface Discovery {
  subject: string;
  /** How many people hold it today. */
  population: number;
  /** The strongest few, key and population. May be a prefix of them all. */
  rooms: Array<{ key: RegionKey; population: number }>;
  /** How many rooms would open in total, including any not listed above. */
  opens: number;
  /** 0 to 1, against the strongest suggestion in the same list. */
  score: number;
}

export interface Rail {
  held: string[];
  suggested: string[];
  /** A few large rooms to fall into. Ranked by size; see `discoveries`. */
  popular: string[];
  /** Subjects they do not hold, ranked by what joining one would open. */
  discoveries: Discovery[];
  total: number;
}

export interface DiagramView extends Layout {
  rooms: Room[];
  /** Subjects the viewer holds that did not fit in the view. */
  hidden: string[];
  /** Neighbouring subjects shown but not held. */
  suggested: string[];
  subscription: string[];
  rail: Rail;
}

export interface AtlasView extends Atlas {
  subscription: string[];
  /**
   * Names the drawing: the same for the same subjects and regions, so a page
   * that has this drawing can ask for only the rooms. See `atlasFor`.
   */
  shape: string;
  /**
   * `activity`: how lively it has been lately, 0 to 1 against the liveliest
   * room on the platform — the height the map raises it to. See `activity()`.
   */
  rooms: Array<Room & { here: number; activity: number; offMap?: boolean }>;
  /** The community each drawn interest is in, and the ones nearest it; see `communities()`. */
  communities: Record<string, Community & { near: Community[] }>;
}

/** A community as a map offers it: its most-held interest, the few it is named by, and how many are in it. */
export interface Community {
  lead: string;
  name: string[];
  size: number;
}

/** The map branched out into a community; see `branchFor`. */
export interface BranchView extends AtlasView {
  /** `members` is everything in the community, not only what the map drew of it. */
  branch: { from: string; toward: string | null; community: Community & { members: string[] } };
}

/**
 * The world: subjects, who holds what, what was said, and the queries that
 * follow from those. Holds no connections — see `Sessions` in ./app.js — so
 * the routing can be driven over any transport.
 */
export class World {
  subjects: Set<string>;
  profiles: Map<string, { id: string; name: string }>;
  members: Map<string, Set<string>>;
  messages: Map<RegionKey, Message[]>;

  addSubject(name: string): string;
  /**
   * `synthetic` marks one of a sample world's people rather than a person;
   * only they are ever posted as by the server. See `questions` in `createEulerChat`.
   */
  addUser(name: string, options?: { synthetic?: boolean }): string;
  /**
   * Change what somebody is called; returns the name they now have. The dot
   * that separates a name from a key is taken out, and an unusable name leaves
   * the old one standing.
   */
  rename(userId: string, name: string): string | null;
  subscription(userId: string): Set<string>;
  join(userId: string, subject: string): void;
  leave(userId: string, subject: string): void;
  removeUser(userId: string): void;

  census(): Census;
  index(): SubjectIndex;

  /** What this person should see: their subjects plus near neighbours. */
  diagramFor(userId: string): DiagramView;
  /** The same, drawn with routed boundaries and more subjects. */
  atlasFor(userId: string, limit?: number): AtlasView;
  /**
   * The map branched out from `from` into its community, or with `toward`
   * into the one that interest is in, drawn beside `from`. Joins nothing.
   * Null where there is nothing to branch into.
   */
  branchFor(userId: string, from: string, options?: { toward?: string | null; limit?: number }): BranchView | null;
  /**
   * Interests the same people hold together, grouped; see `lib/communities.js`.
   * Largest first, each with the others nearest it by index.
   */
  communities(): {
    list: Array<{ lead: string; name: string[]; members: string[]; near: number[] }>;
    of: Map<string, number>;
  };
  /**
   * A cheap fingerprint of what their screen would show.
   *
   * Deliberately says nothing about `rail.discoveries`, which move on almost
   * any membership change nearby: counting them would turn "redraw the few
   * sessions whose picture moved" back into "redraw everybody".
   */
  viewSignature(userId: string): string;

  /**
   * Subjects they do not hold, and the rooms joining one would open.
   *
   * Not a guess about taste: each one carries occupied regions containing that
   * subject whose other subjects this person already holds, so the offer is
   * "there are three people in `entomology+mycology` and you are one subject
   * short of it". Ranked by how unusual those rooms are rather than by how
   * busy — `rail.popular` is the other ranking, on purpose.
   *
   * Somebody holding nothing has no overlap to be one step from, and gets the
   * subjects worth standing in first instead.
   */
  discoveries(
    userId: string,
    options?: {
      /** How many subjects to return. Default 5. */
      limit?: number;
      /** How many rooms to carry as evidence for each. Default 3. */
      rooms?: number;
      /** 0 goes deeper into what they hold, 1 reaches further out. */
      novelty?: number;
    },
  ): Discovery[];

  /**
   * What to list beside the diagram: never the catalogue. `popular` is a few
   * large rooms to fall into, `discoveries` is what would open.
   */
  rail(
    held: Iterable<string>,
    suggested?: string[],
    options?: { popular?: number; discover?: number; userId?: string; novelty?: number },
  ): Rail;

  post(
    userId: string,
    tags: Iterable<string>,
    body: string,
    options?: {
      envelope?: Envelope | null;
      /** The id of the message being answered, if it is in the same room. */
      replyTo?: string | null;
      /**
       * A key fingerprint to write beside the author's name. Pass one only for
       * a key the author has SHOWN they hold (`challenge` in `eulerchat/proof`);
       * the world holds no connections and cannot check, so this is you
       * vouching for it.
       */
      authorKey?: string | null;
      /**
       * Mark it a system message: written by the server, not by the person it
       * is posted as. For anything a person did not type — never set it from
       * what a connection sends.
       */
      machine?: boolean;
    },
  ): Message;

  /** Drop everything past its retention window. Returns how much went. */
  forgetOld(now?: number): number;

  /** Whether somebody's own client should keep a transcript. Their setting. */
  setRecording(userId: string, on: boolean): boolean;
  recording(userId: string): boolean;

  /** How busy a room is, for somebody deciding whether to go into it. */
  stats(
    roomKey: RegionKey,
    window?: number,
  ): { messages: number; perMinute: number; last: Message | null };

  /** What one person's client needs, with no geometry in it. */
  stateFor(userId: string): { subscription: string[]; funnel: number; rail: Rail };

  // --- reports -----------------------------------------------------------

  /**
   * Somebody says a message is wrong.
   *
   * `disclosed` is the text for a sealed message, which only the reporter can
   * supply — the server never could read it. Throws if the reporter is not in
   * the room, or is the author.
   */
  report(
    userId: string,
    messageId: string,
    reason: Reason | string,
    options?: { disclosed?: string; note?: string },
  ): { already: boolean; room: RegionKey; report?: Report };

  /** Which rooms need attention, worst first. */
  concerns(options?: { now?: number; includeCleared?: boolean }): Concern[];

  /** One room, with the reports behind the number. */
  concern(roomKey: RegionKey): (Concern & { cleared: { at: number; by: string } | null; detail: Report[] }) | null;

  /** Judged fine; stops appearing until somebody reports it again. */
  clear(roomKey: RegionKey, by?: string): boolean;

  /** Turn on the word scanner. Off by default, and advisory when on. */
  watchWords(words?: Record<string, string[]> | null): boolean;

  /** Told when somebody reports something. Not the feed `watch` uses. */
  onReport(listener: (report: Report) => void): () => void;

  /** roomKey -> the reports held about it. */
  reports: Map<RegionKey, Report[]>;

  // --- votes -------------------------------------------------------------

  /**
   * Up, down, or neither. Pressing the same way twice takes the vote back.
   *
   * Votes are not moderation and feed nothing that is: a message people
   * dislike is not a message that broke a rule.
   */
  vote(userId: string, messageId: string, value: number): {
    messageId: string;
    room: RegionKey;
    up: number;
    down: number;
    score: number;
    yours: number;
  };

  /** How a message stands, and how this person voted on it. */
  tally(messageId: string, userId?: string | null): {
    up: number;
    down: number;
    score: number;
    yours: number;
  };

  // --- deletion ----------------------------------------------------------

  /** Delete your own message now, with a receipt like any other. */
  forget(userId: string, messageId: string): Receipt;

  /** The deletion chain, for anybody who wants to check it. */
  receipts(options?: { since?: number }): Receipt[];

  /** Every deletion so far, in order. */
  deletions: Receipt[];

  // --- durability --------------------------------------------------------

  /**
   * Attach somewhere durable and read back what it holds.
   *
   * Only hashes and deletions come back: the conversations are not in the
   * ledger and are not meant to be. They come from whoever kept a copy, and
   * `restore` checks each one against this.
   */
  useLedger(ledger?: Ledger): { messages: number; deletions: number };

  /**
   * Take back copies people kept, accepting only what can be proved.
   *
   * Each candidate is hashed the way it was hashed when posted; anything that
   * does not match is not a message this server saw, whatever it claims. A
   * message named in the deletion chain, or older than the retention window,
   * is refused however genuine it is - a restart must not be a way of undoing
   * a deletion.
   *
   * Restored rooms are genuine but may be incomplete: clients hand back what
   * they happened to keep.
   */
  restore(
    messages: unknown[],
    options?: { now?: number },
  ): {
    restored: number;
    refused: { unknown: number; deleted: number; expired: number; duplicate: number };
  };

  /** Every message ever seen, by hash. Small: a commitment is a fixed size. */
  committed: Map<string, { room: RegionKey; at: number; seq: number }>;

  ledger: Ledger | null;
  /** Who a message reaches: user ids, never connections. */
  audienceFor(tags: Iterable<string>, among?: Iterable<string>): string[];
  historyFor(userId: string): Record<RegionKey, Message[]>;

  /**
   * By the letters in a name, or by another word for it: `soccer` finds
   * `football`. Inside a group, each match is the group's copy of it.
   */
  searchSubjects(
    query: string,
    limit?: number,
    options?: { group?: string | null },
  ): Array<{ id: string; population: number }>;

  /**
   * One level of the catalogue: what this world has directly under a category,
   * or the broad divisions when `at` is nothing or is not a category. Inside a
   * group, the same tree, as the group's copies.
   */
  browse(at?: string | null, options?: { group?: string | null }): CatalogueLevel;

  /** Every occupied interest outside the groups, at its place in the hierarchy: the minimap. */
  overview(): { subjects: ChartSubject[]; extent: number; classified: number };
  /**
   * Every interest outside the groups, occupied or not, with the divisions and
   * fields named at the middle of what they cover. What the explorer draws;
   * asked for when it opens.
   */
  chart(): {
    subjects: ChartSubject[];
    labels: ChartLabel[];
    links: ChartLink[];
    /** By index, as `ChartSubject.c` names them. */
    communities: Array<{ name: string[]; size: number; near: number[] }>;
    extent: number;
    shape: string;
  };
  /**
   * How lively each room and each interest has been lately, 0 to 1 against
   * the liveliest on the platform. Every message counts, halving in weight
   * each hour of age; portals are left out, and groups do not set the scale.
   * See `lib/activity.js`.
   */
  activity(): { rooms: Map<RegionKey, number>; subjects: Map<string, number> };

  /** The group somebody is in (the one whose own conversation they hold), or null. */
  groupOf(userId: string): string | null;

  /**
   * One room as somebody outside it sees it — a lurker, come in by a quick-join
   * code: what has been said, how many are in it, how busy it is. Null for
   * anything that cannot be a room, and for a portal.
   */
  look(roomKey: string): {
    room: RegionKey;
    subjects: string[];
    here: boolean;
    population: number;
    stats: { messages: number; perMinute: number; last: object | null };
    messages: Message[];
  } | null;
}

/**
 * Two interests people hold together: both, how many hold both, and that as
 * a share of everybody holding either, damped where the numbers are small.
 * Never a pair only one person holds. See `lib/association.js`.
 */
export type ChartLink = [a: string, b: string, both: number, share: number];

/** One interest on the overview or the chart. */
export interface ChartSubject {
  id: string;
  /** How many hold it. */
  n: number;
  x: number;
  y: number;
  /** Whether the catalogue knows where it goes; the rest sit on an outer ring. */
  known: boolean;
  /** Its field, division and so on, nearest first. The chart only. */
  up?: string[];
  /** Which of the chart's communities it is in, where it is in one. The chart only. */
  c?: number;
  /**
   * How lively it has been lately, 0 to 1 against the liveliest interest on
   * the platform: the height of its column. The chart only, and left off
   * where it is nought.
   */
  a?: number;
}

/** A division (depth 1) or field (depth 2), named where its interests are. */
export interface ChartLabel {
  name: string;
  x: number;
  y: number;
  depth: 1 | 2;
  /** How many interests it covers. */
  count: number;
}

export interface CatalogueLevel {
  /** The category being looked at, or null at the top. */
  at: string | null;
  /** The way back up, broadest first, ending with `at`. */
  path: string[];
  children: Array<{
    id: string;
    population: number;
    /** How many interests sit beneath this one, at any depth. Zero for one with nothing under it. */
    inside: number;
    /** Up to three of what is directly beneath it, the busiest and biggest first. */
    sample: string[];
  }>;
}

/**
 * Somewhere append-only to write the anchor.
 *
 * Two methods on purpose: anybody putting this behind Postgres, Redis or a
 * queue should not have to implement a storage engine, and `load` only runs at
 * boot.
 */
export interface Ledger {
  append(record: object): unknown;
  load(): object[];
  close?(): void;
}

/** One JSON object per line, never rewritten. The default. */
export declare class FileLedger implements Ledger {
  constructor(file?: string);
  append(record: object): object;
  load(): object[];
  close(): void;
}

/** The same thing in memory, for tests and for anybody who wants no file. */
export declare class MemoryLedger implements Ledger {
  constructor(records?: object[]);
  records: object[];
  append(record: object): object;
  load(): object[];
  close(): void;
}

export declare function isLedger(thing: unknown): boolean;

/** How long the server keeps a message before forgetting it. */
export declare const KEEP_FOR: number;

/**
 * How long a report is kept, which is longer and deliberately so: a report is
 * useless without the message it is about, and that message is deleted first.
 */
export declare const REPORTS_KEEP_FOR: number;

/**
 * Put the whole bundled catalogue into a world: interests only, no people and
 * no messages. The right start for a real deployment.
 */
export function stock(world: World): World;

/**
 * What a fresh install opens with: the stocked catalogue, plus a few made-up
 * people talking in art, philosophy and music so the map has something on it.
 */
export function seed(world: World): World;
