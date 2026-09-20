import { renderDiagram, regionAt, scopeOf, stroke, regionFill } from './diagram.js';
import { renderAtlas, zoneAt, paintAtlas, relabel } from './atlasview.js';
import { fitTo, pointsOf, renderMinimap } from './minimap.js';

const $ = (id) => document.getElementById(id);
const svg = $('diagram');

const state = {
  me: null,
  diagram: null,
  history: {},
  selected: null,
  hovered: null,
  fills: new Map(),
  results: null,
  unread: {},
  missed: [],
  view: 'map', // 'map' is the live circle surface; 'atlas' is a routed snapshot
  atlas: null,
  territories: new Map(),
  atlasSize: 5,
  written: [],
  viewBox: null,
  overview: null,
  FIT_PADDING: 20,
};

// --- socket ---------------------------------------------------------------

let ws = null;
let backoff = 500;

const send = (payload) =>
  ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(payload));

/**
 * Reconnect rather than tell someone to reload. Connections drop for ordinary
 * reasons — a sleeping laptop, a router idle timeout — and the session is
 * resumable for a minute afterwards, so a blink should cost nothing.
 */
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);

  ws.addEventListener('open', () => {
    backoff = 500;
    notify('');
    const previous = remembered();
    if (previous) send({ type: 'resume', userId: previous });
  });

  ws.addEventListener('message', handleFrame);

  ws.addEventListener('close', () => {
    notify('reconnecting…');
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 10_000);
  });
}

// sessionStorage can throw in a private window, and the app must work without it.
const remembered = () => {
  try {
    return sessionStorage.getItem('circle.me');
  } catch {
    return null;
  }
};
const remember = (id) => {
  try {
    sessionStorage.setItem('circle.me', id);
  } catch {
    /* fine — resume is a convenience, not a requirement */
  }
};

function handleFrame(evt) {
  const msg = JSON.parse(evt.data);

  switch (msg.type) {
    case 'welcome':
      state.me = msg.you;
      remember(msg.you.id);
      // Never clobber what someone is in the middle of typing.
      if (document.activeElement !== $('name')) $('name').value = msg.you.name;
      break;

    case 'expired':
      // The old session is gone; carry on as the fresh guest we already are.
      break;

    case 'diagram':
      state.diagram = msg;
      // The atlas is grown from the whole population, so a membership change
      // stales it. Drop it rather than show something a join has already
      // outdated; it regrows on request.
      if (state.atlas) {
        state.atlas = null;
        if (state.view === 'atlas') send({ type: 'atlas', subjects: state.atlasSize });
      }
      if (state.view === 'map') draw();
      renderRail();
      renderRoom();
      if (!state.overview) send({ type: 'overview' });
      else drawMinimap();
      break;

    case 'history':
      state.history = msg.rooms;
      renderRoom();
      break;

    case 'message': {
      const log = (state.history[msg.message.room] ??= []);
      log.push(msg.message);
      if (msg.message.room === state.selected) renderRoom();
      break;
    }

    case 'atlas':
      state.atlas = msg;
      if (state.view === 'atlas') drawAtlas();
      break;

    case 'overview':
      // The whole catalogue, at its place in the hierarchy. Cached: it only
      // changes when a subject gains or loses its very first member.
      state.overview = msg;
      drawMinimap();
      break;

    case 'unread':
      state.unread = msg.counts ?? {};
      renderRooms();
      break;

    case 'missed':
      // Everything that happened while they were away, newest urgency first.
      state.missed = msg.notifications ?? [];
      if (state.missed.length) {
        notify(`${state.missed.length} missed while you were away`);
      }
      break;

    case 'notification':
      state.unread[msg.notification.room] = (state.unread[msg.notification.room] ?? 0) + 1;
      renderRooms();
      announce(msg.notification);
      break;

    case 'results':
      // Ignore a result that has been overtaken by newer typing.
      if (msg.query === $('subject-name').value.trim()) {
        state.results = msg;
        renderRail();
      }
      break;

    case 'error':
      notify(msg.message);
      break;
  }
}

connect();

function notify(text) {
  const node = $('notice');
  node.textContent = text;
  node.hidden = !text;
  if (text) setTimeout(() => (node.hidden = true), 4000);
}

// --- diagram --------------------------------------------------------------

