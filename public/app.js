import { stroke, regionFill } from './diagram.js';
import { chosenHues, givenHue, hue, isChosen, setHue } from '../lib/palette.js';
import { glyphSwatch } from './glyphs.js';
import { mountAppearance, restoreAppearance } from './appearance.js';
import { cullRelief, renderAtlas, zoneAt, paintAtlas, relabel } from './atlasview.js';
import { TILT, clampTilt, view3d } from './relief.js';
import { gestures } from './gestures.js';
import { fitTo, pointsOf, renderMinimap } from './minimap.js';
import { mountExplorer } from './explorer.js';
import { fillCatalogue, showPrompt } from './catalogue.js';
import { mountPeek } from './peek.js';
import { contextMenu } from './menu.js';
import { attachHelp, busyness, createCard, when } from './hints.js';
import { available, forgetIdentity, rememberedIdentity, seal, unseal } from '../lib/seal.js';
import { mark, prove } from '../lib/proof.js';
import { isPortalRoom } from '../lib/portal.js';
import { commitment, digest, entryInput, verify } from '../lib/receipt.js';
import { REASONS, scan } from '../lib/flag.js';
import { plain, saidAbout } from '../lib/plain.js';
import {
  clusterFromLink,
  clusterOf,
  groupRoom,
  inner,
  inviteLink,
  isCluster,
  isGroupRoom,
  label as subjectLabel,
  named as spoken,
  newCluster,
} from '../lib/cluster.js';
import { qr } from '../lib/qr.js';
import { watchLink, watchedFrom } from '../lib/lurk.js';

const $ = (id) => document.getElementById(id);

/**
 * One of the icons in the page's set, by name, for a button made here rather
 * than in the page; see the `icon-set` at the top of `index.html`.
 */
function icon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', `#icon-${name}`);
  svg.append(use);
  return svg;
}
const svg = $('diagram');

const state = {
  me: null,
  diagram: null,
  history: {},
  selected: null,
  hovered: null,
  results: null,
  /** The level of the catalogue being browsed: `{at, path, children}`. */
  browse: null,
  /** Set when somebody opened a category, so focus follows them into it. */
  browseMoved: false,
  unread: {},
  missed: [],
  atlas: null,
  territories: new Map(),
  /** messageId -> the message as it was, until its deletion receipt arrives. */
  deleting: new Map(),
  /** room key -> the shape that is its ground, for lighting the one being read. */
  grounds: new Map(),
  atlasSize: 5,
  keys: new Map(),
  sealing: false,
  recording: false,
  kept: [],
  /** Messages this person has already reported, so the button can say so. */
  reported: new Set(),
  /** person -> {name, keyId}: whoever this browser has stopped showing. */
  muted: new Map(),
  /** Messages from somebody muted that were asked to be shown anyway. */
  revealed: new Set(),
  /** person -> the message after which muting them is being offered. */
  muteOffers: new Map(),
  /** People whose offer was turned down, so they are not asked about again. */
  declined: new Set(),
  /** Whether to offer at all; a setting, on unless turned off. */
  offerMutes: true,
  /** messageId -> {up, down, score} as everyone else sees it. */
  votes: new Map(),
  cluster: null,
  /** A group entered or come back to: who has joined its conversation, and whether it is open. */
  groupArriving: null,
  /** A group left on this page, whose rooms are left again if they turn up. */
  leftGroup: null,
  /** The message being replied to, if any. */
  replyTo: null,
  /**
   * Watching one conversation, unseen, from a quick-join code: `{key, room,
   * log}`, or null for everybody else. See `lib/lurk.js` and `stopLurking`.
   */
  lurking: null,
  /** room key -> how many lurkers are watching it: a number, never who. */
  lurkers: {},
  written: [],
  viewBox: null,
  overview: null,
  /** The whole catalogue, when it was last asked for; see the `chart` frame. */
  chart: null,
  /** What the server said when last poked, and for which room; see `paintPoke`. */
  poked: null,
  /** Chats the server has already been poked about on their being found empty. */
  autoPoked: new Set(),
  /** Chats pinned to the top of the list, kept in this browser; see `PINNED_KEY`. */
  pinned: new Set(),
  /** Open the busiest chat when the first map after a first join arrives. */
  openBusiest: false,
  /** What the line under the map says; see `says`. */
  status: '',
  /** The interests ticked in "Join some"; see `openJoinSome`. */
  joining: null,
  /** Whether what the server writes is folded away; see `hushSystem`. */
  hushSystem: false,
  /**
   * The map branched out into a community, drawn in place of their own until
   * they go back: `{from, toward, view}`, `view` null until it arrives. See
   * `branchOut`.
   */
  branch: null,
  /** Whether the server trusts this key to moderate, and what it has been told. */
  moderator: false,
  concerns: [],
  /**
   * Rooms standing as tall as they are lively, or flat; see `public/relief.js`.
   * `projection` is the view the map was last drawn with, or null when flat,
   * and `raised` how tall its tallest room stands.
   */
  relief: true,
  turn: 0,
  tilt: TILT,
  projection: null,
  raised: 0,
  // Wide enough to clear the buttons floating along the top and the line
  // along the bottom, so what the view is framed on is not under them.
  FIT_PADDING: 44,
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
    // A lurker is nobody in particular: no key is made or shown, and no earlier
    // visit is asked back, so watching ties them to nothing. They become
    // whoever this browser knows them as when they stop; see `stopLurking`.
    if (state.lurking) {
      notify('');
      return;
    }
    await comeBack();
  });

  ws.addEventListener('message', handleFrame);

  ws.addEventListener('close', () => {
    notify('Reconnecting…');
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 10_000);
  });
}

/**
 * Say who this is: the key this browser keeps, or failing that the id the
 * last connection was known by.
 *
 * Kept as a promise as well as a value. Making the keys takes a moment, and
 * anything that needs them has to be able to wait for them rather than find
 * `state.identity` still null and carry on without.
 *
 * The key is the same one as last time where the browser will hold one, and it
 * is sent on every connection, not only the first. It used to be sent once per
 * page, so anybody whose connection had blinked was somebody the server held
 * no key for, and nothing could be locked for them until they reloaded.
 */
async function comeBack() {
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
    letters.title = `Key ${keyId}`;
    out.append(letters);
  }
  return out;
}

/** Your own key, beside your own name, once the server has seen it shown. */
function paintKey() {
  const keyId = state.me?.keyId;
  $('key-wrap').hidden = !keyId;
  // The way to throw it away, in Settings, is only there while there is one.
  $('key-settings').hidden = !keyId;
  if (!keyId) return;
  $('key-mark').textContent = `·${mark(keyId)}`;
  // In full on hover, because the full one is what a moderator list is made
  // of, and somebody has to be able to read theirs out.
  $('key-mark').title = state.identity?.kept
    ? `Your key: ${keyId}`
    : `Your key: ${keyId} (not saved, so it ends when you close this page)`;
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
  // The button just pressed went with the old key, so the menu it was in is
  // put away and focus goes back to the button that opened it.
  closePopouts();
  $('settings-open').focus({ preventScroll: true });
  notify('New key made. Nothing connects you to the old one.');
  // A key belongs to a connection for as long as the connection lasts, so
  // being somebody else means arriving again. The close handler reconnects.
  ws?.close();
});

function handleFrame(evt) {
  const msg = JSON.parse(evt.data);

  switch (msg.type) {
    case 'welcome':
      state.me = msg.you;
      state.moderator = msg.moderator === true;
      $('moderation').hidden = !state.moderator;
      // The demo says so on every page, since everyone else in it is made up.
      if (msg.demo === true) document.body.dataset.demo = '';
      else delete document.body.dataset.demo;
      // The way to the firehose, where there is one to see.
      $('open-data').hidden = msg.streams !== true;
      // A lurker leaves nothing on this device, not even which connection it was.
      if (!state.lurking) remember(msg.you.id);
      // Never clobber what someone is in the middle of typing.
      if (document.activeElement !== $('name')) $('name').value = msg.you.name;
      paintKey();
      if (state.lurking) {
        // Straight to the one conversation, and to nothing else.
        send({ type: 'watch', room: state.lurking.key });
        break;
      }
      bringNameBack();
      // The server keeps preferences by who somebody is, and a new guest is
      // somebody new, so what this browser remembers is said on every
      // connection rather than once; see `hushSystem`.
      if (state.hushSystem) send({ type: 'notifications', settings: { system: false } });
      // Arriving by a scanned code happens before there is a connection to
      // say so on, so the group's conversation is joined from here — and
      // again if this turns out to be somebody else, which is what happens
      // when a returning visitor's key takes back who they were.
      joinArrivingGroup();
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

    case 'state': {
      // Their own change — the first they hear, or holding something else —
      // or somebody else's, which moved only the counts around what they hold.
      const own = !state.diagram || (msg.subscription ?? []).join('|') !== (state.diagram.subscription ?? []).join('|');
      // Holding nothing and now something: they have just joined their first
      // interest, and the next map opens the busiest chat it put them in,
      // rather than leaving them looking at "Pick a chat".
      if (state.diagram && !(state.diagram.subscription ?? []).length && (msg.subscription ?? []).length) {
        state.openBusiest = true;
      }
      state.diagram = msg;
      // A lurker has no map and no interests to keep up to date, so nothing is
      // asked for that would not be shown — least of all a map, the dearest
      // thing the server draws.
      if (state.lurking) {
        renderRoom();
        break;
      }
      if (state.groupArriving && (msg.subscription ?? []).includes(groupRoom(state.groupArriving.group))) {
        state.groupArriving.seen = true;
      }
      // Left before the connection knew who it was: the rooms turn up with
      // whoever it turns out to be, and are left then.
      if (state.leftGroup && !state.cluster) leaveRoomsOf(state.leftGroup);
      // The atlas is grown from the whole population, so their own change
      // stales it: dropped rather than shown after a join has outdated it, and
      // asked for again at once. Somebody else's leaves the one in hand to be
      // looked at, and pressed, until the next arrives; see `askForMap`.
      if (own) state.atlas = null;
      askForMap({ now: own });
      if (own && state.branch) askBranch();
      renderBranchBar();
      renderRail();
      renderRoom();
      // The catalogue's top level once, and after that whatever level is
      // open while it is being looked at, since joining changes its counts.
      if (!state.browse || $('interests').open) send({ type: 'browse', at: state.browse?.at ?? null });
      if (!state.overview) send({ type: 'overview' });
      else drawMinimap();
      // What is held has changed under the explorer, if it is open: marked at
      // once, and counted again, since the count now includes them. The chart
      // is asked for with the atlas.
      if (explorer?.isOpen) explorer.refresh();
      paintCatalogue();
      break;
    }

    case 'history':
      state.history = msg.rooms;
      // A lurker's conversation is not among the rooms it holds — it holds none
      // — so it is put back after every history, which would otherwise wipe it.
      if (state.lurking?.log) state.history[state.lurking.key] = state.lurking.log;
      renderRoom();
      offerWhatWeKept();
      break;

    case 'watching':
      // The one conversation a lurker came in to watch; see `lib/lurk.js`.
      if (!state.lurking || msg.room !== state.lurking.key) break;
      state.lurking.room = {
        key: msg.room,
        subjects: msg.subjects,
        population: msg.population,
        stats: msg.stats,
        member: false,
        lurkers: msg.lurkers ?? 1,
      };
      state.lurkers[msg.room] = msg.lurkers ?? 1;
      // One array, shared with the history, so what arrives is pushed onto it.
      state.lurking.log = msg.messages ?? [];
      state.history[msg.room] = state.lurking.log;
      renderRoom();
      break;

    case 'restored':
      if (msg.restored) notify(`Restored ${msg.restored} message${msg.restored === 1 ? '' : 's'} from your saved copy.`);
      break;

    case 'message': {
      const log = (state.history[msg.message.room] ??= []);
      log.push(msg.message);
      // Before the render, so an offer to mute them arrives with the message
      // that prompted it. A sealed one has no words yet; it is asked about
      // once it is opened, below.
      considerMuting(msg.message);
      if (msg.message.room === state.selected) {
        renderRoom();
        // Just this one, rather than the whole room. The log is rebuilt from
        // scratch on every render, so announcing the list itself re-read every
        // message each time anybody voted on anything. Nothing at all for
        // somebody muted, whose words are folded away on screen too.
        if (!isMuted(msg.message) && !(state.hushSystem && msg.message.machine)) {
          $('said').textContent = msg.message.machine
            ? `System message, as ${msg.message.author}: ${msg.message.body}`
            : msg.message.sealed
              ? `${msg.message.author} sent an encrypted message`
              : `${msg.message.author} said: ${msg.message.body}`;
        }
      }

      // A sealed message arrives unreadable and is opened here, never on the
      // server, which has no key to open it with.
      if (msg.message.envelope && state.identity) {
        unseal(msg.message.envelope, state.identity)
          .then((text) => {
            if (text === null) return;
            msg.message.body = text;
            keep(msg.message);
            considerMuting(msg.message);
            if (msg.message.room === state.selected) renderRoom();
          })
          .catch(() => {
            msg.message.body = '[could not be decrypted]';
          });
      } else {
        keep(msg.message);
      }
      break;
    }

    case 'atlas': {
      // Asked for again every ten seconds by a page that has the drawing,
      // only the rooms come back — how busy each is, how tall it stands —
      // and are laid over the drawing in hand. One that does not match it,
      // which should not happen, is asked for whole.
      let view = msg;
      if (msg.only === 'rooms') {
        if (!state.atlas || state.atlas.shape !== msg.shape) {
          send({ type: 'atlas', subjects: state.atlasSize });
          break;
        }
        view = { ...state.atlas, subscription: msg.subscription, rooms: msg.rooms };
      }
      state.atlas = view;
      for (const room of view.rooms ?? []) state.lurkers[room.key] = room.lurkers ?? 0;
      // Branched out, the map is the branch's: their own is kept up to date
      // for the list of chats beside it, and drawn again when they go back.
      if (state.branch) {
        drawAtlas({ repaint: false });
        break;
      }
      // The map is drawn again only if what it shows has changed. The server
      // sends a fresh atlas after every change near anybody's interests, and
      // most of those change nothing on this screen; redrawing each time made
      // a map that twitched while nobody was touching it. See `drawnAs`.
      const drawn = drawnAs(view);
      if (drawn === state.drawnAs) {
        drawAtlas({ repaint: false });
        break;
      }
      // Something has changed. Their own change — the first map, or holding
      // something new — is drawn at once, since they are waiting to see it.
      // Anybody else's waits its turn: the map is redrawn for other people's
      // comings and goings at most once every `REDRAW_EVERY`, and then with
      // the latest of them, and in the meantime only the list beside it is
      // brought up to date.
      const theirs = !state.drawnAs || (view.subscription ?? []).join('|') !== state.framedFor;
      const wait = theirs ? 0 : (state.drewAt ?? 0) + REDRAW_EVERY - Date.now();
      if (wait <= 0) {
        redrawMap(drawn);
      } else {
        drawAtlas({ repaint: false });
        state.redrawDue ??= setTimeout(() => {
          state.redrawDue = null;
          if (state.atlas) redrawMap(drawnAs(state.atlas));
        }, wait);
      }
      break;
    }

    case 'branch': {
      // The map branched out into a community; see `branchOut`. One for a
      // branch no longer shown — gone back since, or branched elsewhere — is
      // let go.
      const branch = state.branch;
      const about = msg.branch ?? { from: msg.from, toward: msg.toward ?? null };
      if (!branch || about.from !== branch.from || (about.toward ?? null) !== branch.toward) break;
      if (msg.none) {
        notify(`Nothing to branch into from ${subjectLabel(branch.from)} yet: nobody holds it with anything else.`);
        leaveBranch();
        break;
      }
      let view = msg;
      if (msg.only === 'rooms') {
        if (!branch.view || branch.view.shape !== msg.shape) {
          askBranch({ whole: true });
          break;
        }
        view = { ...branch.view, rooms: msg.rooms, branch: msg.branch };
      }
      const first = !branch.view;
      branch.view = view;
      for (const room of view.rooms ?? []) state.lurkers[room.key] = room.lurkers ?? 0;
      renderBranchBar();
      const drawn = drawnAs(view);
      if (drawn === state.drawnAs) {
        drawAtlas({ repaint: false });
        break;
      }
      state.drawnAs = drawn;
      state.drewAt = Date.now();
      drawAtlas({ repaint: true, fit: first });
      break;
    }

    case 'lurkers': {
      // How many are lurking in a room, as it changes. Written onto
      // the room itself as well, which is what the hover card reads.
      state.lurkers[msg.room] = msg.count;
      for (const room of [...currentRooms(), state.lurking?.room]) {
        if (room?.key === msg.room) room.lurkers = msg.count;
      }
      renderRooms();
      renderRoom();
      break;
    }

    case 'overview':
      // The whole catalogue, at its place in the hierarchy. Cached: it only
      // changes when a subject gains or loses its very first member.
      state.overview = msg;
      drawMinimap();
      break;

    case 'chart':
      // The whole catalogue, for whichever asked: the explorer draws it, if it
      // is open, and the list in Interests is filled from it. Asked for again
      // every ten seconds while All interests is open, by a page that has it,
      // only how lively each interest is comes back, and is laid over the one
      // in hand. The list in Interests shows none of that, so it is not
      // filled again for it: its `at` stays when its counts were fetched.
      if (msg.only === 'activity') {
        if (!state.chart || state.chart.shape !== msg.shape) {
          send({ type: 'chart' });
          break;
        }
        state.chart = livelier(state.chart, msg.activity);
      } else {
        state.chart = { ...msg, at: Date.now() };
      }
      if (explorer?.isOpen) explorer.receive(state.chart);
      paintCatalogue();
      break;

    case 'unread':
      state.unread = msg.counts ?? {};
      renderRooms();
      break;

    case 'missed':
      // Everything that happened while they were away, newest urgency first.
      state.missed = (msg.notifications ?? []).filter((note) => !mutedNote(note));
      if (state.missed.length) {
        notify(`${state.missed.length} missed while you were away`);
      }
      break;

    case 'notification':
      // Somebody muted does not get to badge a room or interrupt either. The
      // message itself still arrives, and is folded away in the log.
      if (mutedNote(msg.notification)) break;
      // Only what there is to read is unread; see `Notifications`.
      if (msg.notification.kind === 'message' || msg.notification.kind === 'mention') {
        state.unread[msg.notification.room] = (state.unread[msg.notification.room] ?? 0) + 1;
      }
      renderRooms();
      announce(msg.notification);
      break;

    case 'browse':
      state.browse = msg;
      if (state.diagram) renderRail();
      followBrowse();
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
      checkReceipt(msg.receipt);
      break;

    case 'receipts':
      checkRecord(msg.receipts ?? []);
      break;

    case 'recording':
      state.recording = msg.on;
      $('recording').checked = msg.on;
      break;

    case 'concerns':
      state.concerns = msg.rooms ?? [];
      renderReports();
      break;

    case 'poked':
      // For the room it was asked about, if that is still the one open.
      if (msg.room && msg.room !== state.selected) break;
      state.poked = { room: msg.room ?? state.selected, text: String(msg.text ?? '') };
      paintPoke();
      break;

    case 'error':
      notify(msg.message);
      // A lurker whose conversation never opened would otherwise wait on
      // "Opening" for ever — which is what a server older than quick join
      // does, since it does not know what watching is.
      if (state.lurking && !state.lurking.room) {
        $('room-title').textContent = 'This chat could not be opened';
        $('room-meta').textContent = `The server said: ${msg.message}. Look around instead, or try the code again later.`;
      }
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
  // Picking a conversation is asking to be in it. On a phone the conversation
  // is a different view, so going there is the rest of the same gesture;
  // where both are on screen at once this does nothing.
  showView('talk');
}

/**
 * Who can read what is about to be said, above the box it is said in.
 *
 * This place is public and says so, in those words, where nobody has to click
 * anything to find out. A portal is the one room that is not — so the sentence
 * has to change rather than stay there being wrong. A product that keeps a
 * standing claim about privacy and quietly makes it false in one place is
 * worse than one that never made the claim.
 */
function sayWhoCanRead(room) {
  // Written into its own span, not the note, which also carries the note's
  // help button: emptying the note took the button with it on the very first
  // render, and the one explanation everybody should be able to reach was not.
  const note = document.querySelector('.public-note');
  const text = $('public-note-text');
  const hidden = room && isPortalRoom(room.key);
  note.classList.toggle('sealed-room', Boolean(hidden));
  text.textContent = '';

  const lead = document.createElement('strong');
  if (hidden) {
    lead.textContent = 'Only the two of you can find this.';
    text.append(
      lead,
      document.createTextNode(
        ' It is not in the public list, and its address changes every day. It does not ' +
          'hide that you are talking, and when. Tick Encrypt below to hide what you say.',
      ),
    );
  } else {
    lead.textContent = 'Everyone can read this.';
    text.append(lead, document.createTextNode(' Tick '));
    const how = document.createElement('em');
    how.textContent = 'Encrypt';
    text.append(how, document.createTextNode(' to limit a message to the people here.'));
  }
}

// --- the shape of the place -------------------------------------------------

/**
 * Where the panels divide, which side the map is on, and whether it is on a
 * side at all.
 *
 * The map starts docked down the left with the conversation on its right. It
 * can be put on the other side, or pulled out as a window that is moved and
 * sized like any other and docks again when it is dragged back to a side.
 *
 * A few numbers and two flags, kept in this browser. The grid is written in
 * named areas against a custom property, so moving the handle is one property
 * write and the layout follows — there is no per-panel arithmetic here, and
 * each arrangement is a different `grid-template-areas` rather than a
 * different set of rules. The window is the same: four properties on the
 * panel, and the stylesheet does the rest.
 *
 * There used to be a second division, between the map and the interests
 * under it. The interests are a dialog now and the map has its whole column,
 * so a share saved for it is simply not read back. Nor is the `sides` an
 * older version kept: its `swapped` is where the map starts now, and its
 * `normal` cannot be told from never having chosen.
 *
 * Bounded on both ends. A pane dragged to nothing is a pane somebody has to
 * work out how to get back, and the minimums in the grid template are what
 * stop the drag before it becomes that. The window is held inside the page
 * and under the header for the same reason: its bar is the only way to move
 * it, so its bar is never anywhere it cannot be reached.
 */
const LAYOUT_KEY = 'eulerchat.layout';
const LAYOUT = {
  talk: { min: 25, max: 75, prop: '--talk' },
};
const FLOAT_MIN = { w: 340, h: 240 };
const FLOAT_START = { x: null, y: null, w: 520, h: 440 };
/** How near a side of the page a drag has to end for the map to dock there. */
const DOCK_EDGE = 36;
const layout = { talk: 58, side: 'left', floating: false, float: { ...FLOAT_START } };
const mapPanel = document.querySelector('.map');

function applyLayout() {
  document.body.style.setProperty(LAYOUT.talk.prop, `${layout.talk}%`);
  document.body.dataset.dock = layout.floating ? 'float' : layout.side;
  if (layout.floating) placeFloat();
  $('split-col').setAttribute('aria-valuenow', String(Math.round(layout.talk)));
  paintLayoutButtons();
  // The drawing is framed to its panel, and its panel is a different size now.
  refit();
}

function rememberLayout() {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    /* a private window: the layout lasts as long as the page, which is fine */
  }
}

function restoreLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}');
    // Read back one at a time and clamp. What is in storage was put there by
    // a previous version of this code, or by hand, and neither is a promise.
    for (const which of Object.keys(LAYOUT)) {
      const value = Number(saved[which]);
      if (Number.isFinite(value)) {
        layout[which] = Math.min(LAYOUT[which].max, Math.max(LAYOUT[which].min, value));
      }
    }
    if (saved.side === 'right') layout.side = 'right';
    layout.floating = saved.floating === true;
    // Where the window was. Only read here; `placeFloat` is what makes it fit
    // the page as the page is now.
    for (const which of Object.keys(FLOAT_START)) {
      const value = saved.float?.[which];
      if (typeof value === 'number' && Number.isFinite(value)) layout.float[which] = value;
    }
  } catch {
    /* unreadable: the defaults are a perfectly good answer */
  }
  applyLayout();
}

/** Move one division to a percentage, clamped, and remember it. */
function setDivision(which, percent) {
  const { min, max } = LAYOUT[which];
  layout[which] = Math.min(max, Math.max(min, percent));
  applyLayout();
  rememberLayout();
}

function dragSplitter(handle, which) {
  handle.addEventListener('pointerdown', (evt) => {
    evt.preventDefault();
    handle.setPointerCapture(evt.pointerId);
    const box = document.body.getBoundingClientRect();

    const move = (at) => {
      const fraction = ((at.clientX - box.left) / box.width) * 100;
      // With the map on the left the conversation is on the right, so the
      // handle's distance from the left edge is the share of everything else.
      setDivision(which, layout.side === 'left' ? 100 - fraction : fraction);
    };

    const up = () => {
      handle.releasePointerCapture?.(evt.pointerId);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
    };

    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });

  // A separator that only answers a drag is a separator half the people here
  // cannot use. The arrow keys move it, and Home and End take it to its ends.
  // The arrows go the way the handle goes, so which of them gives the
  // conversation more room depends on which side the conversation is on.
  handle.addEventListener('keydown', (evt) => {
    const step = (evt.shiftKey ? 10 : 2) * (layout.side === 'left' ? -1 : 1);
    if (evt.key === 'ArrowLeft') setDivision(which, layout[which] - step);
    else if (evt.key === 'ArrowRight') setDivision(which, layout[which] + step);
    else if (evt.key === 'Home') setDivision(which, LAYOUT[which].min);
    else if (evt.key === 'End') setDivision(which, LAYOUT[which].max);
    else return;
    evt.preventDefault();
  });
}

dragSplitter($('split-col'), 'talk');

// --- the map, as a window ---------------------------------------------------

/**
 * The room the window has: the page, less the header.
 *
 * Asked for each time rather than kept, since the header wraps and the page
 * is resized. The fallbacks are for anywhere that is not a browser, where
 * there is no page to measure and nothing to see either.
 */
function floatRoom() {
  const top = document.querySelector('.bar')?.getBoundingClientRect?.().bottom ?? 0;
  return {
    top: Math.round(top),
    width: globalThis.innerWidth || 1280,
    height: globalThis.innerHeight || 800,
  };
}

/** Fit the window to the page as it is now, and put it there. */
function placeFloat() {
  const at = layout.float;
  const room = floatRoom();
  at.w = Math.min(Math.max(at.w, FLOAT_MIN.w), room.width);
  at.h = Math.min(Math.max(at.h, FLOAT_MIN.h), Math.max(FLOAT_MIN.h, room.height - room.top));
  // Never out before: top right, which is over the part of a conversation
  // with the fewest words in it.
  if (at.x === null || at.y === null) {
    at.x = room.width - at.w - 24;
    at.y = room.top + 24;
  }
  at.x = Math.round(Math.max(0, Math.min(at.x, room.width - at.w)));
  at.y = Math.round(Math.max(room.top, Math.min(at.y, room.height - at.h)));
  for (const [which, value] of Object.entries(at)) {
    mapPanel.style.setProperty(`--float-${which}`, `${Math.round(value)}px`);
  }
}

/** Put the map down one side. */
function dockMap(side) {
  layout.side = side;
  layout.floating = false;
  applyLayout();
  rememberLayout();
  notify(`Map docked on the ${side}.`);
}

/** Pull the map out as a window, where it was the last time it was out. */
function floatMap() {
  layout.floating = true;
  applyLayout();
  rememberLayout();
}

/** Which side letting go here would dock the map on, if either. */
function dockSideAt(x) {
  if (x <= DOCK_EDGE) return 'left';
  if (x >= floatRoom().width - DOCK_EDGE) return 'right';
  return null;
}

/** Show where the map would land, or stop showing it. */
function hintDock(side) {
  const hint = $('dock-hint');
  hint.hidden = !side;
  if (!side) return;
  hint.dataset.side = side;
  hint.style.top = `${floatRoom().top}px`;
}

/**
 * Carry the window about under the pointer until it is let go.
 *
 * The panel holds the pointer rather than whatever was pressed. The drag can
 * start on Pop out, which is gone the moment the map is out, and a capture
 * does not outlast the element that holds it being taken off the page. It
 * also means the release is not a click on anything, so pulling the map out
 * by its button does not then press the button.
 */
function moveMapWindow(evt) {
  mapPanel.setPointerCapture?.(evt.pointerId);
  document.body.dataset.dragging = 'map';
  const grab = { x: evt.clientX - layout.float.x, y: evt.clientY - layout.float.y };
  const from = { x: layout.float.x, y: layout.float.y };

  const move = (at) => {
    layout.float.x = at.clientX - grab.x;
    layout.float.y = at.clientY - grab.y;
    placeFloat();
    hintDock(dockSideAt(at.clientX));
  };

  const up = (at) => {
    mapPanel.releasePointerCapture?.(evt.pointerId);
    mapPanel.removeEventListener('pointermove', move);
    mapPanel.removeEventListener('pointerup', up);
    mapPanel.removeEventListener('pointercancel', up);
    delete document.body.dataset.dragging;
    hintDock(null);
    // A drag the browser took away was not let go of anywhere.
    const side = at.type === 'pointerup' ? dockSideAt(at.clientX) : null;
    if (!side) return rememberLayout();
    // Carried to a side, the window was on its way somewhere and not being
    // put anywhere, so where it comes out next is where it set off from and
    // not hard against the side it was docked on.
    Object.assign(layout.float, from);
    dockMap(side);
  };

  mapPanel.addEventListener('pointermove', move);
  mapPanel.addEventListener('pointerup', up);
  mapPanel.addEventListener('pointercancel', up);
}

$('map-bar').addEventListener('pointerdown', (evt) => {
  if (evt.button !== 0 || evt.target.closest('.map-bar-button')) return;
  moveMapWindow(evt);
});

// Pressed, Pop out puts the window where it last was. Dragged, it pulls the
// map out under the pointer and the same drag carries on moving it — a few
// pixels in, so that a press with an unsteady hand is still a press.
$('map-popout').addEventListener('pointerdown', (evt) => {
  if (evt.button !== 0) return;
  const button = evt.currentTarget;
  button.setPointerCapture?.(evt.pointerId);

  const move = (at) => {
    if (Math.hypot(at.clientX - evt.clientX, at.clientY - evt.clientY) < 6) return;
    done();
    button.releasePointerCapture?.(evt.pointerId);
    // Under the pointer, held by the middle of its bar.
    layout.float.x = at.clientX - layout.float.w / 2;
    layout.float.y = at.clientY - 16;
    floatMap();
    moveMapWindow(at);
  };

  const done = () => {
    button.removeEventListener('pointermove', move);
    button.removeEventListener('pointerup', done);
    button.removeEventListener('pointercancel', done);
  };

  button.addEventListener('pointermove', move);
  button.addEventListener('pointerup', done);
  button.addEventListener('pointercancel', done);
});

// The button that was pressed is not there afterwards, in either direction,
// so focus is handed to the one that undoes it rather than dropped.
$('map-popout').addEventListener('click', () => {
  floatMap();
  $('map-grip').focus();
});

for (const side of ['left', 'right']) {
  $(`dock-${side}`).addEventListener('click', () => {
    dockMap(side);
    $('map-popout').focus();
  });
}

// The window for anybody not dragging: the arrows move it, and with Shift
// they move its far corner instead.
$('map-grip').addEventListener('keydown', (evt) => {
  const way = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[evt.key];
  if (!way || !layout.floating) return;
  evt.preventDefault();
  const step = 24;
  if (evt.shiftKey) {
    layout.float.w += way[0] * step;
    layout.float.h += way[1] * step;
  } else {
    layout.float.x += way[0] * step;
    layout.float.y += way[1] * step;
  }
  placeFloat();
  if (evt.shiftKey) refit();
  rememberLayout();
});

/**
 * An edge or a corner, dragged.
 *
 * Whichever edges the handle is on follow the pointer and the others stay
 * where they were, so the limits are worked out against the opposite edge and
 * not handed to `placeFloat`, which would keep the size and move the window.
 */
function sizeMapWindow(evt, handle) {
  if (evt.button !== 0) return;
  evt.preventDefault();
  handle.setPointerCapture?.(evt.pointerId);
  document.body.dataset.dragging = 'map';
  const edge = handle.dataset.edge;
  const from = { ...layout.float };
  const room = floatRoom();
  const right = from.x + from.w;
  const bottom = from.y + from.h;

  const move = (at) => {
    const dx = at.clientX - evt.clientX;
    const dy = at.clientY - evt.clientY;
    const to = layout.float;
    if (edge.includes('e')) to.w = Math.max(FLOAT_MIN.w, Math.min(from.w + dx, room.width - from.x));
    if (edge.includes('s')) to.h = Math.max(FLOAT_MIN.h, Math.min(from.h + dy, room.height - from.y));
    if (edge.includes('w')) {
      to.x = Math.max(0, Math.min(from.x + dx, right - FLOAT_MIN.w));
      to.w = right - to.x;
    }
    if (edge.includes('n')) {
      to.y = Math.max(room.top, Math.min(from.y + dy, bottom - FLOAT_MIN.h));
      to.h = bottom - to.y;
    }
    placeFloat();
    refit();
  };

  const up = () => {
    handle.releasePointerCapture?.(evt.pointerId);
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
    handle.removeEventListener('pointercancel', up);
    delete document.body.dataset.dragging;
    rememberLayout();
  };

  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', up);
}

// Four edges and four corners. Made here rather than written into the page:
// they are eight of the same thing, and nothing but a pointer can use them.
for (const edge of ['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw']) {
  const handle = document.createElement('div');
  handle.className = 'map-edge';
  handle.dataset.edge = edge;
  handle.addEventListener('pointerdown', (evt) => sizeMapWindow(evt, handle));
  mapPanel.append(handle);
}

// The page got smaller, and the window may now be hanging off it.
globalThis.addEventListener?.('resize', () => {
  if (!layout.floating) return;
  placeFloat();
  refit();
});

/** Put everything back where it started, for anybody who has pulled it apart. */
function resetLayout() {
  layout.talk = 58;
  layout.side = 'left';
  layout.floating = false;
  layout.float = { ...FLOAT_START };
  applyLayout();
  rememberLayout();
}

$('swap-sides').addEventListener('click', () => {
  layout.side = layout.side === 'left' ? 'right' : 'left';
  applyLayout();
  rememberLayout();
});

$('float-map').addEventListener('click', () => {
  if (layout.floating) dockMap(layout.side);
  else floatMap();
});

$('reset-layout').addEventListener('click', () => {
  resetLayout();
  notify('Layout reset.');
});

function paintLayoutButtons() {
  $('swap-sides').setAttribute('aria-pressed', String(layout.side === 'right'));
  // Out of its side, the map has no side to swap.
  $('swap-sides').disabled = layout.floating;
  $('float-map').setAttribute('aria-pressed', String(layout.floating));
}

restoreLayout();

// --- one place at a time ----------------------------------------------------

/**
 * Which of the two panels a narrow screen is showing.
 *
 * A phone cannot hold the map and the conversation at once, so there they are
 * two places rather than two columns. Above the breakpoint both are visible
 * and this only records a preference nobody can see. The interests are not
 * one of the places: they are a dialog over whichever is showing.
 *
 * Kept on `body` rather than in a class on each panel, so that the stylesheet
 * decides what "showing" means and this does not have to know.
 */
function showView(view) {
  if (document.body.dataset.view === view) return;
  document.body.dataset.view = view;
  for (const tab of $('switch').querySelectorAll('button[data-view]')) {
    tab.setAttribute('aria-current', String(tab.dataset.view === view));
  }
  // The picture is drawn to fit its panel, and its panel was `display: none`
  // until a moment ago — so it was measured at zero and has to be asked again.
  if (view === 'map') refit();
}

$('switch').addEventListener('click', (evt) => {
  const tab = evt.target.closest('button[data-view]');
  if (tab) showView(tab.dataset.view);
});

/** How much is waiting somewhere you are not looking. */
function paintWaiting() {
  const total = Object.values(state.unread).reduce((sum, n) => sum + n, 0);
  // On the Chat tab on a phone, and on the Conversations button everywhere,
  // since that is where the rooms it is counting are listed.
  for (const badge of [$('talk-waiting'), $('rooms-waiting'), $('room-list-waiting')]) {
    badge.textContent = total > 99 ? '99+' : String(total);
    badge.hidden = total === 0;
  }
  labelRoomsButton(total);
}

/** What the Chats button says it holds, read out as well as shown. */
function labelRoomsButton(waiting) {
  const count = currentRooms().length;
  $('rooms-total').textContent = count ? `· ${count}` : '';
  $('rooms-open').setAttribute(
    'aria-label',
    `Chats${count ? `, ${count}` : ''}${waiting ? `, ${waiting} unread` : ''}`,
  );
}

