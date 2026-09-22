/**
 * The map in relief: the same sheet, tilted away and turned, with every room
 * standing as tall as it is lively.
 *
 * Drawn in SVG, like the flat map, rather than handed to a 3D engine: every
 * room keeps its own colour, its subjects' emblems and outlines, its labels
 * and its place in the accessibility tree, and nothing has to be fetched.
 *
 * The projection is a tilt of the sheet away from the viewer after a turn
 * about its middle. That is an affine map, so the whole flat drawing of a
 * room can be laid on its top with one `transform`, and there is exactly one
 * direction on the screen — straight up — that both "further back" and
 * "higher" go in. That one fact is what keeps the drawing order simple. Draw
 * everything level by level from the ground up, and whatever is drawn later
 * can only ever land on something behind it or below it, never in front: a
 * point further up the screen than another is either further back or higher,
 * and both of those are things it is right to cover. No sorting of shapes
 * against each other, which for rooms shaped like these (long, bent, with
 * holes) has no right answer.
 */

/** How far the sheet is tilted from straight down, in radians. */
export const TILT = (52 * Math.PI) / 180;

/**
 * How far it can be tilted by hand. Not flat, where the heights vanish and
 * the flat map says it better; not edge on, where the rooms at the front hide
 * everything behind them.
 */
export const TILTS = { least: (20 * Math.PI) / 180, most: (74 * Math.PI) / 180 };
export const clampTilt = (tilt) => Math.min(TILTS.most, Math.max(TILTS.least, tilt));

/**
 * A view onto the sheet.
 *
 * @param {{turn?: number, tilt?: number}} [options]  turn about the middle, and tilt away, in radians
 */
export function view3d({ turn = 0, tilt = TILT } = {}) {
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  const squash = Math.cos(tilt);
  const lift = Math.sin(tilt);
  // Ground (x, y) goes to (a·x + c·y, b·x + d·y), and a height h adds −h·lift
  // to the second: up the screen.
  const a = cos;
  const b = sin * squash;
  const c = -sin;
  const d = cos * squash;
  const det = a * d - b * c;

  return {
    turn,
    tilt,
    squash,
    lift,
    /** Where a point on the sheet, at a height, lands in the drawing. */
    at: (x, y, h = 0) => [a * x + c * y, b * x + d * y - h * lift],
    /** How far back a point on the sheet is: the larger, the nearer. */
    depth: (x, y) => b * x + d * y,
    /** The point on the sheet under a point of the drawing, at a height. */
    ground: (X, Y, h = 0) => {
      const y0 = Y + h * lift;
      return [(d * X - c * y0) / det, (a * y0 - b * X) / det];
    },
    /** The same, as an SVG transform, for laying a flat drawing at a height. */
    matrix: (h = 0) => `matrix(${f(a)} ${f(b)} ${f(c)} ${f(d)} 0 ${f(-h * lift)})`,
    /** Which way an edge faces once turned: (x, y) with y towards the viewer. */
    facing: (nx, ny) => [cos * nx - sin * ny, sin * nx + cos * ny],
  };
}