function draw() {
  const { fit, hidden } = state.diagram;
  ({ fills: state.fills } = renderDiagram(svg, state.diagram));

  renderRooms();

  if (!state.diagram.circles.length) {
    $('fit').textContent = 'no subjects yet — add one on the right.';
    return;
  }
  paintSelection();

  // The diagram says how far it can be trusted. With three circles some error
  // is unavoidable, so name it rather than imply the areas are exact.
  const worst = fit.worst;
  const ghost = fit.phantoms?.[0];
  $('fit').textContent = !fit.drawable
    ? 'more than three circles — this picture cannot be accurate.'
    : ghost
      ? // Worse than a mis-sized room: somewhere to go that is not there.
        `where these three meet is drawn but empty — no one holds all of ${ghost.subjects.join(', ')}`
      : fit.faithful || !worst
        ? 'every region drawn to scale'
        : `areas to scale · ${worst.key} drawn ${worst.drawn > worst.population ? 'large' : 'small'} by ${(worst.error * 100).toFixed(0)}%`;
  $('fit').classList.toggle('flag', !fit.drawable || !fit.faithful);

  const note = $('hidden');
  note.hidden = !hidden?.length;
  if (hidden?.length) note.textContent = `not shown: ${hidden.join(', ')}`;
}

/**
 * Open a room, and stop it nagging.
 *
 * Reading a room is better than being told about it, so the server is told
 * where they are looking — that room stops interrupting and its badge clears.
 */
function select(room) {
  state.selected = room;
  delete state.unread[room];
  send({ type: 'seen', room, clear: true });
  repaint();
  renderRooms();
  renderRoom();
}

/**
 * Hand an alert to the desktop, if they have allowed it.
 *
 * Only ever for `alert` — someone said their name, or a room small enough that
 * their presence is conspicuous. Anything else is a badge, which is what a
 * badge is for.
 */
function announce(note) {
  if (note.level !== 'alert') return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    new Notification(note.title, { body: note.body, tag: note.room });
  } catch {
    /* the browser may refuse; the badge already carries it */
  }
}

/** Whichever view is showing decides which rooms are on offer. */
const currentRooms = () =>
  (state.view === 'atlas' ? state.atlas?.rooms : state.diagram?.rooms) ?? [];

/**
 * Every room in view, listed, with anything waiting in it.
 *
 * The map is the good way in, but it cannot be the only way. A room whose
 * exclusive area is covered over by its neighbours has no ground to click —
 * which happens most often to single-subject rooms, since those are the ones
 * their overlaps eat into. The list reaches them regardless of geometry.
 */
function renderRooms() {
  const list = $('rooms');
  list.textContent = '';

  for (const room of currentRooms()) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `room-chip${room.key === state.selected ? ' on' : ''}${room.member ? ' mine' : ''}`;

    const dot = document.createElement('span');
    dot.className = 'swatch';
    dot.style.background = regionFill(room.subjects);

    const name = document.createElement('span');
    name.textContent = room.subjects.join(' ∩ ');

    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = String(room.population);

    button.append(dot, name, count);

    const waiting = state.unread[room.key] ?? 0;
    if (waiting) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = waiting > 99 ? '99+' : String(waiting);
      button.append(badge);
      button.classList.add('unread');
    }
    button.addEventListener('click', () => {
      select(room.key);
    });

    li.append(button);
    list.append(li);
  }
}

/**
 * The atlas draws exactly the occupied regions at exactly the right sizes, so
 * the only thing it can get wrong is a subject ending up in more than one
 * patch — which is what the note under it reports.
 */
function drawAtlas() {
  const view = state.atlas;
  if (!view) {
    $('fit').textContent = 'growing the atlas…';
    return;
  }

  ({ territories: state.territories, written: state.written } = renderAtlas(svg, view));

  // The native tooltip says it too, but only after a pause; this says it at
  // once, which is what makes the shortened labels feel readable rather than
  // cryptic.
  for (const spot of svg.querySelectorAll('.zone-label')) {
    spot.addEventListener('mouseenter', () => {
      $('fit').textContent = spot.dataset.full;
    });
    spot.addEventListener('mouseleave', () => drawAtlas());
  }

  // Framed on their own interests rather than on the whole drawing, so opening
  // the atlas puts them where they already are instead of somewhere to be
  // found. Everything else is still there to pan to; this only decides where
  // the view starts.
  const own = pointsOf(view.curves, view.subscription ?? []);
  state.viewBox = fitTo(svg, own.length ? own : pointsOf(view.curves), state.FIT_PADDING);
  state.fitted = state.viewBox?.width;
  applyView();

  paintAtlas(state.territories, state.selected);
  renderRooms();
  drawMinimap();

  const { report, subjects, zones } = view;
  const split = report.disconnected.length;
  $('fit').textContent = split
    ? `${subjects.length} subjects · ${zones.length} rooms, every one drawn to scale · ` +
      `${split} subject${split === 1 ? '' : 's'} split across patches`
    : `${subjects.length} subjects · ${zones.length} rooms, every one drawn to scale and in one piece`;
  $('fit').classList.toggle('flag', !report.wellFormed);
  $('hidden').hidden = true;
}