// Start on the map. With nothing joined it is where the note is that says what
// to do first, and the Interests button that note points at is in the bar
// along the bottom, beside the tab for the map itself.
showView('map');

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
/**
 * Every room there is to open: their own map's, and the branch's while one is
 * drawn — each once, their own map's first, so it is the same room whichever
 * it is opened from.
 */
function currentRooms() {
  const own = state.atlas?.rooms ?? [];
  const branched = state.branch?.view?.rooms;
  if (!branched) return own;
  const seen = new Set(own.map((r) => r.key));
  return [...own, ...branched.filter((r) => !seen.has(r.key))];
}

/** The map being drawn: a branch while there is one, otherwise their own. */
const mapView = () => state.branch?.view ?? state.atlas;

/** How many lurkers are watching a room, as last heard. */
const lurkersIn = (room) => (room ? (state.lurkers[room.key] ?? room.lurkers ?? 0) : 0);

/**
 * Every room in view, listed, with anything waiting in it.
 *
 * The map is the good way in, but it cannot be the only way. A room whose
 * exclusive area is covered over by its neighbours has no ground to click —
 * which happens most often to single-subject rooms, since those are the ones
 * their overlaps eat into. The list reaches them regardless of geometry.
 */
/** How lively, against the liveliest on the platform, a chat must be to be "lively now". */
const LIVELY = 0.3;

/**
 * The chats in view, in the order the list shows them: the ones you are in,
 * then the rest, each busiest first — what is waiting for you, then how lively
 * it has been (the same measure the map's heights are), then how many are in
 * it. Headed where there are both kinds; a heading is `{heading}`.
 */
function orderedRooms() {
  const rooms = currentRooms();
  const busiest = (a, b) =>
    (state.unread[b.key] ?? 0) - (state.unread[a.key] ?? 0) ||
    (b.activity ?? 0) - (a.activity ?? 0) ||
    b.population - a.population;
  // Pinned first, as pinned; then the few liveliest of the rest, against the
  // whole platform — the same measure the map's heights are — so the heights
  // can be followed from the list too; then yours, then the others.
  const pinned = rooms.filter((r) => state.pinned.has(r.key));
  const rest = rooms.filter((r) => !state.pinned.has(r.key));
  const lively = rest
    .filter((r) => (r.activity ?? 0) >= LIVELY)
    .sort((a, b) => (b.activity ?? 0) - (a.activity ?? 0))
    .slice(0, 3);
  const others = rest.filter((r) => !lively.includes(r));
  const groups = [
    ['Pinned', pinned.sort(busiest)],
    ['Lively now', lively],
    ['Yours', others.filter((r) => r.member).sort(busiest)],
    ['Others on this map', others.filter((r) => !r.member).sort(busiest)],
  ].filter(([, group]) => group.length);
  return groups.flatMap(([heading, group]) => (groups.length > 1 ? [{ heading }, ...group] : group));
}

function renderRooms() {
  const list = $('rooms');
  list.textContent = '';
  paintWaiting();

  for (const room of orderedRooms()) {
    // A heading is words, not a button: the list is a list of chats to open.
    if (room.heading) {
      const heading = document.createElement('li');
      heading.className = 'rooms-group';
      heading.textContent = room.heading;
      list.append(heading);
      continue;
    }
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `room-chip${room.key === state.selected ? ' on' : ''}${room.member ? ' mine' : ''}${room.offMap ? ' off-map' : ''}`;

    // One square per subject rather than one blended dot. A room is the
    // subjects it is made of, and two of them side by side say that in a way
    // the average of their colours cannot.
    const dot = document.createElement('span');
    dot.className = 'chip-glyphs';
    // Three squares at most, since a room can combine ten and the list is
    // narrow; past three, how many more, so none of them goes unsaid.
    const own = inner(room.subjects);
    for (const subject of own.slice(0, 3)) {
      dot.append(glyphSwatch(document, subject, 14));
    }
    if (own.length > 3) {
      const more = document.createElement('span');
      more.className = 'chip-more';
      more.textContent = `+${own.length - 3}`;
      dot.append(more);
    }

    // Named as the room is read, so the group's art is `art` and not
    // `kite-fox-9/art ∩ kite-fox-9/everyone`; the outline on the map, and the
    // group in the header, already say where it is.
    const name = document.createElement('span');
    name.className = 'chip-name';
    name.textContent = spoken(room.subjects).join(' + ');

    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = String(room.population);

    button.append(dot, name, count);

    // And how many are lurking in it, when anybody is: a number,
    // never who. See `lib/lurk.js`.
    const watching = lurkersIn(room);
    if (watching) {
      const seen = document.createElement('span');
      seen.className = 'lurk-count';
      seen.textContent = `${watching} lurking`;
      button.append(seen);
    }
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
      `${spoken(room.subjects).join(' and ')}, ${room.population} ${room.population === 1 ? 'person' : 'people'}` +
        `${watching ? `, ${watching} lurking` : ''}` +
        `${room.member ? ', you are in this one' : ''}${room.offMap ? ', not on the map' : ''}` +
        `${state.pinned.has(room.key) ? ', pinned' : ''}${waiting ? `, ${waiting} unread` : ''}`,
    );

    button.addEventListener('contextmenu', (evt) => {
      evt.preventDefault();
      card.hide();
      const box = button.getBoundingClientRect?.();
      // The keyboard's menu key says nowhere in particular: under the chip.
      const keyed = !evt.clientX && !evt.clientY;
      openMenu(keyed && box ? box.left + 12 : evt.clientX, keyed && box ? box.bottom : evt.clientY, room.key, button);
    });

    button.addEventListener('click', () => {
      // A menu closes once something in it is chosen. The chip is rebuilt by
      // the render that follows, so focus goes back to the button that opened
      // the list rather than to nowhere.
      closePopouts();
      select(room.key);
      if (document.activeElement === document.body) $('rooms-open').focus({ preventScroll: true });
    });

    li.append(button);
    list.append(li);
  }
  labelRoomsButton(Object.values(state.unread).reduce((sum, n) => sum + n, 0));
}

/**
 * The note on the map that says what to do first.
 *
 * It goes by itself once anything is joined, and it can be closed before
 * then. Closed, it stays closed in this browser: it is one paragraph of
 * instructions, and somebody who has read it once does not need it again.
 * "View note" in the View menu brings it back — and, having been asked for,
 * it stays until it is closed, joined interests or not.
 */
const TIP_KEY = 'eulerchat.tipClosed';
let tipClosed = false;
let tipAsked = false;
try {
  tipClosed = localStorage.getItem(TIP_KEY) === '1';
} catch {
  /* a private window: closing it lasts as long as the page */
}

function showTip() {
  const joined = (state.diagram?.subscription?.length ?? 0) > 0;
  $('lede').hidden = tipClosed || (joined && !tipAsked);
  // Until something is held, the way to hold something is the thing to find:
  // Interests in the header wears the accent while there is nothing.
  document.body.dataset.held = joined ? '1' : '0';
}

function rememberTip() {
  try {
    if (tipClosed) localStorage.setItem(TIP_KEY, '1');
    else localStorage.removeItem(TIP_KEY);
  } catch {
    /* as above */
  }
}

$('lede-close').addEventListener('click', () => {
  tipClosed = true;
  tipAsked = false;
  rememberTip();
  showTip();
  // The button has just gone, so focus goes to the next thing on the map
  // rather than back to the top of the page.
  $('rooms-open').focus({ preventScroll: true });
});

$('tip-show').addEventListener('click', () => {
  tipClosed = false;
  tipAsked = true;
  rememberTip();
  showTip();
  // Out of the way of the note, and onto it: its Close is described by the
  // note, so this is also what reads it out.
  closePopouts();
  $('lede-close').focus({ preventScroll: true });
});

showTip();

/**
 * The atlas draws exactly the occupied regions at exactly the right sizes, so
 * the only thing it can get wrong is a subject ending up in more than one
 * patch — which is what the note under it reports.
 */
/**
 * The map and everything that goes with it: the rooms listed, the room open,
 * the minimap.
 *
 * `repaint: false` leaves the drawing itself alone — the data came again and
 * says what it said — and brings only the rest up to date. `fit` frames it on
 * their interests again rather than keeping wherever they had got to.
 */
function drawAtlas({ repaint = true, fit = false } = {}) {
  const view = mapView();
  if (!view) {
    says('Drawing the map…');
    return;
  }

  if (repaint || !state.viewBox) paintMap({ fit });
  openBusiest();
  renderRooms();
  recountRail();
  // The room as well as the list of them. A membership change drops the atlas
  // and asks for a fresh one, and until this was here the open conversation
  // was never drawn again when it arrived — so joining anything while reading
  // left the panel saying "Pick a conversation" about the room you were
  // already in. Joining from inside that panel made it unmissable.
  renderRoom();
  drawMinimap();
  showTip();
  openArrivedGroup();
  renderGroupCount();

  const { report, subjects, zones } = view;
  const split = report.disconnected.length;
  // A new deployment starts with one person in one interest, so the ones are
  // what anybody reads first.
  const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const drawn = `${count(subjects.length, 'interest')} · ${count(zones.length, 'chat')} · to scale`;
  says(
    state.branch
      ? `Branched out · ${drawn}`
      : !(view.subscription ?? []).length
        ? 'Popular interests. Join one to see yours.'
        : split
          ? `${drawn} · ${count(split, 'interest')} shown in pieces`
          : drawn,
  );
  // Orange only when the drawing is wrong: a room drawn that nobody is in, or
  // one left out. A subject in two pieces is said in words and is not an
  // error, and a line always in the warning colour stopped being read.
  $('fit').classList.toggle('flag', !report.exact || report.phantoms > 0 || report.vanished > 0);
}

/**
 * The line under the map: what is drawn, or what is being waited for. Kept as
 * well as written, since a label under the pointer writes over it and puts it
 * back on the way out; see `paintMap`.
 */
function says(text) {
  state.status = text;
  $('fit').textContent = text;
}

/** After a first join, the busiest chat it opened for them; see `state.openBusiest`. */
function openBusiest() {
  if (!state.openBusiest || state.lurking || state.groupArriving) return;
  const mine = currentRooms().filter((r) => r.member && !isGroupRoom(r.subjects[0] ?? ''));
  if (!mine.length) return;
  state.openBusiest = false;
  if (state.selected) return;
  const [busiest] = [...mine].sort(
    (a, b) => (b.activity ?? 0) - (a.activity ?? 0) || b.population - a.population || (a.key < b.key ? -1 : 1),
  );
  select(busiest.key);
}

/**
 * The map itself, drawn again, and nothing else. Orbiting it calls this alone,
 * a frame at a time, since nothing else on the page changes when it turns.
 *
 * `keep` holds a point of the ground still on the screen, as a fraction of the
 * way across and down: turned or tilted, the map goes round the fingers, or
 * round the middle, rather than jumping back to where it started.
 *
 * @param {{keep?: {ground: [number, number], fx: number, fy: number} | null}} [options]
 */
function paintMap({ keep = null, fit = false, box = null } = {}) {
  const view = mapView();
  if (!view) return;
  state.projection = state.relief ? view3d({ turn: state.turn, tilt: state.tilt }) : null;
  ({
    territories: state.territories,
    grounds: state.grounds,
    written: state.written,
    raised: state.raised = 0,
    cull: state.cull = null,
  } = renderAtlas(svg, view, { relief: state.projection }));

  // The native tooltip says it too, but only after a pause; this says it at
  // once, which is what makes the shortened labels feel readable rather than
  // cryptic.
  // Put back by hand on the way out, rather than by redrawing. Redrawing
  // recomputed the fit and threw away whatever the person had panned and
  // zoomed to, so brushing past a label reset the map under their cursor.
  //
  // What is put back is what the line says now, not what it said when the map
  // was drawn: the line is written after the drawing, so keeping a copy here
  // put back the sentence before this one — after branching out, "Branching
  // out…", about a branch that had arrived.
  for (const spot of svg.querySelectorAll('.zone-label')) {
    spot.addEventListener('mouseenter', () => {
      $('fit').textContent = spot.dataset.full;
    });
    spot.addEventListener('mouseleave', () => {
      $('fit').textContent = state.status ?? '';
    });
  }

  // Framed on their own interests rather than on the whole drawing, so opening
  // the atlas puts them where they already are instead of somewhere to be
  // found. Everything else is still there to pan to; this only decides where
  // the view starts.
  //
  // Orbited, it keeps whatever point it was asked to keep where it was. Drawn
  // again for any other reason — somebody else's change nearby, a new colour —
  // it stays exactly where it was: a map that jumps back to the start while
  // somebody is looking at it is a map they cannot use. It is framed afresh
  // only the first time, when asked, and when what they hold has changed,
  // since then the interests it is framed on are not the same ones.
  //
  // A branch is framed on the whole of it: what it is for is the part of it
  // they do not hold.
  const own = state.branch ? [] : pointsOf(view.curves, view.subscription ?? []);
  const framing = state.branch
    ? `branch:${state.branch.from}>${state.branch.toward ?? ''}`
    : (view.subscription ?? []).join('|');
  if (keep && state.projection && state.viewBox) {
    const [x, y] = state.projection.at(keep.ground[0], keep.ground[1]);
    const { width, height } = state.viewBox;
    state.viewBox = { x: x - keep.fx * width, y: y - keep.fy * height, width, height };
  } else if (fit || !state.viewBox || framing !== state.framedFor) {
    state.viewBox = fitTo(svg, asDrawn(own.length ? own : pointsOf(view.curves)), state.FIT_PADDING);
    state.fitted = state.viewBox?.width;
    state.framedFor = framing;
    state.sizedAt = sizeOfMap();
  }
  applyView(box ?? undefined);
  paintAtlas(state.territories, state.selected, state.grounds);
}

/**
 * Everything about an atlas that shows on the map, as one string: the shapes,
 * the names and where they go, and what decides how each room is coloured and
 * how tall it stands. Not who is lurking, or who is a member of what — those
 * are on the rooms' cards and in the list, not in the drawing — so an atlas
 * that differs only in those is the same map, and is not drawn again.
 */
function drawnAs(view) {
  return JSON.stringify([
    view.extent,
    view.subscription,
    (view.curves ?? []).map((c) => [c.subject, c.components, c.anchor, c.loops]),
    (view.zones ?? []).map((z) => [z.key, z.x, z.y, z.population, z.room, z.loops]),
    // Not the chats listed beside the map: they have no ground on it.
    (view.rooms ?? []).filter((r) => !r.offMap).map((r) => [r.key, r.activity ?? 0, r.stats?.perMinute ?? 0]),
  ]);
}

/** How often, at most, other people's changes redraw the map. */
const REDRAW_EVERY = 10_000;

/**
 * Ask the server for the map again, and for All interests if it is open.
 *
 * At once for their own change. Otherwise every `REDRAW_EVERY`, whatever
 * else happens, for how things stand by then: how busy each room has been,
 * and so how tall it stands, changes with everything said anywhere, and
 * nothing else would say so — the server tells a page only when somebody
 * joins or leaves near what it holds. Somebody else's joining is left to the
 * next of those too, rather than asked about as it happens: somewhere busy
 * that was dozens of times a minute, which spent the whole of the
 * connection's allowance, so that what they tried to say themselves was
 * turned away as too much too fast.
 *
 * Each ask says which drawing it has, and while that is still the drawing,
 * only the numbers come back; see `atlasFor` on the server.
 *
 * @param {{now?: boolean}} [options]
 */
function askForMap({ now = false } = {}) {
  if (now) askNow();
  else if (!state.askDue && !state.askWhenSeen) askLater();
}

function askNow() {
  clearTimeout(state.askDue);
  state.askDue = null;
  state.askWhenSeen = false;
  // A lurker has no map to keep up to date; see `case 'state'`.
  if (state.lurking) return;
  state.askedAt = Date.now();
  send({ type: 'atlas', subjects: state.atlasSize, have: state.atlas?.shape });
  if (state.branch) askBranch();
  if (explorer?.isOpen) send({ type: 'chart', have: state.chart?.shape });
  askLater();
}

/**
 * The next ask, `REDRAW_EVERY` after the last. Not while the page is out of
 * sight, where nobody is looking and the server would work for nothing: then
 * as soon as it is back.
 */
function askLater() {
  clearTimeout(state.askDue);
  const wait = Math.max(0, (state.askedAt ?? 0) + REDRAW_EVERY - Date.now());
  state.askDue = setTimeout(() => {
    state.askDue = null;
    if (document.hidden) state.askWhenSeen = true;
    else askNow();
  }, wait);
  // Never the one thing keeping a finished run of the page going: a test.
  state.askDue?.unref?.();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.askWhenSeen) askNow();
});

/**
 * A chart with how lively each interest is now, from a list of those that
 * are lively at all. The rest are left as they were but without `a`, as the
 * server leaves them, so it reads exactly as a whole chart of the same would.
 */
function livelier(chart, activity) {
  const lively = new Map(activity);
  return {
    ...chart,
    subjects: chart.subjects.map((s) => {
      const a = lively.get(s.id);
      if (a === s.a) return s;
      if (a) return { ...s, a };
      const { a: _quiet, ...rest } = s;
      return rest;
    }),
  };
}

/** Draw the map for the atlas in hand, and note when, and what it showed. */
function redrawMap(drawn) {
  clearTimeout(state.redrawDue);
  state.redrawDue = null;
  if (drawn === state.drawnAs && state.viewBox) return;
  state.drawnAs = drawn;
  state.drewAt = Date.now();
  drawAtlas({ repaint: true });
}

/** How big the map is on the screen, or nothing yet if it is not on it. */
function sizeOfMap() {
  const box = svg.getBoundingClientRect?.();
  return box?.width && box?.height ? { width: box.width, height: box.height } : null;
}

/**
 * The map's panel changed size: the same view, at the same scale, only more
 * or less of it. Not redrawn and not framed again — nothing it shows has
 * changed — except the first time it has a size at all, having been hidden
 * when it was drawn, when it is framed properly now that it can be measured.
 */
function reshapeMap() {
  if (!mapView()) return;
  const now = sizeOfMap();
  // Hidden, there is nothing to fit it to until it is shown again.
  if (!now && state.viewBox) return;
  if (!state.viewBox || !state.sizedAt || !now) {
    drawAtlas({ fit: true });
    return;
  }
  if (now.width === state.sizedAt.width && now.height === state.sizedAt.height) return;
  const vb = state.viewBox;
  const scale = state.sizedAt.width / vb.width;
  const cx = vb.x + vb.width / 2;
  const cy = vb.y + vb.height / 2;
  const width = now.width / scale;
  const height = now.height / scale;
  state.viewBox = { x: cx - width / 2, y: cy - height / 2, width, height };
  state.fitted = state.fitted && (state.fitted * now.width) / state.sizedAt.width;
  state.sizedAt = now;
  applyView();
}