const f = (n) => (Math.abs(n) < 1e-9 ? '0' : Number(n.toFixed(5)).toString());
const pt = ([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`;

/** The light: from the upper left, and a little in front. */
const LIGHT = (() => {
  const [x, y] = [-0.62, 0.78];
  const n = Math.hypot(x, y);
  return [x / n, y / n];
})();

/**
 * The walls of a shape one band high, as seen: its sides from the ground up
 * to `band`, in the drawing's coordinates, sorted by how much light they catch.
 * The same strip is stacked at every height a room reaches, so it is worked
 * out once per room and turn and reused by reference.
 *
 * Only the walls facing the viewer are kept. The rest are behind the room's
 * own top and front, which are always drawn over them.
 *
 * @param {Array<Array<[number, number]>>} loops  the shape, as closed loops, even-odd
 * @param {ReturnType<typeof view3d>} view
 * @param {number} band  in sheet units
 * @returns {{lit: string, side: string, shade: string}}  path data, possibly empty
 */
export function strips(loops, view, band) {
  return ribbons(wallRuns(loops, view), view, band);
}

/**
 * The walls of a shape that face the viewer, as runs of ground points sorted
 * by how much light they catch: everything about the walls that depends on
 * the view, and nothing that depends on how tall they are. Worked out once per
 * room and view, and raised to as many heights as are needed; see `ribbons`.
 *
 * @param {Array<Array<[number, number]>>} loops  the shape, as closed loops, even-odd
 * @param {ReturnType<typeof view3d>} view
 * @returns {{lit: Array<Array<[number, number]>>, side: Array<Array<[number, number]>>, shade: Array<Array<[number, number]>>}}
 */
export function wallRuns(loops, view) {
  const out = { lit: [], side: [], shade: [] };
  const usable = (loops ?? []).filter((loop) => loop.length >= 3);

  for (const loop of usable) {
    // Which way is out. A loop inside an odd number of the others is a hole,
    // whose inside is the room's outside.
    const area = signedArea(loop);
    const hole = usable.filter((other) => other !== loop && inside(other, loop[0])).length % 2 === 1;
    const outward = area > 0 !== hole ? 1 : -1;

    // Consecutive walls in the same light go in one ribbon, so there are no
    // seams down the middle of a flat side.
    let run = null;
    let runKind = null;
    const flush = () => {
      if (run && run.length > 1) out[runKind].push(run);
      run = null;
      runKind = null;
    };

    for (let i = 0; i < loop.length; i++) {
      const p = loop[i];
      const q = loop[(i + 1) % loop.length];
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const length = Math.hypot(dx, dy);
      if (length < 1e-9) continue;
      const [fx, fy] = view.facing((outward * dy) / length, (-outward * dx) / length);
      const kind = fy <= 0.02 ? null : kindOf(fx * LIGHT[0] + fy * LIGHT[1]);
      if (kind !== runKind) {
        flush();
        if (kind) {
          run = [p];
          runKind = kind;
        }
      }
      if (kind) run.push(q);
    }
    flush();
  }

  return out;
}

/**
 * Walls from `wallRuns`, raised `height` from the ground, as path data.
 *
 * `reach` is how far up the polygon actually goes: a shade more than the
 * height, so whatever is stacked on it overlaps rather than meets it, since
 * meeting edges leave a hairline of whatever is behind. A band's overlap is a
 * share of the band; a wall several bands tall still only needs the one
 * band's worth, which is what its last band used to reach.
 *
 * @param {ReturnType<typeof wallRuns>} runs
 * @param {ReturnType<typeof view3d>} view
 * @param {number} height  in sheet units
 * @param {number} [reach]  how far up it is drawn, in sheet units
 * @returns {{lit: string, side: string, shade: string}}  path data, possibly empty
 */
export function ribbons(runs, view, height, reach = height * 1.15) {
  const draw = (list) => list.map((run) => ribbon(run, view, reach)).join(' ');
  return { lit: draw(runs.lit), side: draw(runs.side), shade: draw(runs.shade) };
}

const kindOf = (light) => (light > 0.55 ? 'lit' : light > 0.05 ? 'side' : 'shade');

/** A run of edges and the same run `reach` higher, as one polygon. */
function ribbon(run, view, reach) {
  const low = run.map(([x, y]) => view.at(x, y, 0));
  const high = run.map(([x, y]) => view.at(x, y, reach)).reverse();
  return `M${[...low, ...high].map(pt).join('L')}Z`;
}

function signedArea(loop) {
  let sum = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x1, y1] = loop[i];
    const [x2, y2] = loop[(i + 1) % loop.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

function inside(loop, [x, y]) {
  let crossing = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, yi] = loop[i];
    const [xj, yj] = loop[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) crossing = !crossing;
  }
  return crossing;
}

/**
 * A colour a little lighter (positive) or darker (negative), as hex. The
 * rooms' colours are already solved for how much light they throw, so the
 * walls are the same colour in the light and in the shade rather than a grey.
 */
export function shade(hex, amount) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex));
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const channel = (v) => {
    const out = amount >= 0 ? v + (255 - v) * amount : v * (1 + amount);
    return Math.max(0, Math.min(255, Math.round(out)));
  };
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(channel);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** How much lighter or darker each kind of wall is than the room it holds up. */
export const WALLS = { lit: 0.12, side: -0.22, shade: -0.45 };

/**
 * How tall something is, in sheet units, for how lively it is (0 to 1).
 *
 * The square root, as for the flat map's shading, so that the difference
 * between silent and occasional shows as clearly as the difference between
 * busy and busier. `floor` is what a silent room still stands: quiet is
 * low, but a room nobody has spoken in yet is the premise of this place and
 * is never flattened into the floor.
 */
export const heightOf = (activity, tallest, floor = 0) =>
  floor + (tallest - floor) * Math.sqrt(Math.max(0, Math.min(1, activity ?? 0)));
