import { stroke, regionFill } from './diagram.js';
import { renderAtlas, zoneAt, paintAtlas, relabel } from './atlasview.js';
import { fitTo, pointsOf, renderMinimap } from './minimap.js';
import { attachHelp, busyness, createCard, when } from './hints.js';
import { available, forgetIdentity, rememberedIdentity, seal, unseal } from '../lib/seal.js';
import { mark, prove } from '../lib/proof.js';
import { REASONS } from '../lib/flag.js';
import { plain, saidAbout } from '../lib/plain.js';
import { clusterFromLink, clusterOf, inviteLink, isCluster, label as subjectLabel, newCluster } from '../lib/cluster.js';
import { qr } from '../lib/qr.js';

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
  keys: new Map(),
  sealing: false,
  recording: false,
  kept: [],
  /** Messages this person has already reported, so the button can say so. */
  reported: new Set(),
  /** messageId -> {up, down, score} as everyone else sees it. */
  votes: new Map(),
  cluster: null,
  /** The message being replied to, if any. */
  replyTo: null,
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
    named = false;
    // Kept as a promise as well as a value. Making the keys takes a moment,
    // and anything that needs them has to be able to wait for them rather than
    // find `state.identity` still null and carry on without.
    //
    // The key is the same one as last time where the browser will hold one,
    // and it is sent on every connection, not only the first. It used to be
    // sent once per page, so anybody whose connection had blinked was somebody
    // the server held no key for, and nothing could be locked for them until
    // they reloaded.
    let me = null;
    if (available()) {
      state.identityReady ??= rememberedIdentity().then((made) => (state.identity = made));
      me = await state.identityReady.catch(() => null);
    }
    notify('');

    if (me) {
      // Whoever this was before is taken back by showing the key; see the
      // `challenge` frame. The remembered id below would be refused anyway.
      send({ type: 'keys', keyId: me.id, publicKey: me.publicKey });
      return;
    }
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

// --- who you are ------------------------------------------------------------

/**
 * A name, and after it the letters of the key it was said under.
 *
 * Two elements, never one string. The name is whatever somebody typed and the
 * letters are not, and if they were ever joined into text then a name could be
 * typed that looked like both. The server refuses the dot in names for the
 * same reason; this is the half of that rule that lives in the picture.
 */
function signed(name, keyId) {
  const out = document.createDocumentFragment();
  out.append(document.createTextNode(name));
  if (keyId) {
    const letters = document.createElement('span');
    letters.className = 'key';
    letters.textContent = `·${mark(keyId)}`;
    letters.title = `said under the key ${keyId}`;
    out.append(letters);
  }
  return out;
}

/** Your own key, beside your own name, once the server has seen it shown. */
function paintKey() {
  const keyId = state.me?.keyId;
  $('key-wrap').hidden = !keyId;
  if (!keyId) return;
  $('key-mark').textContent = `·${mark(keyId)}`;
  // In full on hover, because the full one is what a moderator list is made
  // of, and somebody has to be able to read theirs out.
  $('key-mark').title = state.identity?.kept
    ? `your key: ${keyId}`
    : `your key: ${keyId} (this browser would not keep it, so it lasts until you close the page)`;
}

/**
 * The name goes with the key.
 *
 * The server forgets a person a minute after they leave, name included, so
 * somebody coming back tomorrow with the same key would be `guest-3f2a` with
 * the right letters after it. The browser remembers what they called
 * themselves and says it again - once per connection, and only under a key,
 * since without one there is nobody in particular to be called anything.
 */
const NAME_KEY = 'eulerchat.name';
let named = false;
function bringNameBack() {
  if (named || !state.me?.keyId) return;
  named = true;
  let wanted = null;
  try {
    wanted = localStorage.getItem(NAME_KEY);
  } catch {
    /* a private window; they can type it again */
  }
  if (wanted && wanted !== state.me.name) send({ type: 'identify', name: wanted });
}

$('new-key').addEventListener('click', async () => {
  // Everything that ties this browser to who it has been: the key, the name
  // that went with it, and the id the last connection was known by.
  await forgetIdentity();
  try {
    localStorage.removeItem(NAME_KEY);
    sessionStorage.removeItem('circle.me');
  } catch {
    /* nothing was being kept there anyway */
  }
  state.identity = null;
  state.identityReady = null;
  state.me = null;
  paintKey();
  notify('That key is gone. You are somebody new here now.');
  // A key belongs to a connection for as long as the connection lasts, so
  // being somebody else means arriving again. The close handler reconnects.
  ws?.close();
});