/**
 * Points on the sheet as the map draws them: where they are on the ground,
 * and where they would be at the height of the tallest room, so framing on
 * them leaves room for what stands on them.
 */
function asDrawn(points) {
  const view = state.projection;
  if (!view) return points;
  return points.flatMap(([x, y]) => [view.at(x, y, 0), view.at(x, y, state.raised)]);
}

// --- relief ------------------------------------------------------------------

const RELIEF_KEY = 'eulerchat.relief';

/** Rooms raised or flat, here and in All interests, remembered in this browser. */
function setRelief(on, { keep = true } = {}) {
  state.relief = Boolean(on);
  if (keep) {
    try {
      localStorage.setItem(RELIEF_KEY, state.relief ? '3d' : 'flat');
    } catch {
      /* it will last as long as the page does */
    }
  }
  for (const id of ['relief', 'explorer-relief']) $(id)?.setAttribute('aria-pressed', String(state.relief));
  for (const id of ['turn-left', 'turn-right']) if ($(id)) $(id).disabled = !state.relief;
  // Flat and in relief are different drawings of different shapes, so
  // switching frames it afresh rather than keeping a view of the other one.
  if (mapView()) drawAtlas({ fit: true });
}

try {
  setRelief(localStorage.getItem(RELIEF_KEY) !== 'flat', { keep: false });
} catch {
  setRelief(true, { keep: false });
}

/**
 * Turn and tilt the map, keeping one point of it still: `anchor` on the
 * screen — between the fingers doing it — or the middle when there is none.
 */
function orbitTo(turn, tilt, anchor = null) {
  if (!state.relief || !mapView() || !state.projection || !state.viewBox) return;
  const box = svg.getBoundingClientRect();
  const vb = state.viewBox;
  const fx = anchor && box.width ? (anchor[0] - box.left) / box.width : 0.5;
  const fy = anchor && box.height ? (anchor[1] - box.top) / box.height : 0.5;
  const ground = state.projection.ground(vb.x + fx * vb.width, vb.y + fy * vb.height);
  state.turn = turn % (Math.PI * 2);
  state.tilt = clampTilt(tilt);
  // The box measured here, before the map is drawn again, is handed on: it
  // is the same size afterwards, and measuring it then made the page lay out
  // the whole new drawing there and then, in the middle of drawing it.
  paintMap({ keep: { ground, fx, fy }, box });
}

/**
 * Orbiting by hand, gathered up and drawn once a frame: a finger reports
 * movement far more often than the map can be redrawn.
 */
let orbiting = null;
function orbitBy(turn, tilt, anchor) {
  if (!orbiting) {
    orbiting = { turn: 0, tilt: 0, anchor: null };
    soon(() => {
      const { turn: t, tilt: l, anchor: a } = orbiting;
      orbiting = null;
      orbitTo(state.turn + t, state.tilt + l, a);
    });
  }
  orbiting.turn += turn;
  orbiting.tilt += tilt;
  orbiting.anchor = anchor ?? orbiting.anchor;
}

/**
 * The turn buttons: a twelfth of a turn at a time, enough to see behind a
 * tall room without losing the map, for anybody not orbiting it by hand.
 */
const TURN_STEP = Math.PI / 6;
const turnMap = (by) => orbitTo(state.turn + by, state.tilt);

$('relief').addEventListener('click', () => setRelief(!state.relief));
$('turn-left').addEventListener('click', () => turnMap(-TURN_STEP));
$('turn-right').addEventListener('click', () => turnMap(TURN_STEP));

/**
 * The minimap: everything that exists, and a frame round the part of it these
 * interests occupy.
 */
function drawMinimap({ recolour = false } = {}) {
  const wrap = $('minimap-wrap');
  const mine = [...heldInterests()];
  if (!state.overview) {
    wrap.hidden = true;
    return;
  }

  wrap.hidden = false;
  // Drawn again only when what it shows has changed: the overview, which
  // comes once, what is held, or the colours, which somebody has just chosen.
  // Every map and every change of state that arrived drew all thousand dots
  // of it again, the same each time.
  const drawnFor = mine.join('\n');
  if (recolour || state.minimapOf !== state.overview || state.minimapFor !== drawnFor) {
    renderMinimap($('minimap'), state.overview, { mine });
    state.minimapOf = state.overview;
    state.minimapFor = drawnFor;
  }
  const total = state.overview.subjects.length;
  $('minimap-note').textContent = mine.length
    ? `${total.toLocaleString()} interests · yours marked`
    : `${total.toLocaleString()} interests · join one to see where you are`;
}

/**
 * Pan and zoom the atlas.
 *
 * The map is bigger than a screenful the moment it is worth looking at, and a
 * fixed frame makes the shortened labels permanent — which was only ever a
 * concession to there not being room.
 */
function applyView(box = svg.getBoundingClientRect()) {
  if (!state.viewBox) return;
  const { x, y, width, height } = state.viewBox;
  svg.setAttribute('viewBox', `${x} ${y} ${width} ${height}`);

  const scale = (box.width || 600) / width;
  relabel(state.written, scale);
  // Rooms wholly off the view are not painted; see `cullRelief`. Only where
  // the map has really been measured: without a size, the view is a guess,
  // and a guess is no reason to hide anything.
  if (box.width) cullRelief(state.cull, state.viewBox);
  // Both readouts, because the map can be in either place and only one of
  // them is on screen at a time.
  const said = scale > 0 ? `Zoom ${Math.round(scale * 100)}%` : '';
  $('zoom-note').textContent = said;
  $('map-zoom').textContent = said;
}

// --- the map, larger --------------------------------------------------------

/**
 * Pop the map out, and put it back.
 *
 * Stacked above the interests the panel is short, and the fit scale is what
 * decides whether a territory is labelled `prehistoric archaeology` or `pa` —
 * so at that size the overlaps go back to initials. This is the way to see it
 * properly without giving the picture a permanent claim on half the screen.
 *
 * The drawing is moved rather than copied. A second SVG would be a second
 * thing to keep in step with the first, and the two would eventually disagree
 * about which room is lit.
 */
const mapModal = $('map-modal');
let mapAnchor = null;

/**
 * After the next frame, when the browser has laid the new size out.
 *
 * Falls back to a timer where there is no animation frame to wait for, which
 * is anywhere that is not a browser — the drawing is measured against a real
 * element, so the code that asks for it has to run somewhere it can be.
 */
function soon(fn) {
  return (globalThis.requestAnimationFrame ?? ((later) => setTimeout(later, 16)))(fn);
}

/**
 * Refit: the drawing is framed to the element, and the element just resized.
 *
 * A declaration rather than a `const`, because `showView` is written above
 * this and calls it — which with a `const` would be a dead zone waiting for
 * somebody to open the map first.
 */
function refit() {
  soon(reshapeMap);
}

// The map's panel changes size without anything here being told — the window
// resized, the column beside it dragged — and a view the wrong shape for its
// box is a stretched map. So it is watched, and reshaped when it changes:
// the same view, not a new drawing.
if (typeof ResizeObserver === 'function') new ResizeObserver(() => refit()).observe(svg);

function openMap() {
  if (svg.closest('.map-stage')) return;
  // Expand can be reached by keyboard with a pop-out still open, and that
  // would be left hanging behind the dialog.
  closePopouts();
  // Where to put it back. The panel keeps its other children, so this stays
  // valid for as long as the map is out.
  mapAnchor = svg.nextSibling;
  $('map-stage').append(svg);
  if (typeof mapModal.showModal === 'function') mapModal.showModal();
  else mapModal.open = true;
  // Framed afresh for the bigger box: asking to see it large is asking to see
  // it, not the corner of it that fitted the panel.
  soon(() => drawAtlas({ fit: true }));
}

function homeAgain() {
  if (!svg.closest('.map-stage')) return;
  document.querySelector('.map').insertBefore(svg, mapAnchor);
  soon(() => drawAtlas({ fit: true }));
}

function closeMap() {
  homeAgain();
  if (typeof mapModal.close === 'function') mapModal.close();
  else mapModal.open = false;
}

$('map-expand').addEventListener('click', openMap);

// --- the pop-outs on the map ------------------------------------------------

/**
 * The list of conversations, the view settings and the group, each behind a
 * button.
 *
 * One open at a time. A press anywhere else closes it, and so does Escape,
 * which puts focus back on the button that opened it. The help card counts as
 * inside: it is opened from within a pop-out, and reading it should not shut
 * the thing it is explaining. Queried each time rather than held, so this is
 * safe to call from anything that runs before this part of the file has.
 */
function popoutButtons() {
  return [...document.querySelectorAll('.pop-toggle')];
}

function setPopout(button, open) {
  button.setAttribute('aria-expanded', String(open));
  $(button.getAttribute('aria-controls')).hidden = !open;
}

function closePopouts(except) {
  for (const button of popoutButtons()) {
    if (button !== except && button.getAttribute('aria-expanded') === 'true') setPopout(button, false);
  }
}

for (const button of popoutButtons()) {
  button.addEventListener('click', () => {
    const open = button.getAttribute('aria-expanded') !== 'true';
    closePopouts(button);
    setPopout(button, open);
  });
}

document.addEventListener('pointerdown', (evt) => {
  if (!evt.target.closest?.('.popout, .pop-toggle, .card')) closePopouts();
});

document.addEventListener('keydown', (evt) => {
  if (evt.key !== 'Escape') return;
  const open = popoutButtons().find((b) => b.getAttribute('aria-expanded') === 'true');
  if (!open) return;
  setPopout(open, false);
  open.focus();
});
$('map-close').addEventListener('click', closeMap);

// A native dialog closes itself on Escape without asking, and the map would
// be left sitting in a box nobody can see. This is the one way out that does
// not go through `closeMap`.
mapModal.addEventListener('close', homeAgain);

// Clicking the darkened part outside the map closes it, which is what a
// dialog this size looks like it should do.
mapModal.addEventListener('click', (evt) => {
  if (evt.target === mapModal) closeMap();
});

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

/**
 * Moved with one finger, orbited with two, pinched, wheeled and tapped: see
 * `public/gestures.js`, which has the wheel too. A tap is a choice of room. On a phone that choice also leaves the map for the
 * conversation, so a finger's tap waits a moment to be sure it is not the
 * first of a double tap, which zooms instead; a mouse's click does not wait,
 * since the conversation opens beside the map rather than instead of it.
 */
const mapGestures = gestures(svg, {
  canOrbit: () => Boolean(state.relief && state.projection && state.viewBox),
  pan: (dx, dy) => {
    if (!state.viewBox) return;
    const box = svg.getBoundingClientRect();
    const vb = state.viewBox;
    state.viewBox = {
      ...vb,
      x: vb.x - (dx / (box.width || 1)) * vb.width,
      y: vb.y - (dy / (box.height || 1)) * vb.height,
    };
    applyView();
  },
  zoom: (factor, x, y) => zoomAt(x, y, factor),
  orbit: orbitBy,
  waitForDouble: (tap) => tap.pointerType !== 'mouse',
  tap: (tap) => chooseAt(tap),
  menu: (at) => mapMenu(at),
});

$('refit').addEventListener('click', () => drawAtlas({ fit: true }));

// --- branching out ------------------------------------------------------------

/**
 * Branch the map out from one interest into a community: the interest, and
 * the interests the same people hold with it, drawn in place of their own
 * map until they go back. `toward` is a community next to the interest's own,
 * by any interest in it, and then what is drawn beside the interest is the
 * part of that community nearest it. Nothing is joined: the chats in it open
 * as any chat they are not in does. See `World.branchFor`.
 */
function branchOut(from, toward = null) {
  card.hide();
  state.branch = { from, toward: toward ?? null, view: null };
  says('Branching out…');
  renderBranchBar();
  askBranch({ whole: true });
  showView('map');
}

/** Ask for the branch again: how its rooms are now, or the whole of it. */
function askBranch({ whole = false } = {}) {
  const branch = state.branch;
  if (!branch) return;
  send({
    type: 'branch',
    from: branch.from,
    toward: branch.toward,
    subjects: state.atlasSize,
    ...(whole || !branch.view ? {} : { have: branch.view.shape }),
  });
}

/** Back to their own map, framed on what they hold again. */
function leaveBranch() {
  if (!state.branch) return;
  state.branch = null;
  renderBranchBar();
  renderRooms();
  if (state.atlas) redrawMap(drawnAs(state.atlas));
  else says('Drawing the map…');
}

$('branch-back').addEventListener('click', leaveBranch);

/** "a, b and c". */
const inWords = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** What the map is showing instead of their own, and how big it is. */
function renderBranchBar() {
  const branch = state.branch;
  $('branch-bar').hidden = !branch;
  if (!branch) return;
  const from = subjectLabel(branch.from);
  const community = branch.view?.branch?.community;
  $('branch-what').textContent = !community
    ? `Branching out from ${from}…`
    : `From ${from} ${branch.toward ? 'toward' : 'into'} ${inWords(community.name)}`;
  // How much of it is theirs already, since that is what joining it would
  // change; the whole community, not only the few interests the map drew.
  const members = community?.members ?? [];
  const held = heldInterests();
  const mine = members.filter((s) => held.has(s)).length;
  $('branch-size').textContent = community
    ? `· ${community.size} interests${mine ? `, ${mine} yours` : ''}`
    : '';
  const joinable = members.length - mine;
  $('branch-join-all').hidden = !joinable;
  $('branch-join-some').hidden = joinable < 2;
  $('branch-join-all').querySelector('.label').textContent = `Join all ${joinable}`;
}

/**
 * The community an interest is in, and the ones nearest it, as far as this
 * page knows: from a map it is drawn on, or from All interests, which has
 * every interest's. Null where it is in none, or nothing here says.
 */
function communityOf(subject) {
  const drawn = state.branch?.view?.communities?.[subject] ?? state.atlas?.communities?.[subject];
  if (drawn) return drawn;
  const chart = state.chart;
  const i = chart?.subjects?.find((s) => s.id === subject)?.c;
  const found = i === undefined ? null : chart.communities?.[i];
  if (!found) return null;
  const brief = (c) => ({ lead: c.name[0], name: c.name, size: c.size });
  return { ...brief(found), near: (found.near ?? []).map((j) => chart.communities[j]).filter(Boolean).map(brief) };
}

// --- the menus ------------------------------------------------------------------

/**
 * What the right button, a long press or the menu key offers, as sections;
 * see `public/menu.js`. A room's, the map's, and an interest's in All
 * interests. Anything offered later is one more section in one of these.
 */
const menu = contextMenu();

/** Where each is its own community's, then the ones next to those: the ways to branch out from some interests. */
function branchItems(subjects) {
  const open = subjects.filter((s) => clusterOf(s) === null && !isGroupRoom(s));
  const items = [];
  const offered = new Set();
  for (const s of open) {
    const c = communityOf(s);
    if (!c || offered.has(c.lead)) continue;
    offered.add(c.lead);
    items.push({
      icon: 'branch',
      label: `Branch out from ${s}`,
      detail: `Into ${inWords(c.name)} · ${c.size} interests`,
      run: () => branchOut(s),
    });
  }
  for (const s of open) {
    for (const near of communityOf(s)?.near ?? []) {
      if (offered.has(near.lead) || items.length >= 5) continue;
      offered.add(near.lead);
      items.push({
        icon: 'branch',
        label: `Toward ${inWords(near.name)}`,
        detail: `${near.size} interests, next to ${s}’s`,
        run: () => branchOut(s, near.lead),
      });
    }
  }
  if (!items.length && open.length) {
    items.push({ label: 'Nothing to branch into yet', detail: 'Nobody holds this with anything else', disabled: true });
  }
  return items;
}

/** A chat's: open it, join what it needs, pin it, share it, branch out from it. */
function roomSections(room) {
  const items = [{ icon: 'chat', label: 'Open the chat', run: () => select(room.key) }];
  if (!room.member && !state.lurking) {
    const held = state.diagram?.subscription ?? [];
    for (const subject of inner(room.subjects).filter((s) => !held.includes(s)).slice(0, 2)) {
      items.push({ icon: 'enter', label: `Join ${subjectLabel(subject)}`, run: () => joinSubject(subject) });
    }
  }
  if (!state.lurking) {
    const pinned = state.pinned.has(room.key);
    items.push({ icon: 'pin', label: pinned ? 'Pinned to the top' : 'Pin to the top', checked: pinned, run: () => togglePin(room.key) });
  }
  if (!isPortalRoom(room.key)) {
    items.push({ icon: 'copy', label: 'Copy quick-join link', run: () => copyLink(watchLink(location.origin + location.pathname, room.key)) });
  }
  return [{ items }, { heading: 'Branch out', items: branchItems(room.subjects) }];
}

/** The map's own: back from a branch, the view, heights, everything else. */
function mapSections() {
  const items = [];
  if (state.branch) items.push({ icon: 'map', label: 'Back to my map', run: leaveBranch });
  items.push({ icon: 'reset', label: 'Reset view', run: () => drawAtlas({ fit: true }) });
  items.push({ icon: 'cube', label: 'Heights', checked: state.relief, run: () => setRelief(!state.relief) });
  items.push({ icon: 'compass', label: 'Explore interests', run: () => explorer.open() });
  return [{ heading: 'Map', items }];
}

/**
 * The menu for a chat, or for the map where there is none, at a point of the
 * window. From the map it has the map's own as well.
 */
function openMenu(x, y, key, returnTo, { map = false } = {}) {
  const room = key ? currentRooms().find((r) => r.key === key) : null;
  const sections = [...(room ? roomSections(room) : []), ...(map || !room ? mapSections() : [])];
  menu.open({ x, y, title: room ? spoken(room.subjects).join(' and ') : 'Map', sections, returnTo });
}

/** The map pressed for its menu: for whatever chat is there, or the map itself. */
function mapMenu(at) {
  card.hide();
  let x = at.clientX;
  let y = at.clientY;
  let key;
  if (at.pointerType === 'keyboard') {
    // The menu key says nowhere in particular: the middle of the map, for the
    // chat that is open if it is on it.
    const box = svg.getBoundingClientRect?.() ?? { left: 0, top: 0, width: 0, height: 0 };
    x = box.left + box.width / 2;
    y = box.top + box.height / 2;
    key = state.selected;
  } else {
    key = at.target?.closest?.('.group-name')?.dataset.room ?? hit(at);
  }
  openMenu(x, y, currentRooms().some((r) => r.key === key) ? key : null, svg, { map: true });
}

