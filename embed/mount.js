/**
 * The map, in an element you own, with no server involved.
 *
 * Everything else here has assumed a socket: the page connects, the server
 * decides what that person should see, and frames arrive. That is right for a
 * live chat room and wrong for embedding, where the usual case is an
 * application that already holds its users and their interests and wants a
 * picture of them.
 *
 * So this takes data and draws. No connection, no polling, nothing async —
 * hand it rows, point it at a person, and it renders. The chat server is one
 * source of that data; a database query is another.
 *
 * Framework-agnostic on purpose. `embed/react.js` is thirty lines on top of
 * this, and the same thirty would serve Vue or Svelte or nothing at all.
 */

import { census, neighbourhood, restrict, receives, parse, zones, buildIndex } from '../lib/regions.js';
import { layout } from '../lib/euler.js';
import { atlas } from '../lib/atlas.js';
import { anchorsFor, distanceBetween, radialLayout } from '../lib/taxonomy.js';
import { knowledge } from '../lib/knowledge.js';
import { fromRows } from '../lib/adapt.js';
import { renderDiagram, regionAt, scopeOf } from '../public/diagram.js';
import { renderAtlas, zoneAt, paintAtlas, relabel } from '../public/atlasview.js';
import { fitTo, pointsOf } from '../public/minimap.js';

const NS = 'http://www.w3.org/2000/svg';

/** Cached: laying the hierarchy out is the same work for every caller. */
let placed = null;
const hierarchy = () => (placed ??= radialLayout(knowledge));

/**
 * What one person should see, computed from data rather than asked of a server.
 *
 * The same shape `World.diagramFor` returns, so the renderers cannot tell the
 * difference and there is no second version of the view to keep in step.
 */
export function viewFor(data, options = {}) {
  const { focus = null, limit = 3, novelty = 0, view = 'map' } = options;
  const subscriptions = data.subscriptions ?? [];
  const counts = census(subscriptions);
  const index = buildIndex(counts);

  const person = focus == null ? null : data.people?.find((p) => p.id === String(focus));
  const held = new Set(person?.subjects ?? []);
  const want = options.subjects ?? null;

  const picked = want
    ? { subjects: [...want], hidden: [], suggested: [] }
    : neighbourhood(counts, held, view === 'atlas' ? Math.max(limit, 5) : limit, index, {
        novelty: person?.novelty ?? novelty,
        distance: distanceBetween(knowledge),
      });

  const roomsOf = (keys) =>
    keys
      .map((k) => {
        const tags = parse(k);
        return {
          key: k,
          subjects: tags,
          population: counts.get(k) ?? 0,
          member: held.size > 0 && receives(held, tags),
        };
      })
      .sort((a, b) => a.subjects.length - b.subjects.length || a.key.localeCompare(b.key));

  if (view === 'atlas') {
    const drawn = atlas(zones(subscriptions, picked.subjects), {
      anchors: anchorsFor(picked.subjects, hierarchy()),
      ...(options.mold ? { mold: options.mold } : {}),
    });
    return {
      ...drawn,
      subscription: [...held].sort(),
      rooms: drawn.zones.map((zone) => ({
        key: zone.key,
        subjects: zone.subjects,
        here: zone.population,
        population: counts.get(zone.key) ?? zone.population,
        member: held.size > 0 && receives(held, zone.subjects),
      })),
    };
  }

  const local = restrict(counts, picked.subjects);
  return {
    ...layout(local),
    rooms: roomsOf([...local.keys()]),
    subscription: [...held].sort(),
    suggested: picked.suggested ?? [],
    hidden: picked.hidden ?? [],
  };
}

/**
 * Draw into `element` and keep it up to date.
 *
 * @param {Element} element
 * @param {object} options
 * @param {Array} [options.users]      rows, as your application already has them
 * @param {Array} [options.interests]  the join table, if interests live apart
 * @param {object} [options.columns]   which column means what; guessed if omitted
 * @param {object} [options.data]      already-adapted data, instead of rows
 * @param {string} [options.focus]     whose neighbourhood to show
 * @param {'map'|'atlas'} [options.view='map']
 * @param {number} [options.novelty]   0 goes deeper, 1 reaches further out
 * @param {(room: object) => void} [options.onSelect]
 * @param {(room: object|null) => void} [options.onHover]
 * @returns {{update, destroy, select, data, view}}
 */