function handleFrame(evt) {
  const msg = JSON.parse(evt.data);

  switch (msg.type) {
    case 'welcome':
      state.me = msg.you;
      remember(msg.you.id);
      // Never clobber what someone is in the middle of typing.
      if (document.activeElement !== $('name')) $('name').value = msg.you.name;
      paintKey();
      bringNameBack();
      break;

    case 'challenge':
      // The server will not take our word that the key is ours, and should
      // not. What goes back can only have been made with the private half,
      // and is of no use for opening anything; see `lib/proof.js`.
      if (state.identity) {
        prove(msg.offer, state.identity)
          .then((mac) => send({ type: 'proof', mac }))
          .catch(() => {
            /* no key beside the name this time; everything else still works */
          });
      }
      break;

    case 'proven':
      // The `welcome` that follows carries it; nothing to do until then.
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
      offerWhatWeKept();
      break;

    case 'restored':
      if (msg.restored) notify(`Put back ${msg.restored} message${msg.restored === 1 ? '' : 's'} you had kept.`);
      break;

    case 'message': {
      const log = (state.history[msg.message.room] ??= []);
      log.push(msg.message);
      if (msg.message.room === state.selected) {
        renderRoom();
        // Just this one, rather than the whole room. The log is rebuilt from
        // scratch on every render, so announcing the list itself re-read every
        // message each time anybody voted on anything.
        $('said').textContent = msg.message.sealed
          ? `${msg.message.author} sent a locked message`
          : `${msg.message.author} said: ${msg.message.body}`;
      }

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

    case 'reported':
      // Already reported is not a failure; it is the same answer as success
      // from where the person is standing, and saying otherwise invites them
      // to try again.
      notify(msg.already ? 'You have already reported that one.' : 'Reported. Thank you.');
      break;

    case 'votes':
      state.votes.set(msg.messageId, { up: msg.up, down: msg.down, score: msg.score });
      renderRoom();
      break;

    case 'forgotten':
      for (const log of Object.values(state.history)) {
        const at = log.findIndex((m) => m.id === msg.messageId);
        if (at >= 0) log.splice(at, 1);
      }
      renderRoom();
      break;

    case 'receipt':
      notify('Deleted, and written into the record of deletions.');
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

/**
 * What just happened, said once.
 *
 * The timer is held rather than let loose. Each call used to schedule its own
 * four-second hide and forget about it, so a notice posted three and a half
 * seconds after the previous one was cleared half a second later by the
 * previous one's timer — and the message most likely to arrive late is the
 * one saying a message could not be locked and was not sent.
 *
 * Emptied rather than hidden: this is a live region, and a live region has to
 * be in the tree before its text changes for the change to be announced at
 * all. Longer messages are left up longer, because they take longer to read.
 */
let noticeTimer;
function notify(text) {
  const node = $('notice');
  clearTimeout(noticeTimer);
  node.textContent = text;
  if (text) noticeTimer = setTimeout(() => (node.textContent = ''), Math.max(4000, text.length * 80));
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

    // Read out, the chip was its subjects and then two bare numbers with
    // nothing saying which was which — and whether you are in the room was
    // carried by text colour alone, which in dark mode is no cue at all.
    button.setAttribute('aria-pressed', String(room.key === state.selected));
    button.setAttribute(
      'aria-label',
      `${room.subjects.join(' and ')}, ${room.population} ${room.population === 1 ? 'person' : 'people'}` +
        `${room.member ? ', you are in this one' : ''}${waiting ? `, ${waiting} unread` : ''}`,
    );

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
  // Put back by hand on the way out, rather than by redrawing. Redrawing
  // recomputed the fit and threw away whatever the person had panned and
  // zoomed to, so brushing past a label reset the map under their cursor.
  const standing = $('fit').textContent;
  for (const spot of svg.querySelectorAll('.zone-label')) {
    spot.addEventListener('mouseenter', () => {
      $('fit').textContent = spot.dataset.full;
    });
    spot.addEventListener('mouseleave', () => {
      $('fit').textContent = standing;
    });
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
      join.addEventListener('click', () => joinSubject(subject));
      help.append(join);
      if (i < missing.length - 1) help.append(document.createTextNode(' and '));
    });
  }

  // Replying is easy to start by accident and confusing to be stuck in, so
  // what you are replying to is shown with the way out next to it.
  const replying = $('replying');
  if (state.replyTo && state.replyTo.room === room.key) {
    replying.hidden = false;
    replying.textContent = '';
    replying.append(document.createTextNode(`replying to ${state.replyTo.author}`));
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'stop-replying';
    stop.textContent = 'not a reply';
    stop.addEventListener('click', () => {
      state.replyTo = null;
      renderRoom();
    });
    replying.append(stop);
  } else {
    if (state.replyTo && state.replyTo.room !== room.key) state.replyTo = null;
    replying.hidden = true;
    // Emptied as well as hidden. `hidden` alone left the words and the button
    // that cancels the reply behind for anything reading the page rather than
    // looking at it.
    replying.textContent = '';
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
    who.append(signed(m.author, m.authorKey));

    const at = document.createElement('span');
    at.className = 'at';
    at.textContent = new Date(m.at).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });

    const text = document.createElement('p');
    text.className = 'text';
    text.textContent = m.body;

    // What this was a reply to, quoted from when it was sent rather than
    // looked up now: the original may be gone, and a reply to nothing reads
    // as a non-sequitur.
    let quoted = null;
    if (m.replyTo) {
      quoted = document.createElement('p');
      quoted.className = 'quoted';
      const who = document.createElement('strong');
      who.textContent = `${m.replyTo.author}: `;
      quoted.append(who, document.createTextNode(
        m.replyTo.sealed ? '(a locked message)' : m.replyTo.excerpt,
      ));
    }

    head.append(who, at);
    if (m.sealed) {
      const mark = document.createElement('span');
      mark.className = 'sealed-mark';
      mark.textContent = 'encrypted';
      head.append(mark);
    }

    // Reporting is the only thing that works on a sealed message — the server
    // cannot read one, so nothing automatic will ever notice it. It belongs on
    // every message that is not your own, quietly, where somebody who needs it
    // will find it without it being the loudest thing in the room.
    // Agreeing and disagreeing. Not a report, and deliberately not connected
    // to one: see the help text, and `World.vote`.
    const tally = state.votes.get(m.id) ?? { up: 0, down: 0, score: 0 };
    const voting = document.createElement('span');
    voting.className = 'votes';
    for (const [which, value, mark] of [['up', 1, 'agree'], ['down', -1, 'disagree']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `vote vote-${which}`;
      const count = which === 'up' ? tally.up : tally.down;
      button.textContent = count ? `${mark} ${count}` : mark;
      button.setAttribute('aria-label', `${mark} with the message from ${m.author}`);
      button.addEventListener('click', () => send({ type: 'vote', messageId: m.id, value }));
      voting.append(button);
    }
    head.append(voting);

    // Your own words are yours to take back, and doing so is recorded like
    // any other deletion rather than quietly.
    if (m.authorId === state.me?.id) {
      const remove = document.createElement('button');
      remove.type = 'button';
      // Its own class, not the report one. They sit in the same place and look
      // alike, but "take back what I said" and "tell a moderator about what
      // somebody else said" are different acts and should not be one selector.
      remove.className = 'msg-action forget';
      remove.textContent = 'delete';
      remove.title = 'Delete this, and record that it was deleted';
      remove.addEventListener('click', () => send({ type: 'forget', messageId: m.id }));
      head.append(remove);
    }

    if (m.authorId !== state.me?.id) {
      const flag = document.createElement('button');
      flag.type = 'button';
      flag.className = 'msg-action report';
      flag.textContent = state.reported.has(m.id) ? 'reported' : 'report';
      flag.disabled = state.reported.has(m.id);
      flag.title = flag.disabled
        ? 'You have reported this'
        : 'Tell a moderator about this message';
      flag.setAttribute('aria-label', `Report the message from ${m.author}`);
      flag.addEventListener('click', () => askWhy(m, flag));
      head.append(flag);
    }

    // Replying to somebody, which is the ordinary way a conversation with
    // more than two people in it stays followable.
    const reply = document.createElement('button');
    reply.type = 'button';
    reply.className = 'msg-action reply';
    reply.textContent = 'reply';
    reply.title = `Reply to ${m.author}`;
    reply.addEventListener('click', () => {
      state.replyTo = m;
      renderRoom();
      $('body').focus();
    });
    head.append(reply);

    li.append(head);
    if (quoted) li.append(quoted);
    li.append(text);
    log.append(li);
  }
  log.scrollTop = log.scrollHeight;
}