/** An interest in All interests: join it or open it, and branch out from it. */
function interestMenu(id, at) {
  const holds = heldInterests().has(id);
  const items = holds
    ? [{ icon: 'chat', label: 'Open its chat', run: () => openInterest(id) && explorer.close() }]
    : [{ icon: 'enter', label: `Join ${id}`, run: () => joinSubject(id) }];
  // Branching out is done on the map, so the sheet makes way for it.
  const branches = branchItems([id]).map((item) => (item.run ? { ...item, run: () => (explorer.close(), item.run()) } : item));
  menu.open({
    x: at.clientX,
    y: at.clientY,
    title: id,
    sections: [{ items }, { heading: 'Branch out', items: branches }],
    within: $('explorer'),
  });
}

// --- joining a community, all of it or some of it ---------------------------------

/**
 * Join several interests at once: a whole community, or whichever of it was
 * picked. One ask and one redraw rather than a dozen of each — except inside
 * a group, where each is the group's own copy of an interest and has to be
 * made as it is joined; see `joinSubject`.
 */
function joinMany(subjects) {
  const held = heldInterests();
  const wanted = [...new Set(subjects)].filter((s) => s && !held.has(s));
  if (!wanted.length) return;
  if (state.cluster) for (const subject of wanted) joinSubject(subject);
  else send({ type: 'join', subjects: wanted });
  notify(`Joined ${wanted.length === 1 ? wanted[0] : `${wanted.length} interests`}.`);
}

/**
 * Some of a community, not all of it: a switch for each interest, on for the
 * ones that would be joined. What is already held is on and cannot be
 * switched off here — leaving an interest is done where leaving is done.
 */
function openJoinSome(subjects, title) {
  const held = heldInterests();
  const all = [...new Set(subjects)];
  const chosen = new Set(all.filter((s) => !held.has(s)));
  state.joining = chosen;
  const list = $('join-some-list');
  list.textContent = '';

  const count = () => {
    $('join-some-count').textContent = chosen.size
      ? `Join ${chosen.size} ${chosen.size === 1 ? 'interest' : 'interests'}`
      : 'Nothing picked';
    $('join-some-go').disabled = chosen.size === 0;
  };

  for (const subject of all) {
    const mine = held.has(subject);
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'switch-row';
    button.setAttribute('role', 'switch');
    button.setAttribute('aria-checked', String(mine || chosen.has(subject)));
    button.setAttribute('aria-label', mine ? `${subject}, already yours` : subject);
    if (mine) button.disabled = true;
    const track = document.createElement('span');
    track.className = 'switch-track';
    track.append(document.createElement('span'));
    const name = document.createElement('span');
    name.className = 'switch-name';
    name.textContent = subject;
    button.append(track, name);
    if (mine) {
      const note = document.createElement('span');
      note.className = 'switch-note';
      note.textContent = 'already yours';
      button.append(note);
    } else {
      button.addEventListener('click', () => {
        if (chosen.has(subject)) chosen.delete(subject);
        else chosen.add(subject);
        button.setAttribute('aria-checked', String(chosen.has(subject)));
        count();
      });
    }
    li.append(button);
    list.append(li);
  }

  $('join-some-title').textContent = `Join some of ${title}`;
  const spare = all.length - chosen.size;
  $('join-some-say').textContent = `${all.length} interests in this community${spare ? `, ${spare} already yours` : ''}. Switch off any you do not want.`;
  count();
  closePopouts();
  if (typeof $('join-some').showModal === 'function') $('join-some').showModal();
  else $('join-some').open = true;
}

const closeJoinSome = () => {
  const sheet = $('join-some');
  if (typeof sheet.close === 'function') sheet.close();
  else sheet.open = false;
};

$('join-some-close').addEventListener('click', closeJoinSome);
$('join-some-go').addEventListener('click', () => {
  joinMany([...(state.joining ?? [])]);
  closeJoinSome();
});

/** The community the map is branched into: everything in it, not only what is drawn. */
const branchedCommunity = () => state.branch?.view?.branch?.community ?? null;

$('branch-join-all').addEventListener('click', () => {
  const community = branchedCommunity();
  if (community) joinMany(community.members ?? []);
});

$('branch-join-some').addEventListener('click', () => {
  const community = branchedCommunity();
  if (community) openJoinSome(community.members ?? [], inWords(community.name));
});

/** A link on the clipboard, or said where it can be copied from by hand. */
async function copyLink(link) {
  try {
    await navigator.clipboard.writeText(link);
    notify('Link copied.');
  } catch {
    notify(link);
  }
}

// From a chat on a phone, back to the list of them: the map, with the list
// open on it and the first chat in it ready to be chosen.
$('room-list').addEventListener('click', () => {
  showView('map');
  closePopouts($('rooms-open'));
  setPopout($('rooms-open'), true);
  soon(() => $('rooms').querySelector('button')?.focus());
});


$('subject-count').addEventListener('input', (evt) => {
  state.atlasSize = Number(evt.target.value);
  $('subject-count-out').textContent = String(state.atlasSize);
});
$('subject-count').addEventListener('change', () => {
  state.atlas = null;
  says('Redrawing…');
  send({ type: 'atlas', subjects: state.atlasSize });
});

function pointFrom(evt) {
  const ctm = svg.getScreenCTM?.();
  if (!ctm) return null;
  return new DOMPoint(evt.clientX, evt.clientY).matrixTransform(ctm.inverse());
}

/**
 * Which room is under the pointer.
 *
 * What is drawn there first. In relief a room's top is not over its own
 * ground, so the ground cannot be read off the flat position of the pointer;
 * every raised top and wall says which room it is instead. Asked of the page
 * by position rather than taken from the event, because a dragged pointer is
 * captured and everything it reports names the map as a whole.
 *
 * Then the ground, read the old way, for anywhere nothing claims — the
 * floor, a seam — turned back from the tilted view first when there is one.
 */
function hit(evt) {
  const under = document.elementFromPoint?.(evt.clientX, evt.clientY) ?? evt.target;
  const drawn = under?.closest?.('[data-zone]')?.getAttribute('data-zone');
  if (drawn) return drawn;
  const pt = pointFrom(evt);
  if (!pt) return null;
  const [x, y] = state.projection ? state.projection.ground(pt.x, pt.y) : [pt.x, pt.y];
  return zoneAt(mapView()?.curves ?? [], x, y);
}

const repaint = () => paintAtlas(state.territories, state.selected, state.grounds);

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

// A click that ends a press has been had already, as a tap or as a drag, which
// is not a choice of room at all. Any other — the keyboard's — is a choice.
svg.addEventListener('click', (evt) => {
  if (mapGestures.claims()) return;
  chooseAt(evt);
});

/**
 * Open the room at a point of the map: a click, or a tap, which carries what
 * was under it when it was pressed, since a captured pointer's release is
 * reported on the map as a whole.
 */
function chooseAt(evt) {
  // The group's name, on its outline, opens the group's own conversation.
  // Everybody in the group holds that, so usually nobody holds it alone and
  // it has no ground of its own for a click to land on.
  const tab = evt.target?.closest?.('.group-name')?.dataset.room ?? null;
  if (tab && currentRooms().some((r) => r.key === tab)) {
    select(tab);
    return;
  }
  const at = hit(evt);
  if (!at) {
    notify('No chat there.');
    return;
  }
  if (!currentRooms().some((r) => r.key === at)) {
    // Rounding the outlines leaves hairline seams where two territories graze
    // without really meeting. A point caught in one names a combination
    // nobody holds, so it opens nothing rather than opening an empty room.
    notify('No chat there.');
    return;
  }
  select(at);
}

// --- room -----------------------------------------------------------------

/**
 * The way into a room somebody has opened but is not in.
 *
 * Clicking a patch of the map is a fair way to ask what is in it, and until
 * now the answer was a disabled box and a sentence saying you could not read
 * this — with the remedy in small grey text below the fold of a blank panel.
 * The offer belongs where the conversation would have been.
 *
 * It names what is missing rather than the whole room, because somebody who
 * already holds `art` and clicked `art and music` needs one subject, not two,
 * and being told to join what they already have reads as the product not
 * knowing who they are.
 */
function joinPrompt(room) {
  const held = state.diagram?.subscription ?? [];
  // Never the group's own conversation as a thing to join on its way to
  // something else: joining anything in the group joins that too.
  const missing = inner(room.subjects).filter((s) => !held.includes(s));
  const have = spoken(room.subjects.filter((s) => held.includes(s)));

  const li = document.createElement('li');
  li.className = 'joining';

  const lead = document.createElement('p');
  lead.className = 'joining-lead';
  lead.textContent = 'You are not in this chat yet.';

  const why = document.createElement('p');
  why.className = 'joining-why';
  why.textContent = have.length
    ? `You hold ${have.join(' and ')}. This one also needs ${missing.map(subjectLabel).join(' and ')}.`
    : `It is for people interested in ${spoken(room.subjects).join(' and ')}.`;

  const actions = document.createElement('p');
  actions.className = 'joining-actions';
  for (const subject of missing) {
    const join = document.createElement('button');
    join.type = 'button';
    join.className = 'join-here';
    join.append(icon('enter'), document.createTextNode(`Join ${subjectLabel(subject)}`));
    join.addEventListener('click', () => joinSubject(subject));
    actions.append(join);
  }

  const note = document.createElement('p');
  note.className = 'joining-note';
  // What joining actually does, said before it is done rather than after.
  note.textContent =
    missing.length > 1
      ? 'You need all of them to take part. They are added to your interests, and you can leave any time.'
      : 'It is added to your interests. You can leave any time.';

  li.append(lead, why, actions, note);
  return li;
}

// A lurker's one conversation is not on any map it has, since it has none.
const selectedRoom = () =>
  state.lurking ? state.lurking.room : (currentRooms().find((r) => r.key === state.selected) ?? null);

