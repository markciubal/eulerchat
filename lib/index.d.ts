/**
 * eulerchat — area-proportional Euler diagrams, and chat rooms shaped like one.
 *
 * A *region* (or room) is a set of subjects, addressed by its members sorted
 * and joined with `+`: `"art+philosophy"`.
 */

/** A region address: subject names, sorted, joined with `+`. */
export type RegionKey = string;

/** Region address -> population. Absent means unoccupied, never zero. */
export type Census = Map<RegionKey, number>;

/** No arrangement of circles realises every region of a 4-set Venn diagram. */
export const MAX_ARITY: 3;

// --- region algebra --------------------------------------------------------

export function canonical(subjects: Iterable<string>): string[];
export function key(subjects: Iterable<string>): RegionKey;
export function parse(region: RegionKey): string[];
export function subsets(set: Iterable<string>, maxSize?: number): string[][];

/**
 * The delivery rule: a message tagged `tags` reaches a reader subscribed to
 * `subscription` exactly when `tags ⊆ subscription`.
 */
export function receives(subscription: Iterable<string>, tags: Iterable<string>): boolean;

/**
 * Population of every occupied region, counted by *containment* — a region's
 * population is everyone subscribed to all of its subjects.
 */
export function census(subscriptions: Iterable<Iterable<string>>, maxArity?: number): Census;

/**
 * Population of every occupied region, counted *exclusively* — how many people
 * hold exactly this combination of `subjects`. What a drawn map needs, since
 * every patch of ground belongs to one combination. Uncapped arity.
 */
export function zones(
  subscriptions: Iterable<Iterable<string>>,
  subjects: Iterable<string>,
): Census;

export function restrict(counts: Census, subjects: Iterable<string>, maxArity?: number): Census;
export function reachableRooms(subscription: Iterable<string>, maxArity?: number): RegionKey[];
export function regionsOfArity(counts: Census, arity: number): Array<[string[], number]>;

export interface SubjectIndex {
  population: Map<string, number>;
  adjacency: Map<string, Set<string>>;
  popular: string[];
  dirty: boolean;
}

/** Derived once per census so choosing a view is not a scan of the world. */
export function buildIndex(counts: Census): SubjectIndex;

/** Which subjects to put in front of one person: theirs, plus near neighbours. */
export function neighbourhood(
  counts: Census,
  subscription: Iterable<string>,
  limit?: number,
  index?: SubjectIndex,
): { subjects: string[]; hidden: string[]; suggested: string[] };

// --- circle layout ---------------------------------------------------------

export interface Circle {
  id: string;
  population: number;
  x: number;
  y: number;
  r: number;
}

export interface RegionReport {
  key: RegionKey;
  subjects: string[];
  population: number;
  /** Drawn size, in members. */
  drawn: number;
  /** `|drawn - population| / population`. */
  error: number;
  /** False when the discrepancy is below what sampling can resolve. */
  significant: boolean;
}

export interface Fit {
  regions: RegionReport[];
  /** Regions the shapes formed that nobody occupies. */
  phantoms: Array<{ key: RegionKey; subjects: string[]; drawn: number }>;
  worstError: number;
  worst: RegionReport | null;
  /** False if any region is materially misdrawn, or any phantom exists. */
  faithful: boolean;
  /** False past three circles, where no layout can be trusted. */
  drawable: boolean;
}

export interface Layout {
  circles: Circle[];
  fit: Fit;
  bounds: { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number };
}

export interface LayoutOptions {
  /** Square pixels of circle area per member. */
  areaPerMember?: number;
  /** Clear space between circles that share nobody. */
  gap?: number;
  iterations?: number;
  /** Relative area error still called faithful. */
  tolerance?: number;
  samples?: number;
}

/**
 * Circles, area-proportional, at most three subjects. Continuous: a small
 * change in the census makes a small change in the picture.
 */
export function layout(counts: Census, options?: LayoutOptions): Layout;

export function lensArea(r1: number, r2: number, d: number): number;
export function separation(r1: number, r2: number, targetArea: number): number;
export function intersectionArea(circles: Circle[], samples?: number): number;

// --- atlas -----------------------------------------------------------------

