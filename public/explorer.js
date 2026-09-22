import { NS, stroke } from './diagram.js';
import { fitTo } from './minimap.js';
import { TILT, clampTilt, heightOf, shade, view3d } from './relief.js';
import { gestures } from './gestures.js';
import { cullTo, viewBoxOf } from './cull.js';

/**
 * Every interest there is, on one sheet, to find a way round.
 *
 * The map is a neighbourhood: a handful of interests, drawn as the overlaps
 * people make. The interests list is the catalogue as words, a level at a
 * time. This is the third way of looking at the same thing — all of it at
 * once, each interest a dot at its place in the hierarchy, sized by how many
 * hold it, with the divisions and fields written over the patches they
 * cover. It is the minimap, big enough to go into.
 *
 * Names come in as the sheet is zoomed: the dozen divisions from the start,
 * their fields a little closer, and the interests themselves up close, where
 * there is room for them. Somebody looking for something in particular types
 * it instead, and the matches light up and are listed — which is also the way
 * round it for anybody not using a pointer, since a thousand dots is not
 * something to tab through.
 *
 * In relief, as the map is, each dot stands as a column as tall as its
 * interest has been lively lately, against the liveliest on the platform:
 * the sheet tilted away, and turnable, with the talk rising out of it.
 *
 * Lines join interests that people hold together, darker the more of the
 * people holding either hold both. Where an interest sits says what it is;
 * the lines say who else is in it. Most run between neighbours, since what
 * people hold together is usually related, and the few that cross the sheet
 * are the ones worth seeing.
 */

/**
 * How many screen pixels a unit of the sheet has to cover before fields, and
 * then interests, are named. Pixels rather than how far it has been zoomed,
 * because the same zoom on a phone leaves a third of the room: names that fit
 * a desktop at four times closer were a solid mat of words on a phone.
 */
export const FIELDS_AT = 1.3;
export const NAMES_AT = 2.8;

/**
 * Screen sizes, in pixels, of each kind of name and the halo round it, held
 * whatever the zoom. The halo too: at a width in sheet units it swelled with
 * the zoom until it was taking bites out of the dots beside it.
 */
const SIZES = {
  'chart-divisions': { font: 15, halo: 4 },
  'chart-fields': { font: 12, halo: 3 },
  'chart-names': { font: 11, halo: 3 },
};

/** How many matches are listed. The rest are lit on the sheet. */
const LISTED = 8;

/** How many matches can be named on the sheet at any zoom without burying it. */
const FEW = 24;

/**
 * How often, at most, other people's comings and goings draw the sheet again,
 * in milliseconds. The same as the map's: see `REDRAW_EVERY` in app.js.
 */
export const REDRAW_EVERY = 10_000;

/** How many of a picked interest's links are named on the sheet and listed. */
const WITH = 6;

/**
 * Every interest's links, strongest first, from the chart's list of pairs.
 *
 * @param {Array<[string, string, number, number]>} [links]  both, how many hold both, and the share
 * @returns {Map<string, Array<{id: string, both: number, share: number}>>}
 */
export function partnersOf(links = []) {
  const partners = new Map();
  const add = (from, id, both, share) => {
    if (!partners.has(from)) partners.set(from, []);
    partners.get(from).push({ id, both, share });
  };
  for (const [a, b, both, share] of links) {
    add(a, b, both, share);
    add(b, a, both, share);
  }
  for (const list of partners.values()) {
    list.sort((p, q) => q.share - p.share || q.both - p.both || p.id.localeCompare(q.id));
  }
  return partners;
}

/** Which of three weights a link is drawn in, against the strongest there is. */
const weightOf = (share, strongest) => (share >= strongest * 0.6 ? 2 : share >= strongest * 0.3 ? 1 : 0);

/** Dot radius, in sheet units: area for population, and a floor for nobody. */
const radius = (n, biggest) => (n ? 3 + Math.sqrt(n / biggest) * 11 : 2.2);

/**
 * How much of the zoom the dots take part in. Dots that grew with the sheet
 * would never come apart: the facets of one interest sit in a tight knot
 * round it, and at any zoom they overlapped exactly as much as at the start.
 * Growing more slowly than the sheet, they draw apart as it is zoomed.
 */
const GROWTH = 0.4;

const people = (n) => `${n} ${n === 1 ? 'person' : 'people'}`;

/** How tall the liveliest interest's column stands, as a share of the sheet. */
export const COLUMN = 0.11;

/** A twelfth of a turn at a time, as on the map. */
const TURN_STEP = Math.PI / 6;

/**
 * The side of a column `r` wide and `h` tall standing on the origin, as the
 * tilted view sees it: straight sides, and the near half of its foot.
 */
function column(r, h, relief) {
  const up = (h * relief.lift).toFixed(2);
  const ry = (r * relief.squash).toFixed(2);
  const w = r.toFixed(2);
  return `M-${w},-${up}L-${w},0A${w} ${ry} 0 0 0 ${w},0L${w},-${up}Z`;
}

