import type { Atlas, Layout, RegionKey } from '../lib/index.js';

/** One person, read out of whatever rows you handed over. */
export interface Person {
  id: string;
  name: string;
  subjects: string[];
  /** 0 goes deeper into what they hold, 1 reaches for something further out. */
  novelty: number;
  /** How far a join should carry upward: 0 just this, 1 its field, 2 its division. */
  reach: number;
  /** The row it came from, untouched. */
  row: unknown;
}

export interface Adapted {
  people: Person[];
  /** Ready for `census()` and `zones()` without further ceremony. */
  subscriptions: Array<Set<string>>;
  subjects: string[];
}

/** Which column means what. A name, a path like `profile.name`, or a function. */
export interface Columns {
  id?: string | ((row: any) => unknown);
  name?: string | ((row: any) => unknown);
  subjects?: string | ((row: any) => unknown);
  novelty?: string | ((row: any) => unknown);
  reach?: string | ((row: any) => unknown);
  interestUser?: string | ((row: any) => unknown);
  interestSubject?: string | ((row: any) => unknown);
}

/**
 * Turn the rows you already have into the shapes everything here takes.
 * Column names are guessed when not given. Nothing is async and nothing
 * assumes a server.
 */
export function fromRows(
  tables: { users?: any[]; interests?: any[] },
  columns?: Columns,
  options?: { hierarchy?: Map<string, unknown> | Record<string, string> },
): Adapted;

export interface Room {
  key: RegionKey;
  subjects: string[];
  population: number;
  /** Whether the person in focus is in it. */
  member: boolean;
}

export type MapView = (Layout | Atlas) & {
  rooms: Room[];
  subscription: string[];
};

export interface MapOptions {
  /** Rows, as your application already has them. */
  users?: any[];
  /** The join table, if interests live apart from people. */
  interests?: any[];
  columns?: Columns;
  /** Already-adapted data, instead of rows. */
  data?: Adapted;
  /** Whose neighbourhood to show. */
  focus?: string | number | null;
  view?: 'map' | 'atlas';
  /** Overridden by a person's own column when they have one. */
  novelty?: number;
  /** Show exactly these, rather than choosing. */
  subjects?: string[];
  /** Grow the atlas along a Physarum model. */
  mold?: boolean | Record<string, unknown>;
  /** Screen pixels of margin when framing. */
  padding?: number;
  onSelect?: (room: Room) => void;
  onHover?: (room: Room | null) => void;
  onRender?: (view: MapView) => void;
}

export interface MapHandle {
  update(options?: Partial<MapOptions>): MapHandle;
  select(room: RegionKey | null): MapHandle;
  destroy(): void;
  readonly element: SVGSVGElement;
  readonly data: Adapted;
  readonly view: MapView;
}

/**
 * Draw the map into an element you own, and keep it up to date. No connection,
 * no polling, nothing async — hand it rows, point it at a person, it renders.
 */
export function mountMap(element: Element, options?: MapOptions): MapHandle;

/** What one person should see, computed without drawing it. */
export function viewFor(
  data: Adapted,
  options?: Pick<MapOptions, 'focus' | 'view' | 'novelty' | 'subjects' | 'mold'> & { limit?: number },
): MapView;

export type Distance = (a: string, b: string) => number;

// --- react -----------------------------------------------------------------

export interface EulerMapProps extends Omit<MapOptions, 'onSelect' | 'onHover' | 'onRender'> {
  onSelectRoom?: (room: Room) => void;
  onHoverRoom?: (room: Room | null) => void;
  onRender?: (view: MapView) => void;
  style?: Record<string, unknown>;
  className?: string;
}

/**
 * The map as a React component. React is an optional peer dependency —
 * nothing else in the package imports this, so a project that never touches
 * it never needs React.
 */
export function EulerMap(props: EulerMapProps): unknown;