export type Point = [number, number];

export interface Territory {
  subject: string;
  /** Closed loops; more than one means holes, or a subject in several pieces. */
  loops: Point[][];
  /** 1 when the territory is in one piece. */
  components: number;
  /** Deepest point of the ground this subject holds alone — where to label it. */
  anchor: { x: number; y: number };
}

export interface AtlasReport {
  /** No region drawn that nobody occupies, and none lost. True by construction. */
  exact: boolean;
  phantoms: number;
  vanished: number;
  worstError: number;
  /** Subjects that ended up in more than one patch. */
  disconnected: string[];
  worstSplit: number;
  wellFormed: boolean;
}

export interface Atlas {
  subjects: string[];
  zones: Array<{ key: RegionKey; subjects: string[]; population: number; x: number; y: number }>;
  curves: Territory[];
  /** User units across the map; coordinates run -extent/2 .. +extent/2. */
  extent: number;
  report: AtlasReport;
}

export interface AtlasOptions {
  /** Cells per side; the resolution of the map. */
  grid?: number;
  /** Share of the canvas the diagram occupies. */
  fill?: number;
  /** Rounds of corner-rounding on the outlines. */
  smooth?: number;
  extent?: number;
}

/**
 * Routed boundaries, any number of subjects and any zone arity. Draws exactly
 * the occupied regions at exactly the right sizes, by construction. Regrown
 * from scratch each time, so a snapshot rather than a live surface. Stays
 * legible to about five subjects; past that territories fragment and
 * `report.disconnected` says which.
 */
export function atlas(zoneCounts: Census, options?: AtlasOptions): Atlas;

// --- drawing ---------------------------------------------------------------

export interface SVGOptions {
  /** Pixel width and height of the root element. */
  size?: number;
  labels?: boolean;
  background?: boolean;
  theme?: 'light' | 'dark';
  /** Accessible name for the figure. */
  title?: string;
}

/** A standalone SVG string. No DOM, no dependencies, styles inlined. */
export function toSVG(diagram: Layout | Atlas, options?: SVGOptions): string;

export function hue(subject: string): number;
export function blend(subjects: Iterable<string>): number;
export function stroke(subject: string): string;
export function regionFill(subjects: string[]): string;

// --- notifications ---------------------------------------------------------

export const QUIET: 'quiet';
export const NOTIFY: 'notify';
export const ALERT: 'alert';
export type Level = 'quiet' | 'notify' | 'alert';

export interface NotifyPrefs {
  /** At or below this many people, a room is small enough to be conspicuous in. */
  intimate?: number;
  mentions?: boolean;
  /** Rooms opening and closing around you. */
  lifecycle?: boolean;
  muted?: Iterable<RegionKey>;
}

export interface Watcher extends NotifyPrefs {
  userId: string;
  name?: string;
  subscription: Iterable<string>;
  /** The room they are looking at, which therefore stops interrupting them. */
  viewing?: RegionKey | null;
}

export type WorldEvent =
  | { type: 'message'; room: RegionKey; message: { [k: string]: any }; at?: number }
  | { type: 'room-opened'; room: RegionKey; subjects: string[]; population: number; at?: number }
  | { type: 'room-closed'; room: RegionKey; subjects: string[]; population: 0; at?: number };

export interface Notification {
  kind: 'message' | 'mention' | 'room-opened' | 'room-closed';
  level: Level;
  room: RegionKey;
  subjects: string[];
  at: number;
  title: string;
  body: string;
  from?: string;
  messageId?: string;
}

/**
 * What is worth interrupting one person for, or null.
 *
 * Narrow rooms are loud and broad rooms are quiet: the fewer people a message
 * reaches, the more it is addressed to you. Returns null for anything in a
 * room the watcher could not already read, which is the rule that keeps
 * notifications from leaking conversations.
 */
export function classify(event: WorldEvent, watcher: Watcher): Notification | null;

/** Does `body` name this person? Wants the `@`; bare names match too much. */
export function mentions(body: string, name: string): boolean;

/** Most urgent first, then newest. */
export const byUrgency: (a: Notification, b: Notification) => number;

export const RANK: Record<Level, number>;