/**
 * Draw the chart into `svg`, and return every drawn node by the interest it
 * belongs to, for marking later without searching the drawing for them.
 *
 * @param {SVGSVGElement} svg
 * @param {{subjects: Array, labels?: Array}} chart  from the server's `chart` frame
 * @param {{held?: Set<string>, relief?: ReturnType<typeof view3d> | null}} [options]
 *   `relief`: stand each interest up as a column, in that view; flat without
 * @returns {Map<string, Element[]>}
 */
export function drawChart(svg, chart, { held = new Set(), relief = null } = {}) {
  const doc = svg.ownerDocument;
  const el = (name, attrs = {}) => {
    const node = doc.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  };

  const nodes = new Map();
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  if (!chart?.subjects?.length) return nodes;

  const biggest = Math.max(1, ...chart.subjects.map((s) => s.n));
  const tallest = (chart.extent ?? 1000) * COLUMN;
  const onSheet = (x, y) => (relief ? relief.at(x, y) : [x, y]);

  // Division names are large and faint, and name a patch of the sheet rather
  // than a point on it. Over the dots all the same, since underneath them
  // they were lost among the thousand things they are the names of.
  const divisions = el('g', { class: 'chart-divisions' });
  const fields = el('g', { class: 'chart-fields' });
  for (const label of chart.labels ?? []) {
    const [x, y] = onSheet(label.x, label.y);
    const text = el('text', { x, y, class: label.depth === 1 ? 'chart-division' : 'chart-field' });
    text.textContent = label.name;
    (label.depth === 1 ? divisions : fields).append(text);
  }

  // What goes with what, under everything else. One path per weight rather
  // than an element per line: fifteen hundred elements would be fifteen
  // hundred things for the browser to lay out, for lines nobody points at.
  // Along the ground in relief, foot to foot, so the columns stand on them.
  // The picked interest's own are drawn one line each, on an empty layer left
  // for them over the dots, where no column can hide them; see `pickedLines`
  // in the explorer.
  const links = el('g', { class: 'chart-links' });
  const where = new Map(chart.subjects.map((s) => [s.id, s]));
  const strongest = Math.max(0, ...(chart.links ?? []).map((l) => l[3]));
  const weights = [[], [], []];
  for (const [a, b, , share] of chart.links ?? []) {
    const p = where.get(a);
    const q = where.get(b);
    if (!p || !q) continue;
    const [x1, y1] = onSheet(p.x, p.y);
    const [x2, y2] = onSheet(q.x, q.y);
    weights[weightOf(share, strongest)].push(`M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}`);
  }
  weights.forEach((d, weight) => {
    if (d.length) links.append(el('path', { d: d.join(''), class: `chart-link weight-${weight}` }));
  });

  // Area carries how many hold an interest here as it does everywhere else.
  // One nobody holds yet is still a dot, only a small faint one, since it can
  // still be joined.
  const dots = el('g', { class: 'chart-dots' });
  const names = el('g', { class: 'chart-names' });
  // In relief, from the back forward, so each column stands in front of the
  // ones behind it.
  const order = relief
    ? [...chart.subjects].sort((p, q) => relief.depth(p.x, p.y) - relief.depth(q.x, q.y))
    : chart.subjects;
  for (const s of order) {
    const r = radius(s.n, biggest);
    const mine = held.has(s.id);
    const kind = `dot${s.n ? '' : ' empty'}${mine ? ' mine' : ''}`;
    let dot;
    let x;
    let top;
    if (relief) {
      // A column: its foot where the dot was, as tall as it is lively, its
      // top the dot itself. Drawn about its own foot and moved there, so
      // growing it with the zoom is one write, not three.
      const h = heightOf(s.a, tallest);
      const [X, Y] = relief.at(s.x, s.y);
      const colour = stroke(s.id);
      dot = el('g', {
        class: kind,
        'data-id': s.id,
        'data-r': r,
        'data-h': h.toFixed(2),
        'data-x': X.toFixed(2),
        'data-y': Y.toFixed(2),
        transform: `translate(${X.toFixed(2)} ${Y.toFixed(2)})`,
      });
      if (h > 0) dot.append(el('path', { d: column(r, h, relief), fill: shade(colour, -0.3), class: 'column' }));
      dot.append(
        el('ellipse', {
          cx: 0,
          cy: (-h * relief.lift).toFixed(2),
          rx: r.toFixed(2),
          ry: (r * relief.squash).toFixed(2),
          fill: colour,
          class: 'column-top',
        }),
      );
      x = X;
      top = Y - h * relief.lift - r * relief.squash;
    } else {
      dot = el('circle', {
        cx: s.x,
        cy: s.y,
        r,
        'data-r': r,
        fill: stroke(s.id),
        class: kind,
        'data-id': s.id,
      });
      x = s.x;
      top = s.y - r;
    }
    const title = el('title');
    title.textContent = s.n ? `${s.id} · ${people(s.n)}` : `${s.id} · nobody yet`;
    dot.append(title);
    dots.append(dot);

    // Above the dot, clear of it at any zoom: the gap is in the same units
    // as the name, which are screen-sized.
    const name = el('text', { x, y: top, dy: '-0.35em', class: `chart-name${mine ? ' mine' : ''}`, 'data-id': s.id });
    name.textContent = s.id;
    names.append(name);
    nodes.set(s.id, [dot, name]);
  }

  svg.append(links, dots, el('g', { class: 'chart-link-picked' }), divisions, fields, names);
  return nodes;
}

