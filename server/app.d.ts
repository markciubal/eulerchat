import type { Server } from 'node:http';
import type { WebSocketServer } from 'ws';
import type { Notification, NotifyPrefs, RegionKey } from '../lib/index.js';

export { World, seed, type Message, type Room, type DiagramView, type AtlasView } from './store.js';

export interface Session<Socket = unknown> {
  id: string;
  userId: string;
  socket: Socket;
  /** What this connection was last sent, so unchanged views cost nothing. */
  lastView: string | null;
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
  close(): void;
}

/**
 * The chat server as something you mount, not something that starts when you
 * import it. Binds no port and reads no argv; pass `server` to attach to one
 * you already have, or leave it out to be handed an unbound one to listen on.
 */
export function createEulerChat(options?: {
  world?: World;
  server?: Server;
  sessions?: Sessions;
  notifications?: Notifications;
  /** Also serve the bundled browser client. */
  serveClient?: boolean;
}): EulerChat;

import type { World } from './store.js';
