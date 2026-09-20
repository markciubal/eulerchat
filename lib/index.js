/**
 * eulerchat — chat rooms shaped like an Euler diagram.
 *
 * Subjects are regions on a plane; where they overlap is a room; a coordinate
 * is an address. This module is the geometry and set algebra on its own, with
 * no server and no DOM, so it can be used to draw area-proportional Euler
 * diagrams for anything at all — the chat application is one caller.
 *
 * Two layouts, two different bargains:
 *
 *   `layout`  convex circles, at most three subjects. Continuous: a small
 *             change in the data makes a small change in the picture, which is
 *             what a live surface needs. Reports where it had to compromise,
 *             because circles cannot always produce exactly the regions asked
 *             of them — see `fit.phantoms`.
 *
 *   `atlas`   routed boundaries, any number of subjects and any zone arity.
 *             Draws exactly the occupied regions at exactly the right sizes,
 *             by construction. Regrown from scratch each time, so it is a
 *             snapshot rather than a surface. Stays legible to about five
 *             subjects; past that, territories fragment and it says so.
 */

export {
  MAX_ARITY,
  buildIndex,
  canonical,
  census,
  key,
  neighbourhood,
  parse,
  reachableRooms,
  receives,
  regionsOfArity,
  restrict,
  subsets,
  zones,
} from './regions.js';

export { intersectionArea, layout, lensArea, separation } from './euler.js';

export { atlas } from './atlas.js';

export { toSVG } from './svg.js';

export { blend, hue, regionFill, stroke } from './palette.js';

export { ALERT, NOTIFY, QUIET, RANK, byUrgency, classify, mentions } from './notify.js';

export { anchorsFor, known, radialLayout, resolve } from './taxonomy.js';
export { knowledge } from './knowledge.js';
export { Mold, weave } from './mold.js';

export { abbreviate, shortLabels } from './abbrev.js';
