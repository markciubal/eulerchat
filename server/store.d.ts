import type { Atlas, Census, Layout, RegionKey, SubjectIndex } from '../lib/index.js';

/** Bounds the cubic term in `census`: the census enumerates subsets. */
export const MAX_SUBSCRIPTIONS: number;
export const MAX_SUBJECTS: number;

export interface Message {
  id: string;
  room: RegionKey;
  subjects: string[];
  author: string;
  authorId: string;
  body: string;
  at: number;
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

  post(userId: string, tags: Iterable<string>, body: string): Message;
  /** Who a message reaches: user ids, never connections. */
  audienceFor(tags: Iterable<string>, among?: Iterable<string>): string[];
  historyFor(userId: string): Record<RegionKey, Message[]>;

  searchSubjects(query: string, limit?: number): Array<{ id: string; population: number }>;
}

/** A small hand-written world: art, philosophy, music, and some conversation. */
export function seed(world: World): World;