/**
 * The minimap: everything that exists, and a frame round the part of it these
 * interests occupy.
 */
function drawMinimap() {
  const wrap = $('minimap-wrap');
  const mine = state.diagram?.subscription ?? [];
  if (!state.overview) {
    wrap.hidden = true;
    return;
  }

  wrap.hidden = false;
  const frame = renderMinimap($('minimap'), state.overview, { mine });
  const total = state.overview.subjects.length;
  $('minimap-note').textContent = mine.length
    ? `${total.toLocaleString()} subjects · yours framed`
    : `${total.toLocaleString()} subjects · join one to find your place`;
  void frame;
}

/**
 * Pan and zoom the atlas.
 *
 * The map is bigger than a screenful the moment it is worth looking at, and a
 * fixed frame makes the shortened labels permanent — which was only ever a
 * concession to there not being room.
 */
function applyView() {
  if (!state.viewBox) return;
  const { x, y, width, height } = state.viewBox;
  svg.setAttribute('viewBox', `${x} ${y} ${width} ${height}`);

  const box = svg.getBoundingClientRect();
  const scale = (box.width || 600) / width;
  relabel(state.written, scale);
  $('zoom-note').textContent = scale > 0 ? `${scale.toFixed(2)}×` : '';
}

const LIMITS = { in: 60, out: 1.2 };

function zoomAt(clientX, clientY, factor) {
  if (!state.viewBox) return;
  const box = svg.getBoundingClientRect();
  const vb = state.viewBox;

  // The point under the cursor stays under the cursor; anything else feels
  // like the map getting away from you.
  const fx = (clientX - box.left) / (box.width || 1);
  const fy = (clientY - box.top) / (box.height || 1);
  const ux = vb.x + fx * vb.width;
  const uy = vb.y + fy * vb.height;

  const base = state.fitted ?? vb.width;
  const width = Math.min(base * LIMITS.out, Math.max(base / LIMITS.in, vb.width / factor));
  const height = width * (vb.height / vb.width);

  state.viewBox = { x: ux - fx * width, y: uy - fy * height, width, height };
  applyView();
}

svg.addEventListener('wheel', (evt) => {
  if (state.view !== 'atlas' || !state.viewBox) return;
  evt.preventDefault();
  zoomAt(evt.clientX, evt.clientY, evt.deltaY < 0 ? 1.18 : 1 / 1.18);
}, { passive: false });

let dragging = null;
svg.addEventListener('pointerdown', (evt) => {
  if (state.view !== 'atlas' || !state.viewBox) return;
  dragging = { x: evt.clientX, y: evt.clientY, moved: 0 };
  svg.setPointerCapture?.(evt.pointerId);
});

svg.addEventListener('pointermove', (evt) => {
  if (!dragging || !state.viewBox) return;
  const box = svg.getBoundingClientRect();
  const dx = ((evt.clientX - dragging.x) / (box.width || 1)) * state.viewBox.width;
  const dy = ((evt.clientY - dragging.y) / (box.height || 1)) * state.viewBox.height;

  dragging.moved += Math.abs(dx) + Math.abs(dy);
  dragging.x = evt.clientX;
  dragging.y = evt.clientY;
  state.viewBox = { ...state.viewBox, x: state.viewBox.x - dx, y: state.viewBox.y - dy };
  applyView();
});

const endDrag = () => {
  dragging = null;
};
svg.addEventListener('pointerup', endDrag);
svg.addEventListener('pointercancel', endDrag);

$('refit').addEventListener('click', () => {
  if (state.view === 'atlas') drawAtlas();
});

