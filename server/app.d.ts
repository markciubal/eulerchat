import type { Server } from 'node:http';
import type { WebSocketServer } from 'ws';

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
  /** Also serve the bundled browser client. */
  serveClient?: boolean;
}): EulerChat;

import type { World } from './store.js';