/**
 * Take pictures out of the box as they arrive.
 *
 * On the way in rather than on the way out: somebody who types an emoji and
 * watches it not appear has learned the rule in one go, whereas somebody whose
 * message is quietly edited between pressing post and it appearing has been
 * misquoted by their own chat client.
 */
$('body').addEventListener('input', (evt) => {
  const box = evt.target;
  const cleaned = plain(box.value);
  if (!cleaned.changed) return;

  // Trailing space is lost by trimming, and losing it mid-sentence makes the
  // box feel broken while somebody is still typing.
  const trailing = /\s$/.test(box.value) ? ' ' : '';
  box.value = cleaned.text + trailing;
  box.setSelectionRange(box.value.length, box.value.length);
  const said = saidAbout(cleaned);
  if (said) notify(said);
});

$('composer').addEventListener('submit', (evt) => {
  evt.preventDefault();
  const room = selectedRoom();
  const body = $('body');
  if (!room || !body.value.trim()) return;

  // Cleaned once more here, because this is the last point before the words
  // leave - and for a sealed message it is the only point, since the server
  // will never be able to look inside one.
  const text = plain(body.value).text;
  if (!text) return;

  // Only when they did not ask for it does plaintext go out on its own. The
  // two conditions used to be one `if`, so a message typed before the keys
  // had finished being made — which is a real window, not a theoretical one —
  // went out unlocked from a page with the box ticked.
  const replyTo = state.replyTo?.room === room.key ? state.replyTo.id : undefined;

  if (!state.sealing) {
    body.value = '';
    state.replyTo = null;
    send({ type: 'post', tags: room.subjects, body: text, replyTo });
    renderRoom();
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
    send({ type: 'post', tags: room.subjects, body: '', envelope, replyTo });
    state.replyTo = null;
    notify('');
    // Cleared now that it has actually gone — and only if they have not
    // started writing something else while they waited.
    if (body.value === text) body.value = '';
  })();
});