function renderRoom() {
  const room = selectedRoom();

  // Between a membership change and the atlas that follows it there is a
  // moment with no rooms in hand at all. The conversation is still open, so
  // leave it standing rather than blanking the panel and putting it back a
  // few hundred milliseconds later.
  if (!room && state.selected && !state.atlas) return;

  const log = $('log');
  const body = $('body');
  log.textContent = '';

  // The quick-join code, for any open conversation but a portal, and not for
  // a lurker, who is only watching.
  const sharing = Boolean(room) && !state.lurking && !isPortalRoom(room.key);
  $('room-share').hidden = !sharing;
  // What to do with a message about to be written — encrypt it, or poke the
  // server for something to say — only where there is a message to write:
  // for somebody in the chat, not somebody looking in from outside it, and
  // not a lurker.
  const writing = Boolean(room?.member) && !state.lurking;
  document.querySelector('.choices').hidden = !writing;
  $('poke').hidden = !writing;
  paintPin(room);
  // What joining in would do, where the button to do it is: which interests it
  // adds, and how many are in it and talking.
  if (state.lurking && room) {
    const people = room.population ?? 0;
    const rate = room.stats?.perMinute ?? 0;
    $('lurk-adds').textContent =
      `Join in adds ${spoken(room.subjects).join(' and ')} to your interests. ` +
      `${people} ${people === 1 ? 'person is' : 'people are'} in it` +
      `${rate ? `, saying about ${rate} a minute lately` : ''}.`;
  }
  paintPoke();
  if (!sharing && $('room-share').getAttribute('aria-expanded') === 'true') setPopout($('room-share'), false);

  if (!room) {
    $('room-title').textContent = 'Pick a chat';
    $('room-meta').textContent =
'Open one on the map, or from Chats.';
    body.disabled = true;
    $('send').disabled = true;
    body.placeholder = 'Pick a chat first';
    sayWhoCanRead(null);
    return;
  }

  sayWhoCanRead(room);
  $('room-title').textContent = isPortalRoom(room.key)
    ? 'A portal'
    : spoken(room.subjects).join(' and ');

  // The title is the room as it would be named outside, so which group it is
  // in is said once, here, rather than written into every name.
  const group = clusterOf(room.subjects[0] ?? '');
  const people = `${room.population} ${room.population === 1 ? 'person' : 'people'}${group ? ` in ${group}` : ''}`;
  const stats = room.stats;
  const activity = stats?.last ? ` · ${busyness(stats)}, last ${when(stats.last.at)}` : '';
  const held = state.diagram?.subscription ?? [];
  const needed = inner(room.subjects).filter((s) => !held.includes(s)).map(subjectLabel).join(' and ');
  // Lurkers, as a number and never as who; for a lurker, counting itself.
  const watching = lurkersIn(room);
  const audience = watching ? ` · ${watching} lurking` : '';
  $('room-meta').textContent = state.lurking
    ? `${people}${activity} · ${watching > 1 ? `you and ${watching - 1} more are lurking` : 'you are lurking'}`
    : room.member
      ? `${people}${audience} · you are here${activity}`
      : `${people}${audience} · join ${needed} to take part${activity}`;

  body.disabled = !room.member;
  $('send').disabled = !room.member;
  body.placeholder = room.member
    ? `Say something to ${room.population === 1 ? 'the 1 person' : `the ${room.population} people`} here`
    : `Join ${needed} to take part`;
  // The way in is offered in the log, where the room itself would be — see
  // `joinPrompt`. Repeating the buttons under the composer as well would be
  // two of the same offer on one screen.
  $('composer-help').textContent = '';

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
    stop.textContent = 'Cancel reply';
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

  // Somewhere you have walked into rather than somewhere you are. The offer
  // goes at the top of the room, which is the part of the screen being looked
  // at — it used to be a line of small grey text below the composer, under a
  // large empty space that said only that you could not read this yet.
  // A lurker has its own way in, in place of the box you type in; see
  // `stopLurking`.
  if (!room.member && !state.lurking) log.append(joinPrompt(room));

  const messages = state.history[room.key] ?? [];
  if (!messages.length) {
    // Nobody has said anything, which is where people stall: the server is
    // asked, once per chat, for a question to start it with, and it appears
    // above the box, as when poked by hand.
    // Not for somebody who has muted what the server writes: asking it for
    // something to say, unasked, is exactly what they turned off. Poke the
    // server is still there for anybody who wants one.
    if (room.member && !state.lurking && !state.hushSystem && !state.autoPoked.has(room.key)) {
      state.autoPoked.add(room.key);
      send({ type: 'poke', room: room.key });
    }
    if (room.member || state.lurking) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = state.lurking
        ? 'Nothing has been said here yet. Join in to say the first thing.'
        : 'No messages yet. You could be the first.';
      log.append(empty);
    }
    return;
  }

  // Watching is not taking part: a lurker reads, and agreeing, replying,
  // reporting and muting are all things somebody who is here does. Joining in
  // is one press away, and it is the press that says they are here.
  const acting = !state.lurking;

  // Messages from somebody muted are gathered while they come one after
  // another, and written as a single folded line when the run ends, so a
  // muted person talking a lot costs one line of the screen and not twenty.
  let folded = [];
  const fold = () => {
    if (folded.length) log.append(mutedRun(folded));
    folded = [];
  };

  for (const m of messages) {
    if ((isMuted(m) || (state.hushSystem && m.machine)) && !state.revealed.has(m.id)) {
      folded.push(m);
      continue;
    }
    fold();

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
      // A reply to somebody muted would otherwise quote them back in full,
      // which is the one way round the mute that nobody chose.
      const parent = messages.find((p) => p.id === m.replyTo.id);
      if (parent && isMuted(parent) && !state.revealed.has(parent.id)) {
        quoted.textContent = 'A reply to someone you muted';
      } else {
        const who = document.createElement('strong');
        who.textContent = `${m.replyTo.author}: `;
        quoted.append(who, document.createTextNode(
          m.replyTo.sealed ? '(encrypted message)' : m.replyTo.excerpt,
        ));
      }
    }

    head.append(who, at);
    if (m.sealed) {
      const mark = document.createElement('span');
      mark.className = 'sealed-mark';
      mark.textContent = 'encrypted';
      head.append(mark);
    }
    // A system message: written by the server, not by a person — a question to
    // start a quiet room, or a line a sample world was made with. Said right
    // beside the name, in words, before anything else about the message; the
    // name is one of the sample people and would otherwise read as somebody
    // talking. The server sets this and it is in the message's hash; nothing
    // typed can set it.
    if (m.machine) {
      li.classList.add('machine');
      const made = document.createElement('span');
      made.className = 'machine-mark';
      made.textContent = 'system message';
      made.title = 'Written by the server, not by a person. The name is one of the sample people this place was filled with.';
      head.append(made);
    }
    // Shown because somebody asked to see it, and said so, so a message from
    // a muted person is never mistaken for one from somebody who is not.
    if (isMuted(m)) {
      const mark = document.createElement('span');
      mark.className = 'muted-mark';
      mark.textContent = 'muted';
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

    // Everything but replying, in a tray behind ⋯: agree and disagree, mute,
    // report, delete, the ones that cannot be undone last. On a screen with a
    // pointer the tray shows with the pointer over the message, as the actions
    // always did; on a phone, where every message used to carry five words of
    // them on two lines, it opens from ⋯. See `.msg-actions`.
    const tray = document.createElement('span');
    tray.className = 'msg-actions';
    tray.id = `acts-${String(m.id).replace(/[^\w-]/g, '_')}`;
    if (acting) tray.append(voting);

    // Your own words are yours to take back, and doing so is recorded like
    // any other deletion rather than quietly.
    if (acting && m.authorId === state.me?.id) {
      const remove = document.createElement('button');
      remove.type = 'button';
      // Its own class, not the report one. They sit in the same place and look
      // alike, but "take back what I said" and "tell a moderator about what
      // somebody else said" are different acts and should not be one selector.
      remove.className = 'msg-action forget';
      remove.textContent = 'delete';
      remove.title = 'Delete this message';
      remove.addEventListener('click', () => {
        // Held until the receipt comes back, so the receipt can be checked
        // against the message it says it names.
        state.deleting.set(m.id, JSON.parse(JSON.stringify(m)));
        send({ type: 'forget', messageId: m.id });
      });
      tray.append(remove);
    }

    if (acting && m.authorId !== state.me?.id) {
      const flag = document.createElement('button');
      flag.type = 'button';
      flag.className = 'msg-action report';
      flag.textContent = state.reported.has(m.id) ? 'reported' : 'report';
      flag.disabled = state.reported.has(m.id);
      flag.title = flag.disabled
        ? 'You have reported this'
        : 'Tell a moderator about this message';
      flag.setAttribute('aria-label', `Report the message from ${m.author}`);
      // The reasons open under the message's words, not inside the row of
      // its name, which they used to split in two.
      flag.addEventListener('click', () => askWhy(m, text));

      // Beside report, and not the same thing. Reporting asks a moderator to
      // look; muting is a choice about your own screen, and nobody is told.
      const person = personOf(m);
      if (person) {
        const already = isMuted(m);
        const hush = document.createElement('button');
        hush.type = 'button';
        hush.className = 'msg-action mute';
        hush.textContent = already ? 'unmute' : 'mute';
        hush.title = already
          ? 'Show what this person says again'
          : 'Stop seeing what this person says. Only you will know';
        hush.setAttribute('aria-label', `${already ? 'Unmute' : 'Mute'} ${m.author}`);
        hush.addEventListener('click', () => (already ? unmute(person) : mute(m)));
        tray.append(hush);
      }
      // Muting before reporting, and reporting just before deleting: the
      // lighter thing first.
      tray.append(flag);
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

    if (acting) {
      // How it has been received, quietly in the heading, so the counts are
      // there to read without opening anything.
      if (tally.up || tally.down) {
        const said = document.createElement('span');
        said.className = 'vote-tally';
        said.textContent = [tally.up && `${tally.up} agree`, tally.down && `${tally.down} disagree`]
          .filter(Boolean)
          .join(' · ');
        head.append(said);
      }
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'msg-more';
      more.textContent = '⋯';
      more.setAttribute('aria-expanded', 'false');
      more.setAttribute('aria-controls', tray.id);
      more.setAttribute('aria-label', `More for the message from ${m.author}`);
      more.addEventListener('click', () => {
        const open = more.getAttribute('aria-expanded') !== 'true';
        more.setAttribute('aria-expanded', String(open));
        tray.classList.toggle('open', open);
      });
      head.append(reply, more, tray);
    }

    li.append(head);
    if (quoted) li.append(quoted);
    li.append(text);
    log.append(li);

    const offer = acting ? muteOffer(m) : null;
    if (offer) log.append(offer);
  }
  fold();
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
  notify('Encrypting…');

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
          ? 'Could not encrypt this message, so it was not sent. It is still in the box.'
          : 'Nobody here can receive an encrypted message yet, so it was not sent. It is still in the box.',
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
 * Small groups, for the people around you, from the header.
 *
 * Joining a cluster changes what a new join means: `art` becomes
 * `kite-fox-9/art`, which is a different subject, so the people in it are
 * exactly the people who used the same name.
 *
 * That alone left somebody who had just scanned a code in a group with
 * nothing in it, and the people at the table had to agree on an interest
 * before anyone could say a word. So every group has a conversation of its
 * own — `everyone`, inside it — which creating the group or arriving by its
 * code joins, and which a new arrival is taken straight into. Scan, and you
 * are talking.
 *
 * That conversation is also what wraps the group: holding anything inside it
 * means holding it too (the server sees to that), so on the map it is the
 * outline round the group's rooms, and leaving it is leaving the group.
 */
const GROUP_KEY = 'eulerchat.group';

const findGroupRoom = (group) =>
  currentRooms().find((r) => r.subjects.length === 1 && r.subjects[0] === groupRoom(group)) ?? null;

/**
 * Join the conversation of a group just arrived in, as whoever this
 * connection is. Once per person: a rename re-sends the welcome and must not
 * put back somebody who has since left, but a returning visitor's key turns
 * the connection into somebody else, and that somebody has to join too.
 */
function joinArrivingGroup() {
  const arriving = state.groupArriving;
  if (!arriving || !state.me || arriving.joinedAs === state.me.id) return;
  if (ws?.readyState !== WebSocket.OPEN) return;
  arriving.joinedAs = state.me.id;
  send({ type: 'createSubject', name: groupRoom(arriving.group) });
}

function renderCluster() {
  const group = state.cluster;
  const button = $('group-open');
  button.classList.toggle('in', Boolean(group));
  $('group-label').textContent = group ?? 'Group';
  // The visible words are the group's name; this says what the name is of.
  button.setAttribute('aria-label', group ? `Group ${group}` : 'Group');

  $('cluster-start').hidden = Boolean(group);
  $('cluster-share').hidden = !group;
  if (!group) return;

  $('cluster-now').textContent = group;
  const link = inviteLink(location.origin + location.pathname, group);
  const anchor = $('cluster-url');
  anchor.href = link;
  anchor.textContent = link;
  drawInvite(link);
  renderGroupCount();
}

/**
 * How many people are in the group's conversation, so whoever is holding up
 * the code can see it working as people scan it.
 */
function renderGroupCount() {
  const out = $('cluster-count');
  const room = state.cluster ? findGroupRoom(state.cluster) : null;
  const count = room?.population ?? 0;
  out.textContent = !room
    ? ''
    : count <= 1
      ? 'Just you so far. Show them the code.'
      : `${count} people in it`;
}

/** Once the group's conversation is on the map, open it for whoever just arrived. */
function openArrivedGroup() {
  const arriving = state.groupArriving;
  if (!arriving?.seen || arriving.opened) return;
  // Once, whether or not it could be found: a room that turns up later must
  // not pull somebody out of whatever they have gone on to read.
  arriving.opened = true;
  const room = findGroupRoom(arriving.group);
  if (room && state.selected !== room.key) select(room.key);
}

/**
 * The group, kept in the address as well as in this browser. In the address
 * so a reload or a bookmark keeps you in it, and so the page's own link is an
 * invitation; in the browser so it survives opening the site fresh.
 */
function keepGroup() {
  try {
    if (state.cluster) localStorage.setItem(GROUP_KEY, state.cluster);
    else localStorage.removeItem(GROUP_KEY);
  } catch {
    /* a private window: the group lasts as long as the page */
  }
  try {
    const url = new URL(location.href);
    if (state.cluster) url.searchParams.set('cluster', state.cluster);
    else url.searchParams.delete('cluster');
    history.replaceState(history.state, '', url);
  } catch {
    /* not somewhere the address can be written back to */
  }
}

/**
 * The invitation as a square somebody can point a camera at.
 *
 * Drawn as elements rather than as a picture, because this place does not do
 * pictures - and because a grid of squares is exactly what the thing is.
 */
function drawInvite(link, holder = $('cluster-qr')) {
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

/**
 * Join a group, or leave for the open part again.
 *
 * Creating one, scanning its code or typing its name all arrive: the group's
 * own conversation is joined, and opened once it is on the map. Coming back to
 * a group this browser was already in joins it again but opens nothing. Being
 * in a group is holding its conversation — that is what wraps its rooms — so
 * a group remembered here and not held there would be a group in name only.
 * Leaving the conversation is leaving the group; see `subjectRow`.
 */
function enterCluster(name, { arriving = true } = {}) {
  const group = name && isCluster(name) ? name : null;
  state.cluster = group;
  keepGroup();
  state.groupArriving = group ? { group, joinedAs: null, seen: false, opened: !arriving } : null;
  if (group) state.leftGroup = null;
  joinArrivingGroup();
  $('cluster-error').textContent = '';
  renderCluster();
  if (arriving) notify(group ? `Joined group ${group}.` : 'Left the group.');
}

/**
 * Leave the group, and every conversation in it. Leaving used to change only
 * what the next join meant, and left you in all of its rooms regardless.
 */
function leaveGroup() {
  const group = state.cluster;
  if (!group) return;
  leaveRoomsOf(group);
  enterCluster(null);
  state.leftGroup = group;
}

function leaveRoomsOf(group) {
  for (const subject of state.diagram?.subscription ?? []) {
    if (clusterOf(subject) === group) send({ type: 'leave', subject });
  }
}

/**
 * What somebody typed, read generously. Names are said out loud and typed
 * from memory, so `Kite Fox 9` is `kite-fox-9`, and a whole pasted link is
 * the group it names.
 */
const groupFrom = (typed) =>
  clusterFromLink(typed) ?? String(typed ?? '').trim().toLowerCase().replace(/\s+/g, '-');

$('cluster-new').addEventListener('click', () => enterCluster(newCluster()));
$('cluster-leave').addEventListener('click', () => {
  leaveGroup();
  $('group-open').focus({ preventScroll: true });
});

$('cluster-join').addEventListener('submit', (evt) => {
  evt.preventDefault();
  const wanted = groupFrom($('cluster-name').value);
  if (!wanted) return;
  if (!isCluster(wanted)) {
    $('cluster-error').textContent = 'Not a group name. They look like kite-fox-9.';
    return;
  }
  $('cluster-name').value = '';
  enterCluster(wanted);
});

// The share sheet, where there is one: on a phone this is the quickest way to
// put the link into whatever the table is already talking in.
const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
$('cluster-send').hidden = !canShare;
$('cluster-send').addEventListener('click', () => {
  const url = $('cluster-url').href;
  navigator.share({ title: 'eulerchat', text: `Join my group ${state.cluster} on eulerchat`, url }).catch(() => {
    /* closed without sharing, which is an answer */
  });
});

$('cluster-copy').addEventListener('click', async () => {
  const button = $('cluster-copy');
  try {
    await navigator.clipboard.writeText($('cluster-url').href);
    button.querySelector('.label').textContent = 'Copied';
  } catch {
    // No clipboard to write to: select the link, so copying is one keystroke.
    globalThis.getSelection?.()?.selectAllChildren($('cluster-url'));
    button.querySelector('.label').textContent = 'Selected';
  }
  setTimeout(() => (button.querySelector('.label').textContent = 'Copy link'), 1800);
});

// A code scanned or a link followed arrives in its group. A group this browser
// was already in is come back to: its conversation held again, nothing opened.
function restoreGroup() {
  const linked = clusterFromLink(location.href);
  let kept = null;
  try {
    kept = localStorage.getItem(GROUP_KEY);
  } catch {
    /* as above */
  }
  if (linked && linked !== kept) enterCluster(linked);
  else if (linked || (kept && isCluster(kept))) enterCluster(linked ?? kept, { arriving: false });
  else renderCluster();
}

// --- quick join, and lurkers ------------------------------------------------

/**
 * Arriving by a quick-join code: a lurker, watching one conversation.
 *
 * The code opens that conversation and nothing else. The map, the interests,
 * the header's name and key and group are all out of sight, because a lurker
 * has none of them: nothing is joined, no key is made or shown, no earlier
 * visit or group is picked up, and nothing is written on the device. Two
 * buttons end it — joining in, or looking around — and each of those is
 * somebody deciding to be here. See `lib/lurk.js`.
 */
{
  const watched = watchedFrom(location.href);
  if (watched) {
    state.lurking = { key: watched, room: null, log: null };
    state.selected = watched;
    document.body.dataset.lurking = '';
    $('lurk-bar').hidden = false;
    $('room-title').textContent = 'Opening the chat…';
    $('room-meta').textContent = '';
    showView('talk');
    // Not the group this browser was in: a lurker is in none.
    renderCluster();
  } else {
    restoreGroup();
  }
}

/**
 * Stop being a lurker, by joining in or by looking around.
 *
 * Either way this is somebody now: the key and the name this browser keeps
 * are shown again, and its group comes back, exactly as on any other arrival.
 * Joining in joins what the conversation is about — inside its group, if it
 * is in one — and leaves it open.
 */
function stopLurking({ join = false } = {}) {
  const lurk = state.lurking;
  if (!lurk) return;
  state.lurking = null;
  delete document.body.dataset.lurking;
  $('lurk-bar').hidden = true;
  send({ type: 'unwatch' });

  // Out of the address too, so that a reload is not a lurker again.
  try {
    const url = new URL(location.href);
    url.searchParams.delete('watch');
    history.replaceState(history.state, '', url);
  } catch {
    /* not somewhere the address can be written back to */
  }

  void comeBack();
  restoreGroup();

  if (join && lurk.room) {
    const cluster = clusterOf(lurk.room.subjects[0] ?? '');
    if (cluster && cluster !== state.cluster) enterCluster(cluster, { arriving: false });
    for (const subject of inner(lurk.room.subjects)) send({ type: 'createSubject', name: subject });
  }

  // The rest of the place, which a lurker was never sent.
  state.atlas = null;
  send({ type: 'atlas', subjects: state.atlasSize });
  send({ type: 'browse', at: null });
  if (!state.overview) send({ type: 'overview' });

  state.selected = join ? lurk.key : null;
  showView(join ? 'talk' : 'map');
  // Pressed before the first state arrived, there is no list to draw yet; it
  // is drawn when that state comes.
  if (state.diagram) renderRail();
  renderRoom();
}

$('lurk-join').addEventListener('click', () => stopLurking({ join: true }));
$('lurk-leave').addEventListener('click', () => stopLurking());

/** The quick-join code for the conversation that is open, drawn as it is opened. */
// --- pins -----------------------------------------------------------------------

const PINNED_KEY = 'eulerchat.pinned';

try {
  state.pinned = new Set(JSON.parse(localStorage.getItem(PINNED_KEY) ?? '[]'));
} catch {
  /* nothing pinned, or nowhere to have kept it */
}

/** Pinned or not, said on the button as well as shown. */
function paintPin(room) {
  const pin = $('room-pin');
  // Not for a lurker, who leaves nothing on this device, pins included.
  pin.hidden = !room || Boolean(state.lurking);
  if (pin.hidden) return;
  const on = state.pinned.has(room.key);
  pin.setAttribute('aria-pressed', String(on));
  pin.querySelector('.label').textContent = on ? 'Pinned' : 'Pin';
  pin.setAttribute('aria-label', on ? 'Unpin this chat' : 'Pin this chat');
}

$('room-pin').addEventListener('click', () => {
  const room = selectedRoom();
  if (room) togglePin(room.key);
});

/** Pin a chat to the top of the list, or unpin it: from its button or a menu. */
function togglePin(key) {
  if (state.pinned.has(key)) state.pinned.delete(key);
  else state.pinned.add(key);
  try {
    localStorage.setItem(PINNED_KEY, JSON.stringify([...state.pinned]));
  } catch {
    /* pinned for as long as the page is open */
  }
  paintPin(selectedRoom());
  renderRooms();
}

// --- reports, for a moderator -----------------------------------------------------

function renderReports() {
  const list = $('reports-list');
  list.textContent = '';
  $('reports-none').hidden = state.concerns.length > 0;
  $('reports-count').textContent = state.concerns.length ? String(state.concerns.length) : '';
  for (const concern of state.concerns) {
    const li = document.createElement('li');
    li.className = 'report-row';
    const name = document.createElement('strong');
    name.textContent = spoken(concern.subjects ?? []).join(' and ') || concern.room;
    // Why, in words, most given first.
    const why = new Map();
    for (const report of concern.reports ?? []) {
      const says = REASONS[report.reason]?.says ?? report.reason;
      why.set(says, (why.get(says) ?? 0) + 1);
    }
    const reasons = document.createElement('p');
    reasons.className = 'report-why';
    reasons.textContent =
      [...why].sort((a, b) => b[1] - a[1]).map(([says, n]) => (n > 1 ? `${says} (${n})` : says)).join(' · ') ||
      'Flagged by the word list';
    const counts = document.createElement('p');
    counts.className = 'report-counts';
    const n = (concern.reports ?? []).length;
    counts.textContent =
      `${n} report${n === 1 ? '' : 's'}` +
      `${concern.flags ? ` · ${concern.flags} flagged` : ''}` +
      ` · ${concern.messages} message${concern.messages === 1 ? '' : 's'} · ${concern.population} ${concern.population === 1 ? 'person' : 'people'}`;
    const actions = document.createElement('div');
    actions.className = 'report-actions';
    const look = document.createElement('button');
    look.type = 'button';
    look.textContent = 'Look in';
    look.title = 'Open it to lurk in, in a new tab: counted as lurking, not as a member';
    look.addEventListener('click', () => window.open(watchLink(location.origin + location.pathname, concern.room), '_blank', 'noopener'));
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.textContent = 'Clear';
    clear.title = 'Judged fine: take it off the list until somebody reports it again';
    clear.addEventListener('click', () => send({ type: 'clear', room: concern.room }));
    actions.append(look, clear);
    li.append(name, reasons, counts, actions);
    list.append(li);
  }
}

const reports = $('reports');
$('reports-open').addEventListener('click', () => {
  closePopouts();
  if (typeof reports.showModal === 'function') reports.showModal();
  else reports.open = true;
  send({ type: 'concerns' });
});
$('reports-close').addEventListener('click', () => {
  if (typeof reports.close === 'function') reports.close();
  else reports.open = false;
});

$('room-share').addEventListener('click', () => {
  const room = selectedRoom();
  if (!room || $('room-share-pop').hidden) return;
  const link = watchLink(location.origin + location.pathname, room.key);
  $('room-share-name').textContent = spoken(room.subjects).join(' and ');
  const anchor = $('room-share-url');
  anchor.href = link;
  anchor.textContent = link;
  drawInvite(link, $('room-share-qr'));
});

$('room-share-send').hidden = typeof navigator === 'undefined' || typeof navigator.share !== 'function';
$('room-share-send').addEventListener('click', () => {
  navigator.share({ title: 'eulerchat', text: `Watch ${$('room-share-name').textContent} on eulerchat`, url: $('room-share-url').href }).catch(() => {
    /* closed without sharing, which is an answer */
  });
});

$('room-share-copy').addEventListener('click', async () => {
  const button = $('room-share-copy');
  try {
    await navigator.clipboard.writeText($('room-share-url').href);
    button.querySelector('.label').textContent = 'Copied';
  } catch {
    globalThis.getSelection?.()?.selectAllChildren($('room-share-url'));
    button.querySelector('.label').textContent = 'Selected';
  }
  setTimeout(() => (button.querySelector('.label').textContent = 'Copy link'), 1800);
});

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
  title.textContent = 'Why are you reporting this?';
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
      notify('Reported. A moderator will look. Nobody in the room is told.');
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
    // In the hash too: a kept machine question without it would not be
    // recognised, and a kept person's message with it would not either.
    machine: message.machine || undefined,
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
  // Never from a lurker: handing back what this browser kept would say whose
  // browser it is, which is the one thing a lurker is not telling anybody.
  if (offered || state.lurking || !state.kept.length) return;

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
    notify('This browser cannot encrypt messages.');
    return;
  }
  state.sealing = evt.target.checked;
  notify(
    state.sealing
      ? 'Encryption on. People here can still keep a copy.'
      : 'Encryption off.',
  );
});