/**
 * Move a chart already drawn in relief to another view of it — turned, or
 * tilted — without drawing any of it again.
 *
 * Orbiting by hand asks for a new view every frame, and drawing a thousand
 * columns from nothing took a tenth of a second each time: a view that lags a
 * finger by that much is not being turned, it is being argued with. Nothing
 * about an interest changes as the view goes round, only where it lands, so
 * this moves what is there. Columns are put back in order from the back only
 * when the turn has changed; a tilt alone leaves the order as it was.
 *
 * @param {SVGSVGElement} svg
 * @param {{subjects: Array, labels?: Array, links?: Array}} chart
 * @param {Map<string, Element[]>} nodes  as `drawChart` returned them
 * @param {ReturnType<typeof view3d>} relief
 * @param {{growth?: number, reorder?: boolean}} [options]  how far the columns are scaled with the zoom
 */
export function reprojectChart(svg, chart, nodes, relief, { growth = 1, reorder = true } = {}) {
  const at = (x, y) => relief.at(x, y);

  // The division and field names, which were written in the chart's order.
  const divisions = [...svg.querySelectorAll('.chart-divisions text')];
  const fields = [...svg.querySelectorAll('.chart-fields text')];
  let d = 0;
  let f = 0;
  for (const label of chart.labels ?? []) {
    const text = label.depth === 1 ? divisions[d++] : fields[f++];
    if (!text) continue;
    const [x, y] = at(label.x, label.y);
    text.setAttribute('x', x);
    text.setAttribute('y', y);
  }

  // The links along the ground: three paths, rewritten.
  const where = new Map(chart.subjects.map((s) => [s.id, s]));
  const strongest = Math.max(0, ...(chart.links ?? []).map((l) => l[3]));
  const weights = [[], [], []];
  for (const [a, b, , share] of chart.links ?? []) {
    const p = where.get(a);
    const q = where.get(b);
    if (!p || !q) continue;
    const [x1, y1] = at(p.x, p.y);
    const [x2, y2] = at(q.x, q.y);
    weights[weightOf(share, strongest)].push(`M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}`);
  }
  weights.forEach((lines, weight) => {
    svg.querySelector(`.chart-links .weight-${weight}`)?.setAttribute('d', lines.join(''));
  });

  // Each column, and the name over it.
  const k = growth.toFixed(4);
  for (const s of chart.subjects) {
    const [dot, name] = nodes.get(s.id) ?? [];
    if (!dot || !dot.hasAttribute('data-h')) continue;
    const r = Number(dot.getAttribute('data-r'));
    const h = Number(dot.getAttribute('data-h'));
    const [X, Y] = at(s.x, s.y);
    dot.setAttribute('data-x', X.toFixed(2));
    dot.setAttribute('data-y', Y.toFixed(2));
    dot.setAttribute('transform', `translate(${X.toFixed(2)} ${Y.toFixed(2)}) scale(${k})`);
    for (const part of dot.children) {
      if (part.classList.contains('column')) part.setAttribute('d', column(r, h, relief));
      else if (part.classList.contains('column-top')) {
        part.setAttribute('cy', (-h * relief.lift).toFixed(2));
        part.setAttribute('ry', (r * relief.squash).toFixed(2));
      }
    }
    name?.setAttribute('x', X.toFixed(2));
    name?.setAttribute('y', (Y - (h * relief.lift + r * relief.squash) * growth).toFixed(2));
  }

  if (reorder) orderChart(svg, chart, nodes, relief);
}

/**
 * Put the columns back in order from the back, for a view. The dearest part
 * of moving them — every column taken out and put back — so while a view is
 * being orbited it is done only now and then, and once more when it stops.
 */
export function orderChart(svg, chart, nodes, relief) {
  const layer = svg.querySelector('.chart-dots');
  const backFirst = [...chart.subjects].sort((p, q) => relief.depth(p.x, p.y) - relief.depth(q.x, q.y));
  for (const s of backFirst) {
    const dot = nodes.get(s.id)?.[0];
    if (dot) layer?.append(dot);
  }
}

/**
 * Matches for what was typed: those starting with it first, then the busiest,
 * then alphabetically, so the one meant is usually at the top.
 */
export function findIn(subjects, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [];
  return subjects
    .filter((s) => s.id.includes(q))
    .sort(
      (a, b) =>
        Number(b.id.startsWith(q)) - Number(a.id.startsWith(q)) || b.n - a.n || a.id.localeCompare(b.id),
    );
}

/**
 * Run the explorer's dialog.
 *
 * Everything that means something outside the sheet is handed in: what this
 * person holds, and what joining, leaving, browsing and opening a room are.
 *
 * @param {Document} doc
 * @param {object} hooks
 * @param {() => void} hooks.ask  ask the server for the chart
 * @param {() => Set<string>} hooks.held  interests held, as the catalogue names them
 * @param {(id: string) => void} hooks.join
 * @param {(id: string) => void} hooks.leave
 * @param {(field: string) => void} hooks.browse  show a field in the interests list
 * @param {(id: string) => boolean} hooks.room  open an interest's conversation, if it can be
 * @param {() => void} [hooks.opened]  called as it opens, to put anything else away
 * @param {() => boolean} [hooks.relief]  whether to draw it in relief
 * @param {(on: boolean) => void} [hooks.setRelief]  change that, for the map too
 */
