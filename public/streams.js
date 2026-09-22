/**
 * A window on the open side: the firehose live, the dumps it leaves behind a
 * megabyte at a time, and the record of what the place forgot.
 *
 * It reads only what anybody can read, the way anybody would read it, so what
 * it shows is exactly what the rest of the world sees. Everything from the
 * server is put on the page as text and never as markup: these are strangers'
 * words, and some of them will be trying something.
 */

import { watchLink, watchable } from '../lib/lurk.js';

// The API beside this page. `?api=` for a host that moved it with `apiPath`.
const base = new URL(new URLSearchParams(location.search).get('api') ?? 'api/', location.href);
const api = (path) => new URL(path.replace(/^\//, ''), base.href.endsWith('/') ? base : `${base.href}/`);

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const clock = (at) => (at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const when = (at) => (at ? new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const size = (bytes) => (bytes < 1000 ? `${bytes} B` : bytes < 1e6 ? `${Math.round(bytes / 1000)} kB` : `${(bytes / 1e6).toFixed(2)} MB`);
const many = (n, one, more = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : more}`;
const roomOf = (key) => String(key ?? '').split('+').join(' + ');

/**
 * A chat's name, as the way into it: its quick-join link, which opens it in
 * the app to watch — counted as lurking, never named, nothing kept — with
 * Join in a press away. Plain text for anything that cannot be watched, which
 * a portal never reaches here to be anyway.
 */
function chatLink(key) {
  const room = watchable(key);
  if (!room) return el('span', 'room', roomOf(key));
  const link = el('a', 'room', roomOf(key));
  // The app is beside this page, wherever the host mounted the two.
  link.href = watchLink(new URL('./', location.href).href, room);
  link.title = 'Quick join: watch this chat in the app, then join in if you like';
  return link;
}

// --- a deletion's hashes ------------------------------------------------------

/** How many of a deletion's commitments are listed here; the record has them all. */
const LIST_HASHES = 50;
let hashPanels = 0;

/**
 * A deletion's hashes: the record's own, shortened, as a button that shows
 * them whole — the record's, the one before it that it is chained to where
 * that is known, and the commitment each forgotten message is named by. Whole,
 * because half a hash cannot be checked against anything, and each selects
 * in one click for copying. Returns the button and what it opens, for the
 * caller to place.
 */
function hashesOf({ seq, hash, previous, commitments = [] }, open = false) {
  const button = el('button', 'hash-toggle');
  button.type = 'button';
  button.append(el('code', 'hash', `${String(hash).slice(0, 16)}…`));
  button.title = 'The hashes: the deletion record’s, and a commitment for each message it names';
  button.setAttribute('aria-label', `Hashes of deletion #${seq}`);
  const panel = el('div', 'hash-detail');
  panel.id = `hashes-${++hashPanels}`;
  button.setAttribute('aria-controls', panel.id);

  const line = (label, value) => {
    const p = el('p', 'hash-line');
    p.append(el('span', 'hash-label', label), value);
    return p;
  };
  panel.append(line('Record', el('code', 'hash whole', hash)));
  if (previous !== undefined) {
    panel.append(line('Follows', previous ? el('code', 'hash whole', previous) : el('span', '', 'nothing: the first in the record')));
  }
  panel.append(el('p', 'hash-label', `${many(commitments.length, 'commitment')}, one for each message. Anybody holding a copy of one can recompute its commitment and find it here; to anybody else these say nothing.`));
  const list = el('ol', 'commitments');
  for (const c of commitments.slice(0, LIST_HASHES)) {
    const li = el('li');
    li.append(el('code', 'hash whole', c));
    list.append(li);
  }
  panel.append(list);
  if (commitments.length > LIST_HASHES) {
    const rest = el('a', '', `and ${many(commitments.length - LIST_HASHES, 'more', 'more')}, in the record`);
    rest.href = api(`receipts?since=${seq}`).href;
    panel.append(rest);
  }

  const show = (on) => {
    button.setAttribute('aria-expanded', String(on));
    panel.hidden = !on;
  };
  show(open);
  button.addEventListener('click', () => show(panel.hidden));
  return { button, panel, isOpen: () => !panel.hidden };
}

// --- one event, as a row ------------------------------------------------------

/** An event from the firehose or a dump, as a list item. Text only. */
function rowFor(event) {
  const li = el('li', `event event-${event.type}`);
  li.append(el('time', 'event-at', clock(event.at)));
  li.append(el('span', 'kind', { message: 'message', 'room-opened': 'opened', 'room-closed': 'closed', forgotten: 'forgotten', dump: 'dump' }[event.type] ?? event.type));
  const what = el('div', 'event-what');
  li.append(what);

  if (event.type === 'message') {
    const head = el('div', 'event-head');
    head.append(chatLink(event.room));
    head.append(el('span', 'author', event.author ?? ''));
    if (event.authorKey) head.append(el('span', 'key', `·${String(event.authorKey).slice(0, 8)}`));
    if (event.machine) head.append(el('span', 'tag', 'system message'));
    if (event.cluster) head.append(el('span', 'tag', 'group'));
    what.append(head);
    what.append(event.sealed ? el('p', 'body sealed', 'Encrypted. The server holds only ciphertext.') : el('p', 'body', event.body ?? ''));
  } else if (event.type === 'room-opened') {
    what.append(chatLink(event.room));
  } else if (event.type === 'room-closed') {
    // Nobody left in it: nothing to watch.
    what.append(el('span', 'room', roomOf(event.room)));
  } else if (event.type === 'forgotten') {
    const why = { expired: 'past their twelve hours', asked: 'at their author’s request' }[event.reason] ?? event.reason;
    // Named by their commitments and the record's hash, never by their ids.
    // A dump older than that named them by id, and says only how many.
    const commitments = event.commitments ?? [];
    // A big one comes in parts, a few thousand to each.
    const part = event.parts > 1 ? ` (part ${event.part} of ${event.parts})` : '';
    what.append(el('span', '', `${many(commitments.length || (event.ids?.length ?? 0), 'message')} forgotten, ${why} · deletion #${event.seq}${part} `));
    if (event.receipt) {
      const { button, panel } = hashesOf({ seq: event.seq, hash: event.receipt, commitments });
      what.append(button, panel);
    }
  } else if (event.type === 'dump') {
    const says = el('span', '', `Dump #${event.id} ready · ${many(event.events, 'event')} · ${size(event.bytes)} `);
    const link = el('a', '', 'download');
    link.href = new URL(event.url, location.href).href;
    link.download = '';
    what.append(says, link);
  }
  return li;
}

// --- live ---------------------------------------------------------------------

const KEEP_ROWS = 400;
const shown = new Set(['message', 'forgotten', 'dump']);
let filter = '';
let paused = false;
let queue = [];
let held = 0;
const recent = []; // arrival times over the last minute, for the rate

const wanted = (event) =>
  shown.has(event.type)
  && (!filter || (event.type !== 'message' && !event.room) || String(event.room ?? '').toLowerCase().includes(filter));

/** Put what has arrived on the page, once a frame at most, however fast it comes. */
let drawing = false;
function draw() {
  if (drawing) return;
  drawing = true;
  requestAnimationFrame(() => {
    drawing = false;
    if (paused) return;
    const list = $('events');
    const fresh = document.createDocumentFragment();
    // Newest first: the last to arrive goes at the top.
    for (let i = queue.length - 1; i >= 0; i--) if (wanted(queue[i])) fresh.append(rowFor(queue[i]));
    queue = [];
    list.prepend(fresh);
    while (list.children.length > KEEP_ROWS) list.lastElementChild.remove();
    $('live-empty').hidden = list.children.length > 0;
  });
}

function heard(event) {
  const now = Date.now();
  recent.push(now);
  while (recent.length && recent[0] < now - 60_000) recent.shift();
  if (paused) {
    held += 1;
    $('paused').textContent = `Paused. ${many(held, 'event')} since, not shown.`;
  } else {
    queue.push(event);
    if (queue.length > KEEP_ROWS) queue = queue.slice(-KEEP_ROWS);
    draw();
  }
  if (event.type === 'dump') refreshDumps();
  if (event.type === 'forgotten') {
    refreshDumps();
    refreshReceipts();
  }
}

setInterval(() => {
  const now = Date.now();
  while (recent.length && recent[0] < now - 60_000) recent.shift();
  $('live-rate').textContent = recent.length ? `${recent.length}/min` : '';
}, 1000);

function listen() {
  const stream = new EventSource(api('firehose'));
  for (const type of ['message', 'room-opened', 'room-closed', 'forgotten', 'dump']) {
    stream.addEventListener(type, (e) => {
      try {
        heard(JSON.parse(e.data));
      } catch {
        /* one bad frame is not the stream */
      }
    });
  }
  stream.addEventListener('open', () => ($('status').textContent = 'Live'));
  stream.addEventListener('error', () => {
    // EventSource tries again on its own; this only says so.
    $('status').textContent = stream.readyState === EventSource.CLOSED ? 'Disconnected' : 'Reconnecting…';
  });
}

for (const box of document.querySelectorAll('.kinds input')) {
  box.addEventListener('change', () => {
    if (box.checked) shown.add(box.value);
    else shown.delete(box.value);
  });
}
$('room-filter').addEventListener('input', (e) => {
  filter = e.target.value.trim().toLowerCase();
});
$('pause').addEventListener('click', () => {
  paused = !paused;
  $('pause').setAttribute('aria-pressed', String(paused));
  $('pause').textContent = paused ? 'Resume' : 'Pause';
  $('paused').hidden = !paused;
  held = 0;
  $('paused').textContent = 'Paused.';
});

// --- dumps --------------------------------------------------------------------

let dumpsAt = 0;
let dumpsTimer = null;

/** Ask again for the list, at most every few seconds however often prompted. */
function refreshDumps() {
  if (dumpsTimer) return;
  dumpsTimer = setTimeout(async () => {
    dumpsTimer = null;
    dumpsAt = Date.now();
    await loadDumps();
  }, Math.max(0, 2000 - (Date.now() - dumpsAt)));
}

async function loadDumps() {
  const res = await fetch(api('dumps')).catch(() => null);
  if (!res?.ok) return;
  const { bytes, pending, dumps } = await res.json();

  const full = Math.min(1, pending.bytes / bytes);
  $('pending-bar').style.width = `${(full * 100).toFixed(1)}%`;
  $('pending-says').textContent = `${size(pending.bytes)} of ${size(bytes)} · ${many(pending.events, 'event')}${pending.since ? ` since ${clock(pending.since)}` : ''}`;
  $('dump-count').textContent = dumps.length ? String(dumps.length) : '';

  const list = $('dump-list');
  list.replaceChildren(
    ...dumps
      .slice()
      .reverse()
      .map((d) => {
        const li = el('li', 'dump');
        const name = el('strong', 'dump-name', `#${d.id}`);
        const span = el('span', 'dump-when', `${when(d.from)} – ${clock(d.to)}`);
        const counts = el('span', 'dump-counts', `${many(d.events, 'event')} · ${many(d.messages, 'message')}`);
        const meter = el('div', 'meter');
        meter.setAttribute('aria-hidden', 'true');
        const fill = el('div', 'meter-fill');
        fill.style.width = `${Math.min(100, (d.bytes / bytes) * 100).toFixed(1)}%`;
        meter.append(fill);
        const weight = el('span', 'dump-size', size(d.bytes));
        const view = el('button', '', 'View');
        view.type = 'button';
        view.addEventListener('click', () => showDump(d));
        const get = el('a', 'button', 'Download');
        get.href = new URL(d.url, location.href).href;
        get.download = '';
        const actions = el('span', 'dump-actions');
        actions.append(view, get);
        li.append(name, span, counts, meter, weight, actions);
        return li;
      }),
  );
  $('dumps-empty').hidden = dumps.length > 0;
}

const SHOW_FROM_DUMP = 300;

async function showDump(d) {
  const res = await fetch(new URL(d.url, location.href)).catch(() => null);
  $('dump-view').hidden = false;
  $('dump-view-title').textContent = `Dump #${d.id}`;
  if (!res?.ok) {
    $('dump-view-says').textContent = 'Gone: forgotten since the list was drawn.';
    $('dump-events').replaceChildren();
    return;
  }
  const lines = (await res.text()).split('\n').filter(Boolean);
  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      /* not a line of ours */
    }
  }
  const head = events[0]?.type === 'dump' ? events.shift() : null;
  $('dump-view-says').textContent = [
    head?.demo ? 'A demo: every word in it was made up.' : '',
    `${many(events.length, 'event')}, ${clock(head?.from)} to ${clock(head?.to)}.`,
    events.length > SHOW_FROM_DUMP ? `Showing the first ${SHOW_FROM_DUMP}; download it for the rest.` : '',
  ].filter(Boolean).join(' ');
  $('dump-events').replaceChildren(...events.slice(0, SHOW_FROM_DUMP).map(rowFor));
  $('dump-view').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

$('dump-view-close').addEventListener('click', () => {
  $('dump-view').hidden = true;
  $('dump-events').replaceChildren();
});

// --- deletions ----------------------------------------------------------------

let receiptsTimer = null;
/** Each receipt drawn, by number, and whether its hashes are open. */
const receiptHashes = new Map();

function refreshReceipts() {
  if (receiptsTimer) return;
  receiptsTimer = setTimeout(async () => {
    receiptsTimer = null;
    await loadReceipts();
  }, 1000);
}

async function loadReceipts() {
  const res = await fetch(api('receipts')).catch(() => null);
  if (!res?.ok) return;
  const { receipts } = await res.json();
  $('deletion-count').textContent = receipts.length ? String(receipts.length) : '';
  // Drawn again with every deletion, so whichever were open stay open.
  const opened = new Set();
  for (const [seq, isOpen] of receiptHashes) if (isOpen()) opened.add(seq);
  receiptHashes.clear();
  $('receipt-list').replaceChildren(
    ...receipts
      .slice(-200)
      .reverse()
      .map((r) => {
        const li = el('li', 'receipt');
        const hashes = hashesOf(r, opened.has(r.seq));
        receiptHashes.set(r.seq, hashes.isOpen);
        li.append(
          el('strong', '', `#${r.seq}`),
          el('span', '', when(r.at)),
          el('span', 'kind', r.reason),
          el('span', '', many(r.count, 'message')),
          hashes.button,
          hashes.panel,
        );
        return li;
      }),
  );
  $('deletions-empty').hidden = receipts.length > 0;
}

// --- tabs ---------------------------------------------------------------------

const tabs = [...document.querySelectorAll('[role="tab"]')];

function choose(tab) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    $(t.getAttribute('aria-controls')).hidden = !on;
  }
  try {
    localStorage.setItem('eulerchat.streams.tab', tab.id);
  } catch {
    /* only a convenience */
  }
  if (tab.id === 'tab-dumps') loadDumps();
  if (tab.id === 'tab-deletions') loadReceipts();
}

for (const tab of tabs) {
  tab.addEventListener('click', () => choose(tab));
  tab.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    const next = tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length];
    next.focus();
    choose(next);
  });
}

// --- start --------------------------------------------------------------------

async function start() {
  const res = await fetch(api('')).catch(() => null);
  const index = res?.ok ? await res.json().catch(() => null) : null;
  if (!index?.firehose) {
    $('off').hidden = false;
    for (const id of ['live', 'dumps', 'deletions']) $(id).hidden = true;
    document.querySelector('.tabs').hidden = true;
    return;
  }
  $('demo').hidden = !index.demo;
  if (!index.dumps) $('tab-dumps').hidden = true;

  let first = $('tab-live');
  try {
    first = $(localStorage.getItem('eulerchat.streams.tab')) ?? first;
  } catch {
    /* only a convenience */
  }
  if (first.hidden) first = $('tab-live');
  choose(first);
  listen();
  // The counts on the tabs, and a slow check on the next dump's fill, which
  // moves with every event and would be a request per event if it followed
  // them.
  loadReceipts();
  if (index.dumps) {
    loadDumps();
    setInterval(() => {
      if (!document.hidden) loadDumps();
    }, 10_000);
  }
}

start();