$('recording').addEventListener('change', (evt) => {
  state.recording = evt.target.checked;
  send({ type: 'record', on: state.recording });
  notify(
    state.recording
      ? 'Keeping a copy in this browser. The server still deletes messages after 12 hours.'
      : 'Not keeping a copy.',
  );
});

// --- interests --------------------------------------------------------------

function subjectRow(subject, population, held) {
  const li = document.createElement('li');
  li.dataset.subject = subject;

  // The swatch is the control. A subject's colour comes from its name, which
  // is what keeps it the same on every visit — but names collide, and two
  // neighbouring blues on the map is the one thing the hash cannot be talked
  // out of. This is the way out of that, for the person looking at it.
  // Inside a group every row is the group's copy of an interest, and is
  // named as the interest is: `art`, not `kite-fox-9/art`.
  const called = subjectLabel(subject);
  const swatch = document.createElement('button');
  swatch.type = 'button';
  swatch.className = `swatch${isChosen(subject) ? ' picked' : ''}`;
  swatch.append(glyphSwatch(document, subject));
  swatch.setAttribute(
    'aria-label',
    `colour of ${called}${isChosen(subject) ? ', chosen by you' : ''}`,
  );
  swatch.setAttribute('aria-expanded', 'false');
  swatch.addEventListener('click', () => openColour(li, swatch, subject));

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = called;

  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = population === undefined || population === null ? '' : String(population);

  // The group's own conversation wraps everything in the group, so leaving it
  // is leaving the group, and the button says so rather than finding out.
  const wraps = held && isGroupRoom(subject);
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.textContent = wraps ? 'Leave group' : held ? 'Leave' : 'Join';
  // The list is a column of buttons all called `join`, which is what somebody
  // listening to it hears unless each one says what it joins.
  toggle.setAttribute(
    'aria-label',
    wraps ? `Leave group ${clusterOf(subject)}` : held ? `Leave ${called}` : `Join ${called}`,
  );
  toggle.addEventListener('click', () =>
    wraps ? leaveGroup() : held ? send({ type: 'leave', subject }) : joinSubject(subject),
  );

  li.append(swatch, name, count, toggle);
  return li;
}

/**
 * A subject you do not hold, and the reason it is being put in front of you.
 *
 * The reason is the whole of it. Every other list of interests is a list of
 * names — what you hold, what sits near it, what is busiest — and a name on
 * its own is a guess somebody else made about you. This one can say what it
 * knows: that there are three people in a room one subject away, and which
 * room, and that the room is already there rather than one that would be
 * conjured by joining.
 *
 * Rooms are named in words rather than by their keys, since `a+b` is how the
 * region algebra writes it and not how anybody says it.
 */
function discoveryRow(find, held) {
  const li = subjectRow(find.subject, find.population, held);
  li.classList.add('discovery');

  const why = document.createElement('p');
  why.className = 'why-this';

  const rooms = find.rooms ?? [];
  if (rooms.length) {
    const best = rooms[0];
    const people = `${best.population} ${best.population === 1 ? 'person' : 'people'}`;
    why.append(document.createTextNode(`${people} already in `));
    const room = document.createElement('strong');
    room.textContent = spoken(best.key.split('+')).join(' and ');
    why.append(room);
    // How many more, rather than a list of them nobody is going to read.
    const more = (find.opens ?? rooms.length) - 1;
    if (more > 0) {
      why.append(document.createTextNode(`, and ${more} more chat${more === 1 ? '' : 's'}`));
    }
  } else {
    // Somebody with nothing to bridge from. There is no overlap to point at,
    // so the honest thing to say is how many people are in it.
    why.textContent = `${find.population} ${find.population === 1 ? 'person' : 'people'} here`;
  }

  li.append(why);
  return li;
}

// --- muting ------------------------------------------------------------------

/**
 * People you have stopped seeing.
 *
 * Kept in this browser and nowhere else. The server is not told, so no list
 * of who muted whom exists anywhere to be asked for, and the person muted is
 * not told either: this is somebody choosing what to read, not a punishment
 * handed out. Their messages still arrive, and are folded away in the log;
 * they no longer badge a room or interrupt.
 *
 * A mute holds on to the key, not the name. Anybody can type any name, so
 * muting a name would mute whoever typed it next and let the person meant
 * walk back in under another. Somebody with no key has nothing to be known by
 * past this page, so they are muted until it closes.
 *
 * What it cannot do is follow somebody who throws their key away. A new key
 * is a stranger, here as everywhere else; that is the promise the key makes.
 */
const MUTED_KEY = 'eulerchat.muted';
const OFFER_KEY = 'eulerchat.offerMute';

/** Who wrote something, as a mute holds on to it: their key, or their id. */
function personOf({ authorKey, authorId } = {}) {
  if (authorKey) return `key:${authorKey}`;
  return authorId ? `id:${authorId}` : null;
}

const isMuted = (message) => state.muted.has(personOf(message));

/** A notification names its author the same way, under other field names. */
const mutedNote = (note) => state.muted.has(personOf({ authorKey: note?.fromKey, authorId: note?.fromId }));

function rememberMutes() {
  try {
    // Only keys. An id is this server's name for one visit, and by tomorrow
    // would be somebody else's.
    const kept = [...state.muted]
      .filter(([who]) => who.startsWith('key:'))
      .map(([who, { name, keyId }]) => ({ who, name, keyId }));
    localStorage.setItem(MUTED_KEY, JSON.stringify(kept));
  } catch {
    /* a private window: a mute lasts as long as the page */
  }
}

function restoreMutes() {
  try {
    const saved = JSON.parse(localStorage.getItem(MUTED_KEY) ?? '[]');
    for (const entry of Array.isArray(saved) ? saved : []) {
      if (typeof entry?.who !== 'string' || !entry.who.startsWith('key:')) continue;
      state.muted.set(entry.who, { name: String(entry.name ?? ''), keyId: entry.keyId ?? null });
    }
    state.offerMutes = localStorage.getItem(OFFER_KEY) !== 'off';
  } catch {
    /* unreadable: nobody muted is a safe place to start */
  }
}

function mute(message) {
  const who = personOf(message);
  if (!who || message.authorId === state.me?.id) return;
  state.muted.set(who, { name: message.author, keyId: message.authorKey ?? null });
  state.muteOffers.delete(who);
  rememberMutes();
  paintMuted();
  renderRoom();
  notify(`Muted ${message.author}. Only you will know. Undo it in Settings.`);
}

function unmute(who) {
  const was = state.muted.get(who);
  if (!was) return;
  state.muted.delete(who);
  rememberMutes();
  paintMuted();
  renderRoom();
  notify(`Unmuted ${was.name}.`);
}

/** The list in Settings, which is also the way back from every mute. */
function paintMuted() {
  const list = $('muted-list');
  list.textContent = '';
  for (const [who, { name, keyId }] of state.muted) {
    const li = document.createElement('li');
    const person = document.createElement('span');
    person.className = 'muted-who';
    person.append(signed(name, keyId));

    const undo = document.createElement('button');
    undo.type = 'button';
    undo.textContent = 'Unmute';
    undo.setAttribute('aria-label', `Unmute ${name}`);
    undo.addEventListener('click', () => {
      unmute(who);
      // The row just went, and the button with it, so focus goes to the next
      // one along rather than falling out of the menu.
      ($('muted-list').querySelector('button') ?? $('offer-mute')).focus({ preventScroll: true });
    });

    li.append(person, undo);
    list.append(li);
  }
  $('muted-none').hidden = state.muted.size > 0;
  $('offer-mute').checked = state.offerMutes;
}

/**
 * Offer to mute somebody who has just sworn.
 *
 * Offered, never done. The words are the ones the moderators' scanner knows
 * (`lib/flag.js`), matched as whole words so `Scunthorpe` and `classic` pass,
 * and a list of words cannot tell abuse from a quotation or a joke between
 * friends — so it asks the one person whose call it is. Once per person, and
 * a no stands for as long as the page is open.
 *
 * Only for what is said while you are here. A room's history arrives all at
 * once, and asking about everybody who swore since this morning would be a
 * wall of questions about people who may well have left.
 *
 * Encrypted messages are included, because this runs where they are opened;
 * the server still sees nothing.
 */
function considerMuting(message) {
  if (!state.offerMutes || !message?.body || message.machine || message.authorId === state.me?.id) return;
  const who = personOf(message);
  if (!who || state.muted.has(who) || state.declined.has(who) || state.muteOffers.has(who)) return;
  if (scan(message.body).clean) return;
  state.muteOffers.set(who, message.id);
}

/** The offer, in the log straight after the message that prompted it. */
function muteOffer(message) {
  const who = personOf(message);
  if (!who || state.muteOffers.get(who) !== message.id) return null;

  const li = document.createElement('li');
  li.className = 'mute-offer';

  const say = document.createElement('p');
  const name = document.createElement('strong');
  name.append(signed(message.author, message.authorKey));
  say.append(
    name,
    document.createTextNode(' used profanity. Mute them? Only you would know, and you can undo it in Settings.'),
  );

  const actions = document.createElement('p');
  actions.className = 'mute-offer-actions';
  const yes = document.createElement('button');
  yes.type = 'button';
  yes.className = 'mute-yes';
  yes.textContent = 'Mute';
  yes.setAttribute('aria-label', `Mute ${message.author}`);
  yes.addEventListener('click', () => mute(message));
  const no = document.createElement('button');
  no.type = 'button';
  no.textContent = 'Not now';
  no.addEventListener('click', () => {
    state.declined.add(who);
    state.muteOffers.delete(who);
    renderRoom();
  });
  actions.append(yes, no);

  li.append(say, actions);
  return li;
}

/** A run of messages from somebody muted, as one line that can be opened. */
function mutedRun(run) {
  const li = document.createElement('li');
  li.className = 'muted-run';

  const written = run.filter((m) => m.machine).length;
  const people = new Set(run.filter((m) => !m.machine).map(personOf)).size;
  const says = document.createElement('span');
  const from =
    written === run.length
      ? 'the server'
      : written
        ? `the server and ${people === 1 ? 'someone' : 'people'} you muted`
        : `${people === 1 ? 'someone' : 'people'} you muted`;
  says.textContent = `${run.length === 1 ? 'A message' : `${run.length} messages`} from ${from}`;

  const show = document.createElement('button');
  show.type = 'button';
  show.textContent = run.length === 1 ? 'show it' : 'show them';
  show.addEventListener('click', () => {
    for (const m of run) state.revealed.add(m.id);
    renderRoom();
  });

  li.append(says, show);
  return li;
}

/**
 * Messages the server writes rather than a person: a question to start a quiet
 * chat, and everything the made-up people of a demo say. Muted, they are
 * folded away in the room, never announced, and the server is told to stop
 * counting them as unread or telling this page about them at all.
 *
 * Kept in this browser, and said again on every connection, since the server
 * keeps preferences by who somebody is and a fresh guest is somebody new.
 */
const HUSH_KEY = 'eulerchat.hushSystem';

function hushSystem(on) {
  state.hushSystem = on;
  try {
    localStorage.setItem(HUSH_KEY, on ? 'on' : 'off');
  } catch {
    /* muted for as long as the page is open */
  }
  paintHush();
  send({ type: 'notifications', settings: { system: !on } });
  renderRoom();
}

function paintHush() {
  const button = $('hush-system');
  button.setAttribute('aria-pressed', String(state.hushSystem));
  button.querySelector('.label').textContent = state.hushSystem ? 'System messages muted' : 'System messages on';
  button.setAttribute(
    'aria-label',
    state.hushSystem ? 'Unmute messages written by the server' : 'Mute messages written by the server',
  );
}

$('hush-system').addEventListener('click', () => hushSystem(!state.hushSystem));

try {
  state.hushSystem = localStorage.getItem(HUSH_KEY) === 'on';
} catch {
  /* nothing remembered here */
}
paintHush();

$('offer-mute').addEventListener('change', (evt) => {
  state.offerMutes = evt.target.checked;
  if (!state.offerMutes) state.muteOffers.clear();
  try {
    localStorage.setItem(OFFER_KEY, state.offerMutes ? 'on' : 'off');
  } catch {
    /* as above */
  }
  renderRoom();
});

restoreMutes();
paintMuted();

// --- the deletion record ----------------------------------------------------

/**
 * What this browser can check about deletions, and nothing it cannot.
 *
 * The server keeps a record of everything it deletes, each entry chained to
 * the one before by a hash, and it names messages by a hash of themselves
 * rather than by their words. An encrypted message is named by its scrambled
 * text — the only thing the server ever had — so the people it was sent to
 * are the only ones who can recognise it in the record.
 *
 * That makes two checks possible here, and both are made. When you delete a
 * message, the entry the server sends back must name that exact message; and
 * later, the whole record must still hash through unbroken and still hold
 * every entry you were given. Either failing is said plainly.
 *
 * What neither can show is that nobody kept a copy somewhere else. The record
 * shows what the server says it deleted, and that it has not quietly changed
 * that story since.
 */
const DELETIONS_KEY = 'eulerchat.deletions';