export function mountExplorer(doc, hooks) {
  const $ = (id) => doc.getElementById(id);
  const dialog = $('explorer');
  const svg = $('explorer-chart');
  const find = $('explorer-find');
  const found = $('explorer-found');
  if (!dialog || !svg) return null;

  let chart = null;
  let drawnChart = '';
  // When the sheet was last drawn from new data, and the chart waiting to be
  // drawn next: see `receive`.
  let drewAt = 0;
  let redrawDue = null;
  let waitingChart = null;
  let nodes = new Map();
  let view = null;
  let whole = null;
  let picked = null;
  let growth = 1;
  // The view it was last drawn in, or null for flat, and how far it is turned
  // and tilted.
  let relief = null;
  let turn = 0;
  let tilt = TILT;
  // The turn the columns were last put in order for, and the wait before
  // they are put in order once orbiting stops; see `orderChart`.
  let orderedFor = null;
  let settling = null;
  const byId = new Map();
  const lit = new Set();
  // Every interest's links, and the strongest share there is, for drawing the
  // picked one's in the same weights as the rest; and which are lit as linked.
  let partners = new Map();
  let strongest = 1;
  const linked = new Set();
  // What is in view, and at what share of the zoom each column was last
  // drawn: see `cull`. A column off the view is not painted, and not kept up
  // with the zoom either; it is put right when it comes back.
  let parts = [];
  const partOf = new Map();
  const placedAt = new Map();

  // --- showing it ------------------------------------------------------------

  function open() {
    hooks.opened?.();
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.open = true;
    }
    // Relief may have been switched on the map since this was last drawn.
    if (chart && Boolean(relief) !== Boolean(hooks.relief?.())) draw();
    // Fresh each time: counts move, and the interest somebody went away and
    // created is on it when they come back.
    hooks.ask();
    // Straight into the search where there is a keyboard; on a phone the
    // keyboard would cover the sheet before anybody asked to type.
    if (globalThis.matchMedia?.('(hover: hover) and (pointer: fine)').matches) find.focus();
  }

  function close() {
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.open = false;
  }

  /**
   * A chart from the server, drawn. The first is framed on the whole of it;
   * after that wherever somebody had got to is kept, since a refresh is not a
   * reason to lose their place.
   */
  function receive(next) {
    // The same chart again — asked for on every opening, and after every
    // change to what is held — is not drawn again: the sheet stays as it is,
    // and only what is held is marked afresh.
    const drawn = JSON.stringify([next.subjects, next.labels, next.links, next.extent]);
    if (chart !== null && drawn === drawnChart && nodes.size) {
      adopt(next, drawn);
      refresh();
      return;
    }
    // A different one. The first is drawn at once; after that, a chart is
    // asked for again whenever anybody joins or leaves anything near what is
    // held, and each would have drawn a thousand columns again. So it is
    // drawn at most once every `REDRAW_EVERY`, with the latest to arrive,
    // and what is held is marked on the one standing in the meantime.
    const wait = nodes.size ? drewAt + REDRAW_EVERY - Date.now() : 0;
    if (wait > 0) {
      waitingChart = next;
      redrawDue ??= setTimeout(() => {
        redrawDue = null;
        const latest = waitingChart;
        waitingChart = null;
        // Closed in the meantime: opening it asks for a fresh one anyway.
        if (latest && dialog.open) receive(latest);
      }, wait);
      refresh();
      return;
    }
    clearTimeout(redrawDue);
    redrawDue = null;
    waitingChart = null;
    adopt(next, drawn);
    drewAt = Date.now();
    draw();
  }

  /** Take a chart as the one to show: its interests, and their links. */
  function adopt(next, drawn) {
    drawnChart = drawn;
    chart = next;
    byId.clear();
    for (const s of chart.subjects ?? []) byId.set(s.id, s);
    partners = partnersOf(chart.links);
    strongest = Math.max(0, ...(chart.links ?? []).map((l) => l[3])) || 1;
  }

  const standing = (s) => heightOf(s.a, (chart?.extent ?? 1000) * COLUMN);

  /**
   * Draw what there is, in relief or flat as asked. Drawn some other way than
   * last time — turned, tilted, raised or laid flat — it keeps one point of
   * the sheet where it was on the screen, at the same zoom, rather than
   * starting again: the point between the fingers turning it, or the middle.
   *
   * @param {{anchor?: [number, number] | null}} [options]  a screen point to keep still
   */
  function draw({ anchor = null } = {}) {
    if (!chart) return;
    const was = relief;
    const box = boxOf();
    const fx = anchor ? (anchor[0] - box.left) / box.width : 0.5;
    const fy = anchor ? (anchor[1] - box.top) / box.height : 0.5;
    const held = view ? [view.x + fx * view.width, view.y + fy * view.height] : null;
    const underfoot = held ? (was ? was.ground(...held) : held) : null;
    const closer = view && whole ? whole.width / view.width : 1;

    relief = hooks.relief?.() ? view3d({ turn, tilt }) : null;
    const changed =
      Boolean(was) !== Boolean(relief) || (was && relief && (was.turn !== relief.turn || was.tilt !== relief.tilt));
    nodes = drawChart(svg, chart, { held: hooks.held(), relief });
    orderedFor = relief?.turn ?? null;
    growth = 1;
    placedAt.clear();
    for (const id of nodes.keys()) placedAt.set(id, 1);
    partOf.clear();
    measure();
    lit.clear();
    const points = (chart.subjects ?? []).flatMap((s) =>
      relief ? [relief.at(s.x, s.y), relief.at(s.x, s.y, standing(s))] : [[s.x, s.y]],
    );
    whole = fitTo(svg, points, 28);
    if (!view) view = whole;
    else if (changed && underfoot && whole) {
      const [x, y] = relief ? relief.at(...underfoot) : underfoot;
      const width = whole.width / closer;
      const height = width * (view.height / view.width);
      view = { x: x - fx * width, y: y - fy * height, width, height };
    }
    for (const id of ['explorer-turn-left', 'explorer-turn-right']) if ($(id)) $(id).disabled = !relief;
    $('explorer-relief')?.setAttribute('aria-pressed', String(Boolean(relief)));
    apply();
    search(find.value);
    if (picked && byId.has(picked)) select(picked);
  }

  /** What is held has changed: mark it, and say so if it is the one picked. */
  function refresh() {
    if (!chart) return;
    const held = hooks.held();
    for (const [id, marks] of nodes) {
      for (const node of marks) node.classList.toggle('mine', held.has(id));
    }
    if (picked) select(picked);
  }

  // --- where the sheet is looked at from -------------------------------------

  const boxOf = () => {
    const box = svg.getBoundingClientRect?.();
    return box?.width ? box : { left: 0, top: 0, width: 600, height: 600, guessed: true };
  };

  /**
   * A box round each interest where it is drawn now, for `cull`: a column
   * from its foot to its top, a dot flat, each at the largest it is ever
   * drawn, since the view closing in only ever shrinks them (see `GROWTH`).
   * Worked out from the numbers that placed it, never measured. Whether it was
   * in view is carried over, since the nodes are the same ones and say so.
   */
  function measure() {
    parts = [];
    for (const s of chart?.subjects ?? []) {
      const pair = nodes.get(s.id);
      if (!pair) continue;
      const [dot] = pair;
      const r = Number(dot.getAttribute('data-r'));
      let box;
      if (relief) {
        const X = Number(dot.getAttribute('data-x'));
        const Y = Number(dot.getAttribute('data-y'));
        const h = Number(dot.getAttribute('data-h')) || 0;
        box = { x0: X - r, x1: X + r, y0: Y - h * relief.lift - r * relief.squash, y1: Y + r * relief.squash };
      } else {
        box = { x0: s.x - r, x1: s.x + r, y0: s.y - r, y1: s.y + r };
      }
      const part = { id: s.id, box, nodes: pair, on: partOf.get(s.id)?.on };
      partOf.set(s.id, part);
      parts.push(part);
    }
  }

  /**
   * Put the columns off the view out of the drawing, and back when they come
   * into it; see `public/cull.js`. Kept: a twentieth of the view past each
   * edge, and room for a name above and either side of a column, since names
   * are sized to the screen and not to the sheet. Only once the sheet has
   * been measured: a view worked out against a guessed size is no reason to
   * hide anything.
   *
   * @param {{guessed?: boolean}} box
   * @param {number} scale  screen pixels to a unit of the sheet
   * @param {number} k  the share of the zoom columns are about to be drawn at
   */
  function cull(box, scale, k) {
    if (box.guessed || !parts.length) return;
    const mx = view.width * 0.05 + 120 / scale;
    const my = view.height * 0.05 + 30 / scale;
    cullTo(parts, viewBoxOf(view, mx, my), (part, on) => {
      if (on && placedAt.get(part.id) !== k) place(part.id, k);
    });
  }

  function apply(box = boxOf()) {
    if (!view) return;
    // The box's own shape decides the view's, so a window resized while it is
    // open does not stretch the sheet; see `fitTo` for why it is not left to
    // `preserveAspectRatio`.
    view = { ...view, height: view.width * (box.height / box.width) };
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.width} ${view.height}`);
    svg.setAttribute('preserveAspectRatio', 'none');

    // Names hold their size on the screen, so their size on the sheet shrinks
    // as the sheet grows under them: one write per group, which the names in
    // it inherit.
    const scale = box.width / view.width;
    // Division names are wider than the patches they name on a narrow screen,
    // so there they are set smaller; the rest are already as small as reads.
    const narrow = Math.min(1, Math.max(0.7, box.width / 800));
    for (const [cls, { font, halo }] of Object.entries(SIZES)) {
      const shrink = cls === 'chart-divisions' ? narrow : 1;
      const group = svg.querySelector(`.${cls}`);
      group?.setAttribute('font-size', ((font * shrink) / scale).toFixed(2));
      group?.setAttribute('stroke-width', ((halo * shrink) / scale).toFixed(2));
    }
    svg.classList.toggle('near', scale >= FIELDS_AT);
    svg.classList.toggle('close', scale >= NAMES_AT);
    const closer = whole ? whole.width / view.width : 1;
    const k = Math.min(1, closer ** (GROWTH - 1));
    // What the columns will be drawn at: `resize` lets a change of under a
    // hundredth go, so the ones coming into view match the ones already in it.
    cull(box, scale, Math.abs(k - growth) < growth * 0.01 ? growth : k);
    resize(k);
  }

  /**
   * Dots, and the names above them, at a new share of the zoom. Only when the
   * zoom has actually changed: a drag moves the sheet a hundred times without
   * changing its scale, and a thousand dots rewritten each time is waste.
   */
  function resize(k) {
    if (Math.abs(k - growth) < growth * 0.01) return;
    growth = k;
    for (const id of nodes.keys()) {
      // Off the view, it waits until it is back in it; see `cull`.
      if (partOf.get(id)?.on === false || placedAt.get(id) === k) continue;
      place(id, k);
    }
    if (relief && picked) pickedLines(picked);
  }

  /** One column, or dot, and the name over it, at a share `k` of the zoom. */
  function place(id, k) {
    const [dot, name] = nodes.get(id) ?? [];
    if (!dot) return;
    placedAt.set(id, k);
    const r = Number(dot.getAttribute('data-r')) * k;
    if (relief) {
      // The whole column, about its foot: it grows with the zoom as the
      // dots do, height and all.
      const x = dot.getAttribute('data-x');
      const y = Number(dot.getAttribute('data-y'));
      const h = Number(dot.getAttribute('data-h')) * k;
      dot.setAttribute('transform', `translate(${x} ${y.toFixed(2)}) scale(${k.toFixed(4)})`);
      name.setAttribute('y', (y - h * relief.lift - r * relief.squash).toFixed(2));
    } else {
      dot.setAttribute('r', r.toFixed(2));
      name.setAttribute('y', (byId.get(id).y - r).toFixed(2));
    }
  }

  /** Bring an interest's dot and name in front of their neighbours. */
  const raise = (id) => {
    for (const node of nodes.get(id) ?? []) node.parentNode?.append(node);
  };

  /** Zoom by `factor`, keeping the sheet point under (cx, cy) where it is. */
  function zoom(factor, cx, cy) {
    if (!view || !whole) return;
    const box = boxOf();
    const fx = cx === undefined ? 0.5 : (cx - box.left) / box.width;
    const fy = cy === undefined ? 0.5 : (cy - box.top) / box.height;
    const ux = view.x + fx * view.width;
    const uy = view.y + fy * view.height;
    // Out no further than a little past all of it, and in no further than a
    // single interest's neighbours.
    const width = Math.min(whole.width * 1.25, Math.max(whole.width / 40, view.width / factor));
    const height = width * (box.height / box.width);
    view = { x: ux - fx * width, y: uy - fy * height, width, height };
    apply();
  }

  /** Put an interest in the middle, close enough to read its name. */
  function flyTo(id) {
    const s = byId.get(id);
    if (!s || !whole) return;
    const box = boxOf();
    const width = Math.min(view?.width ?? whole.width, box.width / (NAMES_AT * 1.25));
    const height = width * (box.height / box.width);
    // In relief, on the middle of its column rather than its foot.
    const [x, y] = relief ? relief.at(s.x, s.y, standing(s) / 2) : [s.x, s.y];
    view = { x: x - width / 2, y: y - height / 2, width, height };
    apply();
  }

  // Turned and tilted by hand, gathered up and drawn once a frame: fingers
  // report movement far more often than a thousand columns can be redrawn.
  let orbiting = null;
  const frame = globalThis.requestAnimationFrame ?? ((later) => setTimeout(later, 16));
  function orbit(byTurn, byTilt, anchor) {
    if (!relief) return;
    if (!orbiting) {
      orbiting = { turn: 0, tilt: 0, anchor: null };
      frame(() => {
        const { turn: t, tilt: l, anchor: a } = orbiting;
        orbiting = null;
        turn = (turn + t) % (Math.PI * 2);
        tilt = clampTilt(tilt + l);
        reorient(a);
      });
    }
    orbiting.turn += byTurn;
    orbiting.tilt += byTilt;
    orbiting.anchor = anchor ?? orbiting.anchor;
  }

  // Moved with one finger, orbited with two, pinched, wheeled, double-tapped:
  // see `public/gestures.js`. A tap is a choice of whatever interest was
  // under it when it was pressed.
  gestures(svg, {
    canOrbit: () => Boolean(relief),
    pan: (dx, dy) => {
      if (!view) return;
      const box = boxOf();
      view = { ...view, x: view.x - (dx / box.width) * view.width, y: view.y - (dy / box.height) * view.height };
      apply();
    },
    zoom: (factor, x, y) => zoom(factor, x, y),
    orbit,
    tap: (tap) => {
      const id = tap.target?.closest?.('[data-id]')?.getAttribute('data-id');
      if (id) select(id, { say: true });
    },
  });

  $('explorer-in')?.addEventListener('click', () => zoom(1.6));
  $('explorer-out')?.addEventListener('click', () => zoom(1 / 1.6));
  $('explorer-home')?.addEventListener('click', () => {
    view = whole;
    apply();
  });
  const turnBy = (by) => {
    if (!relief) return;
    turn = (turn + by) % (Math.PI * 2);
    reorient(null);
  };

  /**
   * Turned or tilted: everything moved where the new view puts it, one point
   * of the sheet kept where it was on the screen. See `reprojectChart`.
   */
  function reorient(anchor) {
    if (!chart || !relief || !view || !whole) return draw({ anchor });
    const was = relief;
    const box = boxOf();
    const fx = anchor ? (anchor[0] - box.left) / box.width : 0.5;
    const fy = anchor ? (anchor[1] - box.top) / box.height : 0.5;
    const underfoot = was.ground(view.x + fx * view.width, view.y + fy * view.height);
    const closer = whole.width / view.width;

    relief = view3d({ turn, tilt });
    // In order again only once it has turned far enough for the order to be
    // visibly wrong, and exactly once it stops: see `orderChart`.
    const apart = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    const reorder = orderedFor === null || apart(relief.turn, orderedFor) > 0.15;
    if (reorder) orderedFor = relief.turn;
    reprojectChart(svg, chart, nodes, relief, { growth, reorder });
    for (const id of nodes.keys()) placedAt.set(id, growth);
    measure();
    clearTimeout(settling);
    if (orderedFor !== relief.turn) {
      settling = setTimeout(() => {
        if (!relief || !chart) return;
        orderedFor = relief.turn;
        orderChart(svg, chart, nodes, relief);
        for (const id of lit) raise(id);
        if (picked) raise(picked);
      }, 180);
    }
    const points = chart.subjects.flatMap((s) => [relief.at(s.x, s.y), relief.at(s.x, s.y, standing(s))]);
    // The box measured before anything moved: see `fitTo`.
    whole = fitTo(svg, points, 28, box);
    const [x, y] = relief.at(...underfoot);
    const width = whole.width / closer;
    const height = width * (view.height / view.width);
    view = { x: x - fx * width, y: y - fy * height, width, height };
    apply(box);
    // Put back in order from the back, what was lit and picked comes to the
    // front again.
    for (const id of lit) raise(id);
    if (picked) {
      raise(picked);
      pickedLines(picked);
    }
  }
  $('explorer-turn-left')?.addEventListener('click', () => turnBy(-TURN_STEP));
  $('explorer-turn-right')?.addEventListener('click', () => turnBy(TURN_STEP));
  $('explorer-relief')?.addEventListener('click', () => {
    hooks.setRelief?.(!hooks.relief?.());
    draw();
  });
  $('explorer-close')?.addEventListener('click', close);

  // The darkened part outside closes it, but only for a press that began
  // there: a drag off the edge of the sheet ends on the dialog, and is not a
  // request to leave. The same care the interests dialog takes.
  let outside = false;
  dialog.addEventListener('pointerdown', (evt) => {
    outside = evt.target === dialog;
  });
  dialog.addEventListener('click', (evt) => {
    if (outside && evt.target === dialog) close();
    outside = false;
  });

  // --- one interest, picked ----------------------------------------------------

  /**
   * Show what one interest is and what can be done with it. Called again
   * whenever what is held changes, to keep the buttons true — which rebuilds
   * them, so focus is put back on the new first one if it was on the old.
   */
  function select(id, { say = false } = {}) {
    const s = byId.get(id);
    if (!s) return;
    if (picked !== id) {
      for (const node of nodes.get(picked) ?? []) node.classList.remove('picked');
    }
    picked = id;
    for (const node of nodes.get(id) ?? []) node.classList.add('picked');
    raise(id);

    const held = hooks.held().has(id);
    $('explorer-hint').hidden = true;
    $('explorer-pick').hidden = false;
    $('explorer-name').textContent = id;
    // Where it sits, broadest first: arts › visual art › photography.
    $('explorer-path').textContent = s.up?.length
      ? [...s.up].reverse().join(' › ')
      : 'Not in the catalogue yet: somebody made it.';
    const count = s.n
      ? `${s.n === 1 ? '1 person holds' : `${s.n} people hold`} it${held ? ', you among them' : ''}.`
      : held
        ? 'You are the first here.'
        : 'Nobody has joined it yet. You could be the first.';
    $('explorer-people').textContent = count;

    const actions = $('explorer-actions');
    const focused = actions.contains(doc.activeElement);
    actions.textContent = '';
    const button = (words, run, { primary = false, name } = {}) => {
      const b = doc.createElement('button');
      b.type = 'button';
      if (primary) b.className = 'join-here';
      b.textContent = words;
      if (name) b.setAttribute('aria-label', name);
      b.addEventListener('click', run);
      actions.append(b);
      return b;
    };
    if (held) {
      button('Open its conversation', () => {
        if (hooks.room(id)) close();
        else $('explorer-people').textContent = 'Its conversation is not on the map yet. Try again in a moment.';
      }, { primary: true, name: `Open the ${id} conversation` });
      button('Leave', () => hooks.leave(id), { name: `Leave ${id}` });
    } else {
      button('Join', () => hooks.join(id), { primary: true, name: `Join ${id}` });
    }
    const field = s.up?.[0];
    if (field) {
      button(`Browse ${field}`, () => {
        close();
        hooks.browse(field);
      });
    }
    const following = $('explorer-with')?.contains(doc.activeElement);
    showLinks(id);
    // Following a link lands on what can be done with where it went.
    if (focused || following) actions.querySelector('button')?.focus();
    if (say) $('explorer-said').textContent = `${id}. ${count}`;
  }

  /**
   * The picked interest's own lines, over the dots. In relief, from the top
   * of its column to the tops of the others, at the height they stand at
   * this zoom, so they run above the columns rather than behind them; drawn
   * again whenever the zoom changes that height.
   */
  function pickedLines(id) {
    const layer = svg.querySelector('.chart-link-picked');
    if (!layer) return;
    while (layer.firstChild) layer.removeChild(layer.firstChild);
    const from = byId.get(id);
    const at = (s) => (relief ? relief.at(s.x, s.y, standing(s) * growth) : [s.x, s.y]);
    for (const link of partners.get(id) ?? []) {
      const to = byId.get(link.id);
      if (!from || !to) continue;
      const [x1, y1] = at(from);
      const [x2, y2] = at(to);
      const line = doc.createElementNS(NS, 'line');
      for (const [k, v] of Object.entries({ x1, y1, x2, y2 })) line.setAttribute(k, v.toFixed(1));
      line.setAttribute('class', `weight-${weightOf(link.share, strongest)}`);
      layer.append(line);
    }
  }

  /**
   * The picked interest's links, drawn over the rest in the accent, the
   * interests at the far ends named, and the same listed beside the sheet,
   * where each is a way to go there.
   */
  function showLinks(id) {
    for (const other of linked) for (const node of nodes.get(other) ?? []) node.classList.remove('linked');
    linked.clear();
    const mine = partners.get(id) ?? [];
    svg.classList.toggle('linking', mine.length > 0);
    pickedLines(id);
    for (const link of mine.slice(0, WITH)) {
      linked.add(link.id);
      for (const node of nodes.get(link.id) ?? []) node.classList.add('linked');
    }

    const list = $('explorer-with');
    if (!list) return;
    list.textContent = '';
    for (const link of mine.slice(0, WITH)) {
      const li = doc.createElement('li');
      const b = doc.createElement('button');
      b.type = 'button';
      const name = doc.createElement('span');
      name.textContent = link.id;
      const n = doc.createElement('span');
      n.className = 'count';
      n.textContent = String(link.both);
      b.append(name, n);
      const both = `${link.both} people hold both`;
      b.title = both;
      b.setAttribute('aria-label', `${link.id}, ${both}`);
      b.addEventListener('click', () => choose(link.id));
      li.append(b);
      list.append(li);
    }
    $('explorer-with-wrap').hidden = !mine.length;
  }

  // --- finding one -------------------------------------------------------------

  function search(query) {
    found.textContent = '';
    for (const id of lit) for (const node of nodes.get(id) ?? []) node.classList.remove('found');
    lit.clear();
    const matches = chart ? findIn(chart.subjects, query) : [];
    const searching = Boolean(String(query ?? '').trim());
    svg.classList.toggle('searching', searching);
    if (!searching || !chart) return matches;

    // A few matches are named wherever they are; a short query matching
    // hundreds would bury the sheet in them, so those wait for the zoom.
    svg.classList.toggle('few', matches.length <= FEW);
    for (const s of matches) {
      lit.add(s.id);
      for (const node of nodes.get(s.id) ?? []) node.classList.add('found');
      raise(s.id);
    }
    if (picked) raise(picked);

    for (const s of matches.slice(0, LISTED)) {
      const li = doc.createElement('li');
      const b = doc.createElement('button');
      b.type = 'button';
      const name = doc.createElement('span');
      name.textContent = s.id;
      const n = doc.createElement('span');
      n.className = 'count';
      n.textContent = s.n ? String(s.n) : '';
      b.append(name, n);
      b.setAttribute('aria-label', `${s.id}, ${s.n ? people(s.n) : 'nobody yet'}`);
      b.addEventListener('click', () => choose(s.id));
      li.append(b);
      found.append(li);
    }
    const li = doc.createElement('li');
    li.className = 'explorer-more';
    li.textContent = !matches.length
      ? 'No interest by that name. Create it from Interests.'
      : matches.length > LISTED
        ? `${matches.length - LISTED} more lit on the map.`
        : '';
    if (li.textContent) found.append(li);
    return matches;
  }

  function choose(id) {
    flyTo(id);
    select(id, { say: true });
  }

  find.addEventListener('input', () => search(find.value));
  find.addEventListener('keydown', (evt) => {
    if (evt.key !== 'Enter') return;
    evt.preventDefault();
    const [first] = search(find.value);
    if (first) choose(first.id);
  });

  return {
    open,
    close,
    receive,
    refresh,
    get isOpen() {
      return Boolean(dialog.open);
    },
  };
}