export function mountMap(element, options = {}) {
  if (!element) throw new TypeError('mountMap needs an element to draw into');

  const doc = element.ownerDocument;
  const svg = doc.createElementNS(NS, 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.style.display = 'block';
  svg.style.touchAction = 'none';
  element.append(svg);

  const state = {
    options: {},
    data: null,
    view: null,
    selected: null,
    fills: new Map(),
    territories: new Map(),
    written: [],
    viewBox: null,
    fitted: null,
  };

  const adapt = (opts) =>
    opts.data ??
    fromRows(
      { users: opts.users ?? [], interests: opts.interests },
      opts.columns ?? {},
      { hierarchy: hierarchy() },
    );

  function draw() {
    const opts = state.options;
    state.view = viewFor(state.data, opts);

    if (opts.view === 'atlas') {
      ({ territories: state.territories, written: state.written } = renderAtlas(svg, state.view));
      const own = pointsOf(state.view.curves, state.view.subscription);
      state.viewBox = fitTo(svg, own.length ? own : pointsOf(state.view.curves), opts.padding ?? 20);
      state.fitted = state.viewBox?.width;
      applyView();
      paintAtlas(state.territories, state.selected);
    } else {
      ({ fills: state.fills } = renderDiagram(svg, state.view));
      paint();
    }
    opts.onRender?.(state.view);
  }

  function applyView() {
    if (!state.viewBox) return;
    const { x, y, width, height } = state.viewBox;
    svg.setAttribute('viewBox', `${x} ${y} ${width} ${height}`);
    const box = svg.getBoundingClientRect?.() ?? { width: 600 };
    relabel(state.written, (box.width || 600) / width);
  }

  function paint() {
    const scope = scopeOf([...state.fills.keys()], state.selected);
    for (const [key, node] of state.fills) {
      node.setAttribute('opacity', scope.has(key) ? 0.42 : 0.14);
    }
  }

  const repaint = () =>
    state.options.view === 'atlas' ? paintAtlas(state.territories, state.selected) : paint();

  const at = (evt) => {
    const ctm = svg.getScreenCTM?.();
    if (!ctm) return null;
    const point = new DOMPoint(evt.clientX, evt.clientY).matrixTransform(ctm.inverse());
    return state.options.view === 'atlas'
      ? zoneAt(state.view?.curves ?? [], point.x, point.y)
      : regionAt(state.view?.circles ?? [], point.x, point.y);
  };

  const onClick = (evt) => {
    if (drag?.moved > 4) return;
    const key = at(evt);
    const room = state.view?.rooms?.find((r) => r.key === key) ?? null;
    if (!room) return;
    state.selected = key;
    repaint();
    state.options.onSelect?.(room);
  };

  const onMove = (evt) => {
    if (drag) {
      pan(evt);
      return;
    }
    if (!state.options.onHover) return;
    const key = at(evt);
    state.options.onHover(state.view?.rooms?.find((r) => r.key === key) ?? null);
  };

  // --- pan and zoom, atlas only ---------------------------------------------

  let drag = null;

  const onWheel = (evt) => {
    if (state.options.view !== 'atlas' || !state.viewBox) return;
    evt.preventDefault();
    const factor = evt.deltaY < 0 ? 1.18 : 1 / 1.18;
    const box = svg.getBoundingClientRect();
    const vb = state.viewBox;
    const fx = (evt.clientX - box.left) / (box.width || 1);
    const fy = (evt.clientY - box.top) / (box.height || 1);
    const ux = vb.x + fx * vb.width;
    const uy = vb.y + fy * vb.height;
    const base = state.fitted ?? vb.width;
    const width = Math.min(base * 1.2, Math.max(base / 60, vb.width / factor));
    const height = width * (vb.height / vb.width);
    state.viewBox = { x: ux - fx * width, y: uy - fy * height, width, height };
    applyView();
  };

  const onDown = (evt) => {
    if (state.options.view !== 'atlas' || !state.viewBox) return;
    drag = { x: evt.clientX, y: evt.clientY, moved: 0 };
    svg.setPointerCapture?.(evt.pointerId);
  };

  const pan = (evt) => {
    const box = svg.getBoundingClientRect();
    const dx = ((evt.clientX - drag.x) / (box.width || 1)) * state.viewBox.width;
    const dy = ((evt.clientY - drag.y) / (box.height || 1)) * state.viewBox.height;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    drag.x = evt.clientX;
    drag.y = evt.clientY;
    state.viewBox = { ...state.viewBox, x: state.viewBox.x - dx, y: state.viewBox.y - dy };
    applyView();
  };

  const onUp = () => {
    drag = null;
  };

  svg.addEventListener('click', onClick);
  svg.addEventListener('pointermove', onMove);
  svg.addEventListener('pointerdown', onDown);
  svg.addEventListener('pointerup', onUp);
  svg.addEventListener('pointercancel', onUp);
  svg.addEventListener('wheel', onWheel, { passive: false });

  const handle = {
    update(next = {}) {
      const before = state.options;
      state.options = { view: 'map', ...before, ...next };
      // Re-adapting rows on every render would be wasteful and, worse, would
      // throw away identity — so it happens only when the rows actually change.
      const rowsChanged =
        next.data !== undefined ||
        next.users !== undefined ||
        next.interests !== undefined ||
        next.columns !== undefined;
      if (!state.data || rowsChanged) state.data = adapt(state.options);
      draw();
      return handle;
    },
    select(room) {
      state.selected = room ?? null;
      repaint();
      return handle;
    },
    destroy() {
      svg.removeEventListener('click', onClick);
      svg.removeEventListener('pointermove', onMove);
      svg.removeEventListener('pointerdown', onDown);
      svg.removeEventListener('pointerup', onUp);
      svg.removeEventListener('pointercancel', onUp);
      svg.removeEventListener('wheel', onWheel);
      svg.remove();
    },
    get element() {
      return svg;
    },
    get data() {
      return state.data;
    },
    get view() {
      return state.view;
    },
  };

  return handle.update(options);
}