/**
 * Small groups, and the link that gets somebody into one.
 *
 * Joining a cluster does not move anybody: it changes what a new join means.
 * `art` becomes `kite-fox-9/art`, which is a different subject, so the people
 * in it are exactly the people who used the same name.
 */
function renderCluster() {
  const now = $('cluster-now');
  const share = $('cluster-share');

  if (!state.cluster) {
    now.textContent = 'You are in the open part of this place.';
    $('cluster-leave').hidden = true;
    share.hidden = true;
    return;
  }

  now.textContent = `You are in ${state.cluster}. Interests you join go in here.`;
  $('cluster-leave').hidden = false;

  const link = inviteLink(location.origin + location.pathname, state.cluster);
  const anchor = $('cluster-url');
  anchor.href = link;
  anchor.textContent = link;
  share.hidden = false;
  drawInvite(link);
}

/**
 * The invitation as a square somebody can point a camera at.
 *
 * Drawn as elements rather than as a picture, because this place does not do
 * pictures - and because a grid of squares is exactly what the thing is.
 */
function drawInvite(link) {
  const holder = $('cluster-qr');
  holder.textContent = '';

  const { size, modules } = qr(link);
  holder.style.setProperty('--qr-size', String(size));
  for (const row of modules) {
    for (const dark of row) {
      const cell = document.createElement('i');
      cell.className = dark ? 'qr-on' : 'qr-off';
      holder.append(cell);
    }
  }
}

/**
 * Join a subject, inside whatever group you are in.
 *
 * Every join goes through here so the group cannot be half-applied: a person
 * in `kite-fox-9` who joined one interest inside it and one outside would be
 * in two places at once and understand neither.
 *
 * A clustered subject is created on the way in, because it will not exist
 * yet - the whole point is that it is a room only this group is in, and
 * nobody has been there before the first person arrives.
 */
function joinSubject(subject) {
  const bare = subjectLabel(subject);
  if (!state.cluster) return send({ type: 'join', subject: bare });
  send({ type: 'createSubject', name: `${state.cluster}/${bare}` });
}

/** Join a cluster, or leave for the open part again. */
function enterCluster(name) {
  state.cluster = name && isCluster(name) ? name : null;
  renderCluster();
  notify(
    state.cluster
      ? `You are in ${state.cluster}. Share the link to bring people in.`
      : 'Back in the open part of this place.',
  );
}

$('cluster-new').addEventListener('click', () => enterCluster(newCluster()));
$('cluster-leave').addEventListener('click', () => enterCluster(null));
$('cluster-name').addEventListener('change', (evt) => {
  const wanted = evt.target.value.trim();
  if (!wanted) return enterCluster(null);
  if (!isCluster(wanted)) return notify('That is not a group name. They look like kite-fox-9.');
  enterCluster(wanted);
});

// Arriving by link or by camera puts somebody straight into the group.
enterCluster(clusterFromLink(location.href));