function showView(which) {
  state.view = which;
  $('view-map').classList.toggle('on', which === 'map');
  $('view-atlas').classList.toggle('on', which === 'atlas');
  $('atlas-size').hidden = which !== 'atlas';
  svg.classList.toggle('atlas-mode', which === 'atlas');

  if (which === 'atlas') {
    if (!state.atlas) send({ type: 'atlas', subjects: state.atlasSize });
    drawAtlas();
  } else if (state.diagram) {
    draw();
  }
}

$('view-map').addEventListener('click', () => showView('map'));
$('view-atlas').addEventListener('click', () => showView('atlas'));

$('subject-count').addEventListener('input', (evt) => {
  state.atlasSize = Number(evt.target.value);
  $('subject-count-out').textContent = String(state.atlasSize);
});
$('subject-count').addEventListener('change', () => {
  state.atlas = null;
  $('fit').textContent = 'growing the atlas…';
  send({ type: 'atlas', subjects: state.atlasSize });
});

function paintSelection() {
  // Lit area = the audience. Selecting `art` lights the whole art circle,
  // because that is who a post to art reaches.
  const scope = scopeOf([...state.fills.keys()], state.selected);

  for (const [roomKey, node] of state.fills) {
    const lit = scope.has(roomKey);
    const hovered = roomKey === state.hovered;
    node.setAttribute('opacity', lit ? 0.42 : hovered ? 0.3 : 0.14);
  }
}

function pointFrom(evt) {
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  return new DOMPoint(evt.clientX, evt.clientY).matrixTransform(ctm.inverse());
}

function hit(evt) {
  const pt = pointFrom(evt);
  if (!pt) return null;
  return state.view === 'atlas'
    ? zoneAt(state.atlas?.curves ?? [], pt.x, pt.y)
    : regionAt(state.diagram?.circles ?? [], pt.x, pt.y);
}

const repaint = () =>
  state.view === 'atlas'
    ? paintAtlas(state.territories, state.selected)
    : paintSelection();

svg.addEventListener('pointermove', (evt) => {
  if (state.view === 'atlas') return; // territories are lit by selection only
  const at = hit(evt);
  if (at !== state.hovered) {
    state.hovered = at;
    paintSelection();
  }
});

svg.addEventListener('pointerleave', () => {
  state.hovered = null;
  repaint();
});

svg.addEventListener('click', (evt) => {
  // A drag across the map is not a choice of room.
  if (dragging?.moved > 4) return;
  const at = hit(evt);
  if (!at) {
    notify('that point is outside every subject — there is no room there.');
    return;
  }
  if (!currentRooms().some((r) => r.key === at)) {
    // Rounding the outlines leaves hairline seams where two territories graze
    // without really meeting. A point caught in one names a combination
    // nobody holds, so it opens nothing rather than opening an empty room.
    notify('that is a seam between rooms, not a room.');
    return;
  }
  select(at);
});

// --- room -----------------------------------------------------------------

const selectedRoom = () =>
  currentRooms().find((r) => r.key === state.selected) ?? null;

function renderRoom() {
  const room = selectedRoom();
  const log = $('log');
  const body = $('body');
  log.textContent = '';

  if (!room) {
    $('room-title').textContent = 'pick a region';
    $('room-meta').textContent = 'click anywhere inside a circle on the diagram.';
    body.disabled = true;
    $('send').disabled = true;
    body.placeholder = 'click a region on the diagram first';
    return;
  }

  $('room-title').textContent = room.subjects.join(' ∩ ');

  const people = `${room.population} ${room.population === 1 ? 'person' : 'people'}`;
  $('room-meta').textContent = room.member
    ? `${people} · you are here`
    : `${people} · join ${room.subjects.join(' and ')} to take part`;

  body.disabled = !room.member;
  $('send').disabled = !room.member;
  body.placeholder = room.member
    ? `post to ${room.subjects.join(' ∩ ')}`
    : 'you are not in every subject of this region';

  const messages = state.history[room.key] ?? [];
  if (!messages.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = room.member
      ? 'nothing here yet. you could be first.'
      : 'nothing visible from outside.';
    log.append(empty);
    return;
  }

  for (const m of messages) {
    const li = document.createElement('li');
    const head = document.createElement('div');

    const who = document.createElement('span');
    who.className = 'author';
    who.textContent = m.author;

    const at = document.createElement('span');
    at.className = 'at';
    at.textContent = new Date(m.at).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });

    const text = document.createElement('p');
    text.className = 'text';
    text.textContent = m.body;

    head.append(who, at);
    li.append(head, text);
    log.append(li);
  }
  log.scrollTop = log.scrollHeight;
}

