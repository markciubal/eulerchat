import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { WebSocketServer } from 'ws';
import type { Notification, NotifyPrefs, RegionKey } from '../lib/index.js';

export {
  World,
  seed,
  stock,
  type Message,
  type Room,
  type DiagramView,
  type AtlasView,
  type BranchView,
  type Community,
  type CatalogueLevel,
} from './store.js';

/** How many commitments one `forgotten` event on the firehose carries; a bigger deletion comes in parts. */
export const FORGOTTEN_PER_EVENT: number;

/** How many interests one `join` frame may carry, for joining a community at once. */
export const JOIN_AT_ONCE: number;

/** The most made-up people one `machines` frame may ask for. */
export const MACHINES_MOST: number;

export interface Session<Socket = unknown> {
  id: string;
  userId: string;
  socket: Socket;
  /** What this connection was last sent, so unchanged views cost nothing. */
  lastView: string | null;
  /** Whatever the host's `authenticate` said about this connection, if anything. */
  account?: Account | null;
  /** The fingerprint of the key this connection has claimed. A claim; see `proven`. */
  keyId?: string;
  publicKey?: JsonWebKey | null;
  /**
   * Whether the connection has shown that it holds `keyId`. Anything that gives
   * a key standing must read this: claiming a key is free, and every key in
   * the place is known to everybody in it.
   */
  proven?: boolean;
}

/**
 * Who a host says a connection is. `id` makes every connection from that
 * account the same person; `name` is what they are called to begin with; the
 * rest is yours, and comes back to you on `session.account`.
 */
export interface Account {
  id?: string | number;
  name?: string;
  [key: string]: unknown;
}

/**
 * Who is connected, and on what. The half of the old `World` that was about
 * wires rather than membership. A user may hold several connections at once.
 */
export class Sessions<Socket = unknown> {
  readonly size: number;
  [Symbol.iterator](): IterableIterator<Session<Socket>>;

  open(id: string, userId: string, socket: Socket): Session<Socket>;
  get(id: string): Session<Socket> | undefined;
  close(id: string): Session<Socket> | null;
  /** On resume, hand a live connection a different identity. */
  reassign(id: string, userId: string): Session<Socket> | null;

  forUser(userId: string): Array<Session<Socket>>;
  /** Every user with a connection open — what to narrow a delivery to. */
  present(): IterableIterator<string>;
  reaching(userIds: Iterable<string>): Array<Session<Socket>>;
}

/**
 * Preferences, unread counts and a small backlog, per person.
 *
 * `classify` in the library decides what is worth someone's attention and
 * knows nothing about connections; this keeps the state and hands finished
 * notifications to whatever is listening, so the same rules can drive a
 * WebSocket frame, a push notification, a webhook or an email digest.
 */
export class Notifications {
  constructor(world: World, options?: { hold?: number });

  /**
   * Called with every notification worth showing. Return true if it actually
   * reached the person; anything unclaimed is kept until they are back.
   */
  onNotify(listener: (userId: string, notification: Notification) => boolean | void): () => void;

  settings(userId: string): Required<NotifyPrefs>;
  configure(userId: string, changes?: NotifyPrefs): Required<NotifyPrefs>;
  mute(userId: string, room: RegionKey): Required<NotifyPrefs>;
  unmute(userId: string, room: RegionKey): Required<NotifyPrefs>;

  /** Which room someone is looking at; that room stops interrupting them. */
  looking(userId: string, room: RegionKey | null): void;

  counts(userId: string): Record<RegionKey, number>;
  total(userId: string): number;
  /** Mark a room read, or everything if no room is given. */
  clear(userId: string, room?: RegionKey): void;
  /** What happened while they were away, most urgent first, emptied by reading. */
  drain(userId: string): Notification[];

  close(): void;
}

export function populate(
  world: World,
  options?: {
    subjects?: number;
    users?: number;
    themeSize?: number;
    seed?: number;
    minInterests?: number;
    maxInterests?: number;
    importChance?: number;
    chatter?: number;
  },
): World;

export interface EulerChat {
  world: World;
  sessions: Sessions;
  notifications: Notifications;
  server: Server;
  wss: WebSocketServer;
  /**
   * Serve the bundled client yourself — behind your own middleware, or from
   * somewhere other than where this mounted it. Answers only for its own
   * paths and returns without touching the response for anything else.
   */
  handleRequest(req: IncomingMessage, res: ServerResponse): void;
  close(): void;
}

/**
 * The chat server as something you mount, not something that starts when you
 * import it. Binds no port and reads no argv; pass `server` to attach to one
 * you already have, or leave it out to be handed an unbound one to listen on.
 */
export function createEulerChat(options?: {
  world?: World;
  /** Attach to a server you already have; omit to be handed an unbound one. */
  server?: Server;
  /** Live under a path, e.g. `/chat`. Defaults to the root. */
  mount?: string;
  sessions?: Sessions;
  notifications?: Notifications;
  /** Also serve the bundled browser client. */
  serveClient?: boolean;
  /**
   * Let a page fill this world with made-up people and empty it again, through
   * the `machines` frame. Off unless asked for: made-up people anywhere real
   * would be passed off as real ones. The bundled server turns it on only when
   * nothing in the environment looks like a deployment.
   */
  machines?: boolean;
  /**
   * Serve every unlocked conversation to anybody who asks. Off unless asked
   * for; the bundled server asks for it.
   */
  publicApi?: boolean;
  /** Where the open read API lives. Defaults to `/api`. */
  apiPath?: string;
  /**
   * Keep the firehose in public dumps of at most `bytes` (a megabyte by
   * default) at `/api/dumps`, for whoever was not holding it open. A dump
   * loses a message when the place forgets it, and goes `keepFor` after the
   * last thing in it. On wherever `publicApi` is, and off otherwise.
   */
  dumps?: boolean | { bytes?: number; keep?: number; keepFor?: number };
  /**
   * Who the host says a connection is, from the upgrade request - its cookies,
   * its headers, its query string. Everybody is an anonymous guest when this
   * is left out, and that is the default on purpose. Return null for a
   * visitor; throw, or reject, to refuse the connection.
   */
  authenticate?: (req: IncomingMessage) => Account | null | undefined | Promise<Account | null | undefined>;
  /**
   * Key fingerprints, in full, that may read reports - for a place with no
   * accounts. Counts only for a connection that has shown it holds the key.
   * Ignored when `isModerator` is given.
   */
  moderators?: Iterable<string>;
  /**
   * Now and then, have one of the sample people (`addUser(name, {synthetic:
   * true})`, as `seed` and `populate` make them) ask an on-topic question in a
   * quiet room somebody online can read. Every message is marked `machine:
   * true`, in its hash as well as its fields, and the bundled client labels it
   * as a system message. Never as a real person; never in a group or a portal.
   * Off by default. `every` and `quiet` are in milliseconds.
   */
  questions?: boolean | { every?: number; quiet?: number };
  /**
   * Who may read reports. Nobody by default. `session.account` is what your
   * `authenticate` returned; `session.proven` and `session.keyId` are the key.
   */
  isModerator?: (userId: string, session: Session) => boolean;
}): EulerChat;

import type { World } from './store.js';