/**
 * Ask what was wrong with a message, then report it.
 *
 * A reason is asked for rather than assumed, because "report" on its own tells
 * a moderator nothing about what they are looking for, and because being made
 * to pick one is a small moment of thought between irritation and a complaint.
 *
 * For an encrypted message this is also the moment of consent. The server has
 * never been able to read it; the only way a moderator can see what was said
 * is if the person reporting it chooses to show them. That is said before the
 * choice, not after it.
 */
function askWhy(message, near) {
  const panel = document.createElement('div');
  panel.className = 'why';

  const title = document.createElement('strong');
  title.textContent = 'What is wrong with it?';
  panel.append(title);

  if (message.sealed) {
    const warn = document.createElement('p');
    warn.className = 'discloses';
    warn.textContent =
      'This message is encrypted, so nobody but the people here can read it. ' +
      'Reporting it shows this one message to a moderator. The rest stay private.';
    panel.append(warn);
  }

  const close = () => panel.remove();

  for (const [reason, { says }] of Object.entries(REASONS)) {
    const choice = document.createElement('button');
    choice.type = 'button';
    choice.className = 'why-choice';
    choice.textContent = says;
    choice.addEventListener('click', () => {
      send({
        type: 'report',
        messageId: message.id,
        reason,
        // Only for a sealed one, and only because they just chose to.
        disclosed: message.sealed ? message.body : undefined,
      });
      state.reported.add(message.id);
      close();
      renderRoom();
      notify('Reported. A moderator will look at it; nobody in the room is told.');
    });
    panel.append(choice);
  }

  const never = document.createElement('button');
  never.type = 'button';
  never.className = 'why-cancel';
  never.textContent = 'cancel';
  never.addEventListener('click', close);
  panel.append(never);

  document.querySelector('.why')?.remove();
  near.after(panel);
}

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
  // Everything needed to put this back, not just enough to read it. The four
  // fields this used to keep could not rebuild a room even in principle: the
  // server checks a returned copy by hashing it, and a hash of half a message
  // matches nothing.
  state.kept.push({
    // Which form of hash the server named this by, and the key that was
    // beside the name. Both are part of what gets hashed, so a copy without
    // them is a copy the server will not recognise.
    v: message.v,
    id: message.id,
    room: message.room,
    author: message.author,
    authorId: message.authorId,
    authorKey: message.authorKey ?? undefined,
    body: message.body,
    at: message.at,
    sealed: Boolean(message.sealed),
    // The ciphertext is what the server committed to for a sealed message, so
    // it is what has to come back. The readable text above is for this browser.
    envelope: message.envelope ?? undefined,
    replyTo: message.replyTo ?? undefined,
  });
  // Trimmed here and not only on the way out, or a long session grows a list
  // it never stops holding.
  if (state.kept.length > KEPT_MOST) state.kept = state.kept.slice(-KEPT_MOST);
  try {
    localStorage.setItem(KEPT_KEY, JSON.stringify(state.kept));
  } catch {
    /* no room, or a private window: the copy is a convenience */
  }
}

/**
 * Offer what this browser kept, in case the server lost it.
 *
 * Only worth doing when the server has come back with less than we have, so
 * the ordinary case - a server that never went down - costs nothing. Nothing
 * here is trusted at the other end: every message is checked against the
 * server's own record of what it saw, and anything invented, altered or
 * deliberately deleted is refused. See `World.restore`.
 */
let offered = false;
function offerWhatWeKept() {
  if (offered || !state.kept.length) return;

  const held = new Set(
    Object.values(state.history ?? {}).flatMap((log) => log.map((m) => m.id)),
  );
  const missing = state.kept.filter((m) => m.id && !held.has(m.id));
  if (!missing.length) return;

  offered = true;
  send({ type: 'restore', messages: missing.slice(-500) });
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
  // The rail is a column of buttons all called `join`, which is what somebody
  // listening to it hears unless each one says what it joins.
  toggle.setAttribute('aria-label', held ? `leave ${subject}` : `join ${subject}`);
  toggle.addEventListener('click', () =>
    held ? send({ type: 'leave', subject }) : joinSubject(subject),
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
    joinSubject(existing.id);
  } else {
    send({ type: 'createSubject', name: state.cluster ? `${state.cluster}/${name}` : name });
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
  try {
    localStorage.setItem(NAME_KEY, evt.target.value);
  } catch {
    /* it will last as long as the server remembers them, as it used to */
  }
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
    // The whole group, not just the button — the help button that explains it
    // lives in the wrapper and would otherwise be left standing on its own,
    // offering to explain a control that is not there.
    (bell.closest('.bell-wrap') ?? bell).hidden = true;
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
