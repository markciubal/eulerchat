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
  id: string;
  room: RegionKey;
  subjects: string[];
  author: string;
  authorId: string;
  /** Empty when `sealed`: the server has no readable copy of one of those. */
  body: string;
  at: number;
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

export interface DiagramView extends Layout {
  rooms: Room[];
  /** Subjects the viewer holds that did not fit in the view. */
  hidden: string[];
  /** Neighbouring subjects shown but not held. */
  suggested: string[];
  subscription: string[];
  rail: { held: string[]; suggested: string[]; popular: string[]; total: number };
}

export interface AtlasView extends Atlas {
  subscription: string[];
  rooms: Array<Room & { here: number }>;
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
  addUser(name: string): string;
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
  /** A cheap fingerprint of what their screen would show. */
  viewSignature(userId: string): string;

  post(
    userId: string,
    tags: Iterable<string>,
    body: string,
    options?: { envelope?: Envelope | null },
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
  stateFor(userId: string): { subscription: string[]; funnel: number; rail: unknown };

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

  searchSubjects(query: string, limit?: number): Array<{ id: string; population: number }>;
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

/** A small hand-written world: art, philosophy, music, and some conversation. */
export function seed(world: World): World;