$('composer').addEventListener('submit', (evt) => {
  evt.preventDefault();
  const room = selectedRoom();
  const body = $('body');
  if (!room || !body.value.trim()) return;

  send({ type: 'post', tags: room.subjects, body: body.value });
  body.value = '';
});

// --- rail -----------------------------------------------------------------

function subjectRow(subject, population, held) {
  const li = document.createElement('li');

  const swatch = document.createElement('span');
  swatch.className = 'swatch';
  swatch.style.background = stroke(subject);

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = subject;

  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = population === undefined || population === null ? '' : String(population);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.textContent = held ? 'leave' : 'join';
  toggle.addEventListener('click', () =>
    send({ type: held ? 'leave' : 'join', subject }),
  );

  li.append(swatch, name, count, toggle);
  return li;
}

function group(list, title) {
  const li = document.createElement('li');
  li.className = 'group';
  li.textContent = title;
  list.append(li);
}

/**
 * What you hold, what is being suggested, and a few large rooms — never the
 * catalogue. Listing a thousand interests would rebuild a thousand rows on
 * every push, and is the same mistake the diagram avoids by showing a
 * neighbourhood instead of a world.
 */
function renderRail() {
  const { rail, subscription, circles } = state.diagram;
  const held = new Set(subscription);
  const population = new Map(circles.map((c) => [c.id, c.population]));
  const list = $('subjects');
  list.textContent = '';

  if (state.results) {
    group(list, `matches for “${state.results.query}”`);
    if (!state.results.subjects.length) {
      const none = document.createElement('li');
      none.className = 'group';
      none.textContent = 'nothing found';
      list.append(none);
    }
    for (const { id, population: n } of state.results.subjects) {
      list.append(subjectRow(id, n, held.has(id)));
    }
    return;
  }

  if (rail.held.length) {
    group(list, 'yours');
    for (const s of rail.held) list.append(subjectRow(s, population.get(s), true));
  }

  if (rail.suggested.length) {
    group(list, 'shown next to yours');
    for (const s of rail.suggested) list.append(subjectRow(s, population.get(s), false));
  }

  if (rail.popular.length) {
    group(list, rail.held.length ? 'busiest elsewhere' : 'busiest');
    for (const s of rail.popular) list.append(subjectRow(s, undefined, false));
  }

  $('rail-total').textContent = `${rail.total.toLocaleString()} interests · search to find more`;
  // Setting `.value` on a select is not universally writable; marking the
  // option is, and works the same everywhere.
  const reach = String(state.diagram.funnel ?? 0);
  if (document.activeElement !== $('funnel')) {
    for (const option of $('funnel').options ?? []) option.selected = option.value === reach;
  }
}

// Search rather than scroll: at a thousand interests the list is not the way
// in, and the diagram is only ever showing three of them anyway.
let searching;
$('subject-name').addEventListener('input', (evt) => {
  const query = evt.target.value.trim();
  clearTimeout(searching);

  if (!query) {
    state.results = null;
    renderRail();
    return;
  }
  searching = setTimeout(() => send({ type: 'search', query }), 180);
});

$('find').addEventListener('submit', (evt) => {
  evt.preventDefault();
  const input = $('subject-name');
  if (!input.value.trim()) return;
  send({ type: 'createSubject', name: input.value });
  input.value = '';
  state.results = null;
});

$('funnel').addEventListener('change', (evt) => {
  send({ type: 'funnel', reach: Number(evt.target.value) });
});

$('name').addEventListener('change', (evt) => {
  send({ type: 'identify', name: evt.target.value });
});

// --- desktop alerts --------------------------------------------------------

/**
 * Asking for notification permission unprompted is the thing everyone hates,
 * so it is behind a button and only ever asked for on a click.
 */
function paintBell() {
  const bell = $('bell');
  if (typeof Notification === 'undefined') {
    bell.hidden = true;
    return;
  }
  const on = Notification.permission === 'granted';
  bell.classList.toggle('on', on);
  bell.textContent = on ? 'alerts on' : 'alerts off';
  bell.disabled = Notification.permission === 'denied';
  if (bell.disabled) bell.textContent = 'alerts blocked';
}

$('bell').addEventListener('click', async () => {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'default') await Notification.requestPermission();
  paintBell();
});

paintBell();