function storedDeletions() {
  try {
    const saved = JSON.parse(localStorage.getItem(DELETIONS_KEY) ?? '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

/**
 * Keep the entry for a message you deleted: its hash and where it sits in the
 * record. Not its words, and for an encrypted message not its scrambled text
 * either — what is kept is only enough to find it in the record again.
 */
function storeDeletion(entry) {
  try {
    const all = storedDeletions().filter((kept) => kept.commitment !== entry.commitment);
    all.push(entry);
    localStorage.setItem(DELETIONS_KEY, JSON.stringify(all.slice(-500)));
  } catch {
    /* a private window: the check on arrival still happened, it just is not kept */
  }
}

/** The entry the server sent back for something you deleted: does it name it? */
async function checkReceipt(receipt) {
  if (!receipt || !Array.isArray(receipt.commitments)) {
    notify('Deleted.');
    return;
  }

  let named = null;
  for (const [id, message] of state.deleting) {
    const mark = await commitment(message);
    if (receipt.commitments.includes(mark)) {
      named = { id, message, mark };
      break;
    }
  }
  // The entry's own hash covers everything in it, including the entry before
  // it, so a receipt that has been altered in transit does not match itself.
  const intact = (await digest(entryInput(receipt))) === receipt.hash;

  if (!named) {
    notify('Deleted, but the deletion record the server sent back does not name this message.');
    return;
  }
  state.deleting.delete(named.id);
  if (!intact) {
    notify('Deleted, but the deletion record the server sent back does not check out.');
    return;
  }

  storeDeletion({
    commitment: named.mark,
    seq: receipt.seq,
    hash: receipt.hash,
    at: receipt.at,
    sealed: Boolean(named.message.sealed),
  });
  notify(
    named.message.sealed
      ? `Deleted. Deletion record entry ${receipt.seq} names this encrypted message.`
      : `Deleted. Deletion record entry ${receipt.seq} names this message.`,
  );
}

/**
 * The whole record, checked against what this browser knows.
 *
 * Three things: that the record hashes through from the first entry to the
 * last, so nothing in it has been edited; that every entry you were given when
 * you deleted something is still there and unchanged; and which of the
 * messages you kept have since been deleted, including by the twelve-hour
 * sweep, which nobody is told about as it happens.
 */
async function checkRecord(chain) {
  const status = $('deletion-status');
  const result = await verify(chain);
  if (!result.ok) {
    const more = result.problems.length > 1 ? ` (and ${result.problems.length - 1} more)` : '';
    status.textContent = `Problem with the deletion record: ${result.problems[0]}${more}.`;
    status.classList.add('problem');
    return;
  }

  const bySeq = new Map(chain.map((entry) => [entry.seq, entry]));
  const mine = storedDeletions();
  const changed = mine.filter((kept) => {
    const entry = bySeq.get(kept.seq);
    return !entry || entry.hash !== kept.hash || !entry.commitments?.includes(kept.commitment);
  });
  if (changed.length) {
    status.textContent =
      `Problem: ${changed.length} of your deletions ` +
      `${changed.length === 1 ? 'is' : 'are'} no longer in the record as it was when you deleted ` +
      `${changed.length === 1 ? 'it' : 'them'}.`;
    status.classList.add('problem');
    return;
  }

  const named = new Set(chain.flatMap((entry) => entry.commitments ?? []));
  let gone = 0;
  let goneSealed = 0;
  for (const kept of state.kept) {
    if (!kept.id) continue;
    if (named.has(await commitment(kept))) {
      gone += 1;
      if (kept.sealed) goneSealed += 1;
    }
  }

  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const parts = [`Record checked: ${count(chain.length, 'entry', 'entries')}, unbroken.`];
  if (mine.length) {
    const sealed = mine.filter((kept) => kept.sealed).length;
    parts.push(
      `${count(mine.length, 'message', 'messages')} you deleted ` +
        `${sealed ? `(${sealed} encrypted) ` : ''}${mine.length === 1 ? 'is' : 'are'} still recorded.`,
    );
  }
  if (gone) {
    parts.push(
      `${count(gone, 'message', 'messages')} you kept ${gone === 1 ? 'has' : 'have'} been deleted` +
        `${goneSealed ? ` (${goneSealed} encrypted)` : ''}.`,
    );
  }
  if (!mine.length && !gone) parts.push('Nothing you deleted or kept is in it.');
  status.textContent = parts.join(' ');
  status.classList.remove('problem');
}

$('check-deletions').addEventListener('click', () => {
  $('deletion-status').textContent = 'Checking…';
  send({ type: 'receipts' });
});

// --- colours somebody picked ------------------------------------------------

const COLOUR_KEY = 'eulerchat.colours';

/** Keep what has been chosen, so the map looks the same tomorrow. */
function rememberColours() {
  try {
    localStorage.setItem(COLOUR_KEY, JSON.stringify(chosenHues()));
  } catch {
    /* a private window: the choice lasts as long as the page */
  }
}

function restoreColours() {
  try {
    const saved = JSON.parse(localStorage.getItem(COLOUR_KEY) ?? '{}');
    for (const [subject, degrees] of Object.entries(saved)) setHue(subject, degrees);
  } catch {
    /* unreadable: everything keeps the colour its name gives it */
  }
}
restoreColours();

// How the place looks. Worn before the first message arrives, so the first map
// is drawn in colours already solved against the paper it is on. A scheme on
// light paper moves the subject colours, so everything that draws one is
// redrawn when the choice settles — the same three the hue picker repaints.
restoreAppearance();
mountAppearance(document, {
  onChange: () => {
    if (state.atlas) drawAtlas();
    drawMinimap({ recolour: true });
    renderRooms();
    renderRail();
  },
});

// The sheet wants the page in view, so any menu hanging from the header gets
// out of the way. The way back from it is the Theme label that opened it, and
// `appearance.js` sends focus there itself. On a phone that label is in the
// Settings menu, which has just been put away — so this catches focus left
// with nowhere to be, and gives it to whichever of the two can take it.
const themeLabels = [...document.querySelectorAll('button[aria-controls="appearance"]')];
for (const label of themeLabels) label.addEventListener('click', () => closePopouts());
$('appearance').addEventListener('close', () => {
  const at = document.activeElement;
  if (!at || at === document.body || at.closest?.('#appearance, [hidden]')) {
    const shown = themeLabels.find((label) => label.getClientRects?.().length && !label.closest('[hidden]'));
    (shown ?? $('settings-open')).focus({ preventScroll: true });
  }
});

/**
 * Pick a colour for one subject.
 *
 * A hue and nothing else. Lightness is solved per hue so that every subject
 * reads at the same strength against both themes, and handing that over would
 * be handing somebody the one control that can make their own map unreadable.
 * The wheel is the part that carries which-subject-is-which, and that is the
 * part worth being able to change.
 */
function openColour(row, swatch, subject) {
  const already = row.querySelector('.picker');
  document.querySelectorAll('.picker').forEach((p) => p.remove());
  document.querySelectorAll('.swatch[aria-expanded="true"]')
    .forEach((s) => s.setAttribute('aria-expanded', 'false'));
  if (already) return;

  swatch.setAttribute('aria-expanded', 'true');
  const picker = document.createElement('div');
  picker.className = 'picker';

  const wheel = document.createElement('input');
  wheel.type = 'range';
  wheel.min = '0';
  wheel.max = '359';
  wheel.value = String(hue(subject));
  wheel.setAttribute('aria-label', `colour of ${subjectLabel(subject)}`);

  const redrawSwatch = () => {
    swatch.textContent = '';
    swatch.append(glyphSwatch(document, subject));
  };

  const repaintAll = () => {
    redrawSwatch();
    swatch.classList.toggle('picked', isChosen(subject));
    // Everything that draws a subject, at once: the map, the overview, the
    // chips, the interests.
    if (state.atlas) drawAtlas();
    drawMinimap({ recolour: true });
    renderRooms();
    renderRail();
  };

  wheel.addEventListener('input', () => {
    setHue(subject, Number(wheel.value));
    redrawSwatch();
  });
  // The map is redrawn when the dragging stops rather than on every frame of
  // it; regrowing an atlas per pixel would make the slider feel like treacle.
  wheel.addEventListener('change', () => {
    setHue(subject, Number(wheel.value));
    rememberColours();
    repaintAll();
  });

  const given = document.createElement('button');
  given.type = 'button';
  given.className = 'picker-reset';
  given.textContent = 'Default colour';
  given.addEventListener('click', () => {
    setHue(subject, null);
    rememberColours();
    wheel.value = String(givenHue(subject));
    repaintAll();
    picker.remove();
    swatch.setAttribute('aria-expanded', 'false');
  });

  picker.append(wheel, given);
  row.append(picker);
  wheel.focus();
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
/**
 * How many hold each interest the map knows about: the room of that interest
 * alone, which reaches everybody holding it. Not the zone's number, which is
 * only the people holding it and nothing else on this map — the list of
 * interests said 47 for film photography while the same map's list of chats
 * said 67. Before the picture arrives there is nothing, and the rows wait.
 */
function railPopulation() {
  return new Map(
    currentRooms()
      .filter((room) => room.subjects.length === 1)
      .map((room) => [room.subjects[0], room.population]),
  );
}

/**
 * The counts in the list of interests, brought up to date where they stand.
 * Not the list drawn again: that would take somebody's place in it, and the
 * focus off the button they were about to press, every ten seconds.
 */
function recountRail() {
  const population = railPopulation();
  for (const li of $('subjects').querySelectorAll('li[data-subject]')) {
    const n = population.get(li.dataset.subject);
    const count = [...li.children].find((node) => node.classList.contains('count'));
    if (n !== undefined && count) count.textContent = String(n);
  }
}

function renderRail() {
  const { rail, subscription } = state.diagram;
  const held = new Set(subscription);
  const population = railPopulation();
  const list = $('subjects');
  list.textContent = '';

  if (state.results) {
    group(list, `matches for “${state.results.query}”`);
    if (!state.results.subjects.length) {
      const none = document.createElement('li');
      none.className = 'group';
      none.textContent = 'Nothing found';
      list.append(none);
    }
    for (const { id, population: n } of state.results.subjects) {
      // As when browsing: a head count is shown when there is one to show.
      list.append(subjectRow(id, n || undefined, held.has(id)));
    }
    return;
  }

  if (rail.held.length) {
    group(list, 'joined');
    for (const s of rail.held) list.append(subjectRow(s, population.get(s), true));
  }

  if (rail.suggested.length) {
    group(list, 'related');
    for (const s of rail.suggested) list.append(subjectRow(s, population.get(s), false));
  }

  if (rail.discoveries?.length) {
    group(list, rail.held.length ? 'one interest away' : 'popular');
    for (const find of rail.discoveries) list.append(discoveryRow(find, held.has(find.subject)));
  }

  if (rail.popular.length) {
    group(list, 'popular');
    for (const s of rail.popular) list.append(subjectRow(s, undefined, false));
  }

  renderBrowse(list, held);

  $('rail-total').textContent = state.browse
    ? `${rail.total.toLocaleString()} interests · search, or browse below`
    : `${rail.total.toLocaleString()} interests · search for more`;
  // Setting `.value` on a select is not universally writable; marking the
  // option is, and works the same everywhere.
  const reach = String(state.diagram.funnel ?? 0);
  if (document.activeElement !== $('funnel')) {
    for (const option of $('funnel').options ?? []) option.selected = option.value === reach;
  }
}

/**
 * The catalogue, a level at a time.
 *
 * Search finds what somebody can already name. Most of a thousand interests
 * are ones a newcomer has never thought to look for, and with nobody in them
 * yet they are on no list of what is popular either — so without this the
 * only way to find `narrowboats` was to already want it. The divisions are
 * listed at the bottom of the interests, each opens onto its fields, and each
 * of those onto what can be joined.
 *
 * Everything listed can be joined, the categories included: `sport` is a room
 * as well as a heading. A category's name is the way in, and says a little of
 * what is in it, since `lifestyle` on its own is a word and `pets, travel,
 * money` is a reason to open it.
 */
function renderBrowse(list, held) {
  const level = state.browse;
  if (!level || (!level.children?.length && !level.path?.length)) return;
  group(list, 'browse');

  if (level.path.length) {
    const crumbs = document.createElement('li');
    crumbs.className = 'crumbs';
    const step = (label, at) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', () => browseTo(at));
      return button;
    };
    crumbs.append(step('All', null));
    level.path.forEach((name, i) => {
      crumbs.append(document.createTextNode(' / '));
      if (i < level.path.length - 1) {
        crumbs.append(step(name, name));
        return;
      }
      const here = document.createElement('strong');
      here.textContent = name;
      crumbs.append(here);
    });
    list.append(crumbs);
  }

  for (const child of level.children) list.append(browseRow(child, held.has(child.id)));
}

function browseRow(child, held) {
  // A column of noughts makes a new place look dead, and says nothing a blank
  // does not: only a head count worth reading is shown.
  const li = subjectRow(child.id, child.population || undefined, held);
  if (!child.inside) return li;

  li.classList.add('category');
  const into = document.createElement('button');
  into.type = 'button';
  into.className = 'name browse-into';
  into.textContent = subjectLabel(child.id);
  into.setAttribute('aria-label', `Browse ${subjectLabel(child.id)}, ${child.inside} interests`);
  into.addEventListener('click', () => browseTo(child.id));
  li.querySelector('.name').replaceWith(into);

  const inside = document.createElement('p');
  inside.className = 'inside';
  const more = child.inside - child.sample.length;
  inside.textContent = child.sample.join(', ') + (more > 0 ? ` and ${more} more` : '');
  li.append(inside);
  return li;
}

function browseTo(at) {
  state.browseMoved = true;
  send({ type: 'browse', at });
}

/**
 * After opening a category the list has been rebuilt, and the button that was
 * pressed with it. Focus goes to the way back, and the level is brought to
 * the top of what can be seen, so it reads from its first line.
 */
function followBrowse() {
  if (!state.browseMoved) return;
  state.browseMoved = false;
  const list = $('subjects');
  const heading = [...list.querySelectorAll('.group')].find((li) => li.textContent === 'browse');
  heading?.scrollIntoView?.({ block: 'start' });
  (list.querySelector('.crumbs button') ?? list.querySelector('.browse-into'))?.focus?.({ preventScroll: true });
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
  // Compared as named, since inside a group the results are the group's copies.
  const existing = state.results?.subjects?.find((s) => subjectLabel(s.id) === name.toLowerCase());
  if (existing) {
    notify(`"${subjectLabel(existing.id)}" already exists (${existing.population} people). Joined it.`);
    joinSubject(existing.id);
  } else {
    send({ type: 'createSubject', name: state.cluster ? `${state.cluster}/${name}` : name });
    notify(`Created "${name}" and joined it.`);
  }
  input.value = '';
  state.results = null;
});

$('funnel').addEventListener('change', (evt) => {
  send({ type: 'funnel', reach: Number(evt.target.value) });
});

/**
 * The interests, over whatever is showing, and put away again.
 *
 * Two buttons open it: one in the header where there is room for it, and the
 * last one in the bar along the bottom on a phone, where there is not. Modal,
 * like the full-size map: nothing behind it needs touching while it is open,
 * and Escape closes it without being asked.
 */
const interests = $('interests');

function openInterests() {
  if (interests.open) return;
  closePopouts();
  if (typeof interests.showModal === 'function') interests.showModal();
  else interests.open = true;
  // The list to add from is the whole catalogue, fetched when it is first
  // wanted and again once its counts have had a minute to move.
  if (!state.chart || Date.now() - state.chart.at > 60_000) send({ type: 'chart' });
  // Straight into the search where there is a keyboard to type with anyway.
  // On a phone that would put the keyboard over half the list before anybody
  // had asked to type, so there it waits to be tapped.
  if (globalThis.matchMedia?.('(hover: hover) and (pointer: fine)').matches) {
    $('subject-name').focus();
  }
}

/**
 * The list of everything to add from, in Interests, with what is already
 * held shown as joined. Filled again only when what is held has changed or a
 * new catalogue has come: rebuilding it under somebody who has it open would
 * shut it on them.
 */
let catalogueDrawn = '';
function paintCatalogue() {
  const select = $('add-interest');
  if (!select || !state.chart) return;
  const held = heldHere();
  const drawn = `${state.chart.at}|${[...held].sort().join('|')}`;
  if (drawn === catalogueDrawn) return;
  catalogueDrawn = drawn;
  const prompt = select.querySelector('option[value=""]');
  if (prompt) prompt.textContent = 'Choose an interest to add…';
  fillCatalogue(select, state.chart.subjects ?? [], held);
  select.disabled = false;
}

$('add-interest').addEventListener('change', (evt) => {
  const id = evt.target.value;
  // Back to the prompt straight away, so the list says what it is for
  // rather than the name of the last thing picked from it.
  showPrompt(evt.target);
  if (!id || heldHere().has(id)) return;
  joinSubject(id);
  // Said in the dialog, not on the page's notice line, which is behind the
  // dialog and inert while it is open.
  $('add-said').textContent = `Joined ${id}.`;
});

/**
 * What the server said when poked, beside the conversation it was asked
 * about, and gone when that conversation is left. Only the one who poked sees
 * it; nothing of it reaches the room unless they use it and send it.
 */
function paintPoke() {
  const box = $('poke-reply');
  const poked = state.poked;
  const showing = Boolean(poked) && poked.room === state.selected && !state.lurking;
  box.hidden = !showing;
  if (!showing) return;
  $('poke-text').textContent = poked.text;
  // Into the box only where there is a box to put it in: a member's.
  $('poke-use').disabled = $('body').disabled;
}

const poke = () => {
  if (!state.selected) return;
  send({ type: 'poke', room: state.selected });
};
$('poke').addEventListener('click', poke);
$('poke-again').addEventListener('click', poke);
$('poke-close').addEventListener('click', () => {
  state.poked = null;
  paintPoke();
});
// Put in the box to be changed or sent. Sent, it is their message and says
// so: they chose the words, as they would copying them from anywhere else.
$('poke-use').addEventListener('click', () => {
  const body = $('body');
  if (body.disabled || !state.poked) return;
  body.value = state.poked.text;
  body.focus();
  state.poked = null;
  paintPoke();
});

function closeInterests() {
  if (typeof interests.close === 'function') interests.close();
  else interests.open = false;
}

for (const button of document.querySelectorAll('.interests-open')) {
  button.addEventListener('click', openInterests);
}
$('interests-close').addEventListener('click', closeInterests);

// A press that starts and ends on the darkened part outside closes it. Both
// ends, because a click is reported on whatever the press and the release
// share: dragging a selection or a colour slider out past the edge ends on
// the dialog itself, and that is not somebody asking to leave.
let pressedOutside = false;
interests.addEventListener('pointerdown', (evt) => {
  pressedOutside = evt.target === interests;
});
interests.addEventListener('click', (evt) => {
  if (pressedOutside && evt.target === interests) closeInterests();
  pressedOutside = false;
});

// An explanation opened in here goes when it does, rather than being left
// pinned where the dialog used to be.
interests.addEventListener('close', () => card.hide(true));

/**
 * The interests held, by the names the catalogue gives them. Inside a group
 * those are the group's copies — `kite-fox-9/chess` is chess — so the minimap
 * and the explorer, which only know the open catalogue, still light up what
 * somebody is in. The group's own conversation is not an interest anywhere.
 */
function heldInterests() {
  const held = (state.diagram?.subscription ?? []).filter((s) => !isGroupRoom(s));
  return new Set(held.map(subjectLabel));
}

/**
 * What is held where they are now, by the names the catalogue gives them:
 * inside a group, the group's copies; outside one, the open world's. What can
 * be added from the list is whatever is not held here. Counted on both sides
 * of the line, somebody holding painting outside who went into a group found
 * the group's painting marked as joined, could not pick it, and was left with
 * a map that showed only the painting outside.
 */
function heldHere() {
  const here = state.cluster ?? null;
  const held = (state.diagram?.subscription ?? []).filter((s) => !isGroupRoom(s) && clusterOf(s) === here);
  return new Set(held.map(subjectLabel));
}

/** The subject actually held under a catalogue name: the group's copy, inside one. */
function heldAs(id) {
  const held = (state.diagram?.subscription ?? []).filter((s) => !isGroupRoom(s) && subjectLabel(s) === id);
  return held.find((s) => clusterOf(s) === state.cluster) ?? held[0] ?? null;
}

/**
 * An interest's own conversation — the room of that interest alone, or of it
 * and the group's conversation that wraps it — opened, if it is on the map.
 */
function openInterest(id) {
  const subject = heldAs(id);
  const room = currentRooms().find((r) => {
    const own = r.subjects.filter((s) => !isGroupRoom(s));
    return own.length === 1 && own[0] === subject;
  });
  if (!room) return false;
  select(room.key);
  return true;
}

const explorer = mountExplorer(document, {
  ask: () => send({ type: 'chart', have: state.chart?.shape }),
  held: heldInterests,
  join: joinSubject,
  leave: (id) => {
    const subject = heldAs(id);
    if (subject) send({ type: 'leave', subject });
  },
  browse: (field) => {
    browseTo(field);
    openInterests();
  },
  room: openInterest,
  // The chat for two interests at once, if there is one: from "Often held
  // with" in All interests. Opened as any chat is — with the way in, if it
  // is one they are not in yet.
  pair: (a, b) =>
    currentRooms().find((r) => {
      const own = r.subjects.filter((s) => !isGroupRoom(s)).map(subjectLabel).sort();
      return own.length === 2 && own[0] === [a, b].sort()[0] && own[1] === [a, b].sort()[1];
    })?.key ?? null,
  openRoom: (key) => {
    if (!currentRooms().some((r) => r.key === key)) return false;
    select(key);
    return true;
  },
  opened: closePopouts,
  relief: () => state.relief,
  setRelief,
  menu: (id, at) => interestMenu(id, at),
  // A community picked in All interests: branched into on the map, or joined
  // whole, or in part. See `lib/communities.js`.
  branch: (id) => {
    explorer.close();
    branchOut(id);
  },
  joinAll: (subjects) => joinMany(subjects),
  joinSome: (subjects, title) => openJoinSome(subjects, title),
});

// The minimap is the explorer, small; pressing it goes in. The buttons are
// the same thing for a keyboard, and say what pressing does: one under View,
// beside the minimap, and one on the map beside Conversations, where anybody
// looking for something to talk about is already looking. A pointer resting
// on either plays a little of what is on the other side.
$('minimap').addEventListener('click', () => explorer.open());
for (const button of document.querySelectorAll('.explore-open')) {
  button.addEventListener('click', () => explorer.open());
}
mountPeek(document, { overview: () => state.overview, held: heldInterests });
$('explorer').addEventListener('close', () => card.hide(true));

$('name').addEventListener('change', (evt) => {
  send({ type: 'identify', name: evt.target.value });
  try {
    localStorage.setItem(NAME_KEY, evt.target.value);
  } catch {
    /* it will last as long as the server remembers them, as it used to */
  }
  notify(`Name changed to "${evt.target.value}".`);
});

// --- desktop alerts --------------------------------------------------------

/**
 * Asking for notification permission unprompted is the thing everyone hates,
 * so it is behind a button and only ever asked for on a click.
 */
function paintBell() {
  const bell = $('bell');
  if (typeof Notification === 'undefined') {
    // The whole section, not just the button — its heading and the help
    // button beside it would otherwise be left standing on their own,
    // offering to explain a control that is not there.
    (bell.closest('.settings') ?? bell).hidden = true;
    return;
  }
  const on = Notification.permission === 'granted';
  bell.classList.toggle('on', on);
  // The words beside the bell, not the button, which would take the bell with them.
  const says = bell.querySelector('.label') ?? bell;
  says.textContent = on ? 'Alerts on' : 'Turn on alerts';
  bell.disabled = Notification.permission === 'denied';
  if (bell.disabled) says.textContent = 'Alerts blocked by browser';
}

$('bell').addEventListener('click', async () => {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'default') await Notification.requestPermission();
  paintBell();
});

paintBell();
