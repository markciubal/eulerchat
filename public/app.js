import { stroke, regionFill } from './diagram.js';
import { renderAtlas, zoneAt, paintAtlas, relabel } from './atlasview.js';
import { fitTo, pointsOf, renderMinimap } from './minimap.js';
import { attachHelp, busyness, createCard, when } from './hints.js';
import { available, identity, seal, unseal } from '../lib/seal.js';

const $ = (id) => document.getElementById(id);
const svg = $('diagram');

const state = {
  me: null,
  diagram: null,
  history: {},
  selected: null,
  hovered: null,
  results: null,
  unread: {},
  missed: [],
  atlas: null,
  territories: new Map(),
  atlasSize: 5,
  me: null,
  keys: new Map(),
  sealing: false,
  recording: false,
  kept: [],
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
  // Follow the page rather than assume the root: this may be mounted under a
  // path on somebody else's server.
  const at = (location.pathname ?? '/').replace(/\/$/, '') || '/';
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${at}`);

  ws.addEventListener('open', async () => {
    backoff = 500;
    // Kept as a promise as well as a value. Making the keys takes a moment,
    // and anything that needs them has to be able to wait for them rather than
    // find `state.identity` still null and carry on without.
    if (available() && !state.identity) {
      state.identityReady = identity().then((me) => {
        state.identity = me;
        send({ type: 'keys', keyId: me.id, publicKey: me.publicKey });
        return me;
      });
      await state.identityReady;
    }
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

    case 'state':
      state.diagram = msg;
      // The atlas is grown from the whole population, so a membership change
      // stales it. Drop it rather than show something a join has already
      // outdated; it regrows on request.
      // Grown from the whole population, so a membership change stales it; ask
      // for a fresh one rather than show one a join has already outdated.
      state.atlas = null;
      send({ type: 'atlas', subjects: state.atlasSize });
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

      // A sealed message arrives unreadable and is opened here, never on the
      // server, which has no key to open it with.
      if (msg.message.envelope && state.identity) {
        unseal(msg.message.envelope, state.identity)
          .then((text) => {
            if (text === null) return;
            msg.message.body = text;
            keep(msg.message);
            if (msg.message.room === state.selected) renderRoom();
          })
          .catch(() => {
            msg.message.body = '[could not be unlocked]';
          });
      } else {
        keep(msg.message);
      }
      break;
    }

    case 'atlas':
      state.atlas = msg;
      drawAtlas();
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

    case 'key':
      if (msg.keyId && msg.publicKey) state.keys.set(msg.keyId, msg.publicKey);
      break;

    case 'readers':
      state.readers = msg.readers ?? [];
      // Whoever asked for this list is waiting on it rather than on a timer.
      state.awaitingReaders?.(msg);
      break;

    case 'recording':
      state.recording = msg.on;
      $('recording').checked = msg.on;
      break;

    case 'error':
      notify(msg.message);
      break;
  }
}

const card = createCard(document);
attachHelp(document, { onOpen: (key, near) => card.explain(key, near) });

// A click anywhere else puts an opened explanation away again.
document.addEventListener('click', (evt) => {
  if (card.pinned && !card.element.contains(evt.target)) card.hide(true);
});

connect();

function notify(text) {
  const node = $('notice');
  node.textContent = text;
  node.hidden = !text;
  if (text) setTimeout(() => (node.hidden = true), 4000);
}

// --- the map ---------------------------------------------------------------

/**
 * Open a conversation, and stop it nagging.
 *
 * Reading a conversation is better than being told about it, so the server is
 * told where they are looking — that one stops interrupting and its badge
 * clears.
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
/** There is one picture now, and its zones are the conversations. */
const currentRooms = () => state.atlas?.rooms ?? [];

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
    button.addEventListener('pointerenter', () => card.room(room, button));
    button.addEventListener('pointerleave', () => card.hide());
    button.addEventListener('focus', () => card.room(room, button));
    button.addEventListener('blur', () => card.hide());

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
  $('lede').hidden = (state.diagram?.subscription?.length ?? 0) > 0;

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
  if (!state.viewBox) return;
  evt.preventDefault();
  zoomAt(evt.clientX, evt.clientY, evt.deltaY < 0 ? 1.18 : 1 / 1.18);
}, { passive: false });

let dragging = null;
svg.addEventListener('pointerdown', (evt) => {
  if (!state.viewBox) return;
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

$('refit').addEventListener('click', () => drawAtlas());


$('subject-count').addEventListener('input', (evt) => {
  state.atlasSize = Number(evt.target.value);
  $('subject-count-out').textContent = String(state.atlasSize);
});
$('subject-count').addEventListener('change', () => {
  state.atlas = null;
  $('fit').textContent = 'redrawing…';
  send({ type: 'atlas', subjects: state.atlasSize });
});

function pointFrom(evt) {
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  return new DOMPoint(evt.clientX, evt.clientY).matrixTransform(ctm.inverse());
}

function hit(evt) {
  const pt = pointFrom(evt);
  if (!pt) return null;
  return zoneAt(state.atlas?.curves ?? [], pt.x, pt.y);
}

const repaint = () => paintAtlas(state.territories, state.selected);

svg.addEventListener('pointermove', (evt) => {
  const at = hit(evt);
  if (at !== state.hovered) {
    state.hovered = at;
  
    // Hovering a patch of the picture asks the same question a chip does.
    const room = currentRooms().find((r) => r.key === at);
    if (room) card.room(room, { getBoundingClientRect: () => ({
      left: evt.clientX, bottom: evt.clientY + 12, right: evt.clientX, top: evt.clientY,
    }) });
    else card.hide();
  }
});

svg.addEventListener('pointerleave', () => {
  state.hovered = null;
  card.hide();
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
    $('room-title').textContent = 'Pick a conversation';
    $('room-meta').textContent =
      'Click inside a circle above, or one of the buttons under it. Where circles overlap ' +
      'is a conversation for people interested in both.';
    body.disabled = true;
    $('send').disabled = true;
    body.placeholder = 'click a region on the diagram first';
    return;
  }

  $('room-title').textContent = room.subjects.join(' and ');

  const people = `${room.population} ${room.population === 1 ? 'person' : 'people'}`;
  const stats = room.stats;
  const activity = stats?.last ? ` · ${busyness(stats)}, last ${when(stats.last.at)}` : '';
  $('room-meta').textContent = room.member
    ? `${people} · you are here${activity}`
    : `${people} · join ${room.subjects.join(' and ')} to take part${activity}`;

  body.disabled = !room.member;
  $('send').disabled = !room.member;
  body.placeholder = room.member
    ? `say something to the ${room.population} people here`
    : `join ${room.subjects.join(' and ')} to join in`;
  const help = $('composer-help');
  help.textContent = '';
  if (!room.member) {
    // The remedy belongs where the problem is described. Telling somebody to
    // go and find a button in another column is how you lose them.
    help.append(document.createTextNode('To join in, you need '));
    const missing = room.subjects.filter((s) => !(state.diagram?.subscription ?? []).includes(s));
    missing.forEach((subject, i) => {
      const join = document.createElement('button');
      join.type = 'button';
      join.className = 'join-here';
      join.textContent = `join ${subject}`;
      join.addEventListener('click', () => send({ type: 'join', subject }));
      help.append(join);
      if (i < missing.length - 1) help.append(document.createTextNode(' and '));
    });
  }

  const messages = state.history[room.key] ?? [];
  if (!messages.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = room.member
      ? 'Nothing said here yet. You could be the first.'
      : 'You will be able to read this once you have joined.';
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
    if (m.sealed) {
      const mark = document.createElement('span');
      mark.className = 'sealed-mark';
      mark.textContent = '🔒 encrypted';
      head.append(mark);
    }
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

  const text = body.value;

  // Only when they did not ask for it does plaintext go out on its own. The
  // two conditions used to be one `if`, so a message typed before the keys
  // had finished being made — which is a real window, not a theoretical one —
  // went out unlocked from a page with the box ticked.
  if (!state.sealing) {
    body.value = '';
    send({ type: 'post', tags: room.subjects, body: text });
    return;
  }

  // Sealed to whoever is in the room right now. Anyone who arrives later
  // cannot read it, which is what a key used once and thrown away means.
  //
  // Waited on properly, and this matters more than it looks. This used to ask
  // for the reader list and then sleep 120ms, which is shorter than a great
  // many real round trips — and when the list had not arrived it fell through
  // to sending the message unlocked. Somebody on a slow connection, who had
  // ticked the box and been told their words were locked, sent them in the
  // clear. A request to encrypt that cannot be honoured must fail, not
  // quietly do the other thing.
  // Locking takes a round trip to find out who is in the room, so say that
  // something is happening. Pressing post and watching nothing change is how
  // people come to press it twice.
  notify('Locking…');

  (async () => {
    // The keys may still be being made; wait rather than proceed without them.
    const me = state.identity ?? (await Promise.race([
      state.identityReady ?? Promise.resolve(null),
      new Promise((r) => setTimeout(() => r(null), 8000)),
    ]));

    const list = me ? await readersFor(room.key) : [];
    const readers = (list ?? []).map((r) => r.publicKey).filter(Boolean);

    if (!me || !readers.length) {
      // Their words are still in the box, because nothing cleared it: it is
      // emptied when the message has gone, not when it was asked to go.
      // Losing what you typed is a nuisance; having it sent unlocked when you
      // asked for locked is a broken promise.
      notify(
        !me || list === null
          ? 'Could not lock this message, so it was not sent — it is still in the box.'
          : 'Nobody is here to receive it yet, so it was not sent — it is still in the box.',
      );
      return;
    }

    const envelope = await seal(text, me, readers);
    send({ type: 'post', tags: room.subjects, body: '', envelope });
    notify('');
    // Cleared now that it has actually gone — and only if they have not
    // started writing something else while they waited.
    if (body.value === text) body.value = '';
  })();
});

/**
 * Who is in a room, as a promise rather than as a guess about how long the
 * network takes. Resolves with the list, or null if the answer never came.
 */
function readersFor(roomKey, limitMs = 8000) {
  return new Promise((resolve) => {
    const done = (value) => {
      clearTimeout(timer);
      state.awaitingReaders = null;
      resolve(value);
    };
    const timer = setTimeout(() => done(null), limitMs);
    // Only the answer to the question that was asked. Sealing to the people in
    // some other room would produce a message the room it was posted to cannot
    // read, and hand it to people who were never in the conversation.
    state.awaitingReaders = (frame) => {
      if (frame.room !== roomKey) return;
      done(frame.readers ?? []);
    };
    send({ type: 'readers', room: roomKey });
  });
}

const KEPT_KEY = 'eulerchat.kept';
const KEPT_MOST = 500;

/**
 * Their own copy, if they asked for one. Nobody else's.
 *
 * The stored record is read back at startup, which it was not before: this
 * began every session with an empty list and then wrote that list over the
 * saved one, so the first message after a reload destroyed everything kept
 * until then. A record that survives only until you close the tab is not the
 * thing that was asked for.
 */
function keep(message) {
  if (!state.recording) return;
  state.kept.push({ room: message.room, author: message.author, body: message.body, at: message.at });
  // Trimmed here and not only on the way out, or a long session grows a list
  // it never stops holding.
  if (state.kept.length > KEPT_MOST) state.kept = state.kept.slice(-KEPT_MOST);
  try {
    localStorage.setItem(KEPT_KEY, JSON.stringify(state.kept));
  } catch {
    /* no room, or a private window: the copy is a convenience */
  }
}

/** Whatever was kept before this tab opened. */
function restoreKept() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEPT_KEY) ?? '[]');
    if (Array.isArray(saved)) state.kept = saved.slice(-KEPT_MOST);
  } catch {
    /* unreadable or absent; starting empty is the only option left */
  }
}
restoreKept();

$('sealed').addEventListener('change', (evt) => {
  if (evt.target.checked && !available()) {
    evt.target.checked = false;
    notify('This browser cannot encrypt; messages would go unlocked.');
    return;
  }
  state.sealing = evt.target.checked;
  notify(
    state.sealing
      ? 'Locked before sending. The people here can still keep a copy.'
      : 'Messages will go unlocked.',
  );
});

$('recording').addEventListener('change', (evt) => {
  state.recording = evt.target.checked;
  send({ type: 'record', on: state.recording });
  notify(
    state.recording
      ? 'Keeping your own copy in this browser. The server still forgets after 12 hours.'
      : 'Not keeping a copy.',
  );
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
  const { rail, subscription } = state.diagram;
  const held = new Set(subscription);
  // Counts come from the picture now rather than from a circle layout, and the
  // rail is drawn before the picture arrives, so it must manage without them.
  const population = new Map(
    (state.atlas?.zones ?? [])
      .filter((zone) => zone.subjects.length === 1)
      .map((zone) => [zone.subjects[0], zone.population]),
  );
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
  // Enter searches. It used to create: somebody typing the name of a group
  // they had been told about would silently make a second, empty one beside
  // it, find nobody in it, and conclude the place was dead — without ever
  // knowing they had done it.
  evt.preventDefault();
  const query = $('subject-name').value.trim();
  if (query) send({ type: 'search', query });
});

$('create').addEventListener('click', () => {
  const input = $('subject-name');
  const name = input.value.trim();
  if (!name) return;

  // Never quietly make a second one. If it already exists, that is what they
  // were looking for.
  const existing = state.results?.subjects?.find((s) => s.id === name.toLowerCase());
  if (existing) {
    notify(`"${existing.id}" already exists with ${existing.population} people — joining that one.`);
    send({ type: 'join', subject: existing.id });
  } else {
    send({ type: 'createSubject', name });
    notify(`Created "${name}" and joined you to it.`);
  }
  input.value = '';
  state.results = null;
});

$('funnel').addEventListener('change', (evt) => {
  send({ type: 'funnel', reach: Number(evt.target.value) });
});

$('name').addEventListener('change', (evt) => {
  send({ type: 'identify', name: evt.target.value });
  notify(`Saved. Others will see your messages signed "${evt.target.value}".`);
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
  bell.textContent = on ? 'alerts are on' : 'turn on alerts';
  bell.disabled = Notification.permission === 'denied';
  if (bell.disabled) bell.textContent = 'alerts blocked by your browser';
}

$('bell').addEventListener('click', async () => {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'default') await Notification.requestPermission();
  paintBell();
});

paintBell();
