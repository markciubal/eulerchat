/**
 * The hose: everything said in the chats you are in, as it is said.
 *
 * The map answers *where* a conversation is and the chat answers *what* is in
 * one. Neither answers the question somebody who holds nine interests actually
 * has, which is "is anything happening". Chats answers it as a number on a
 * chip, which is a badge to be cleared rather than a thing to read. So: one
 * stream, newest first, of what is arriving in the rooms this person is in.
 *
 * Each line wears the same swatches the map draws that chat with — the
 * interest's own colour and emblem, the squares on its chip — because a line
 * here and a patch there are the same chat, and nobody should have to read a
 * name to know that. From a line you can go to the chat (**View context**) or
 * to the message itself (**Jump**), which opens the chat and lights that one
 * message where it stands among the rest.
 *
 * It is a window on what the page already has. Nothing here asks the server
 * for anything: these are the messages that arrived for the rooms this person
 * is in, kept in the order they arrived, and dropped past `KEEP`.
 */

/** How many lines the hose keeps. Past this, the oldest go. */
export const KEEP = 200;

/**
 * @param {Document} doc
 * @param {object} hooks
 * @param {(key: string) => string[]} hooks.subjectsOf  the interests a room key is made of
 * @param {(doc: Document, subject: string, size: number) => Element} hooks.swatch  one interest's square
 * @param {(key: string) => void} hooks.open  go to that chat
 * @param {(key: string, messageId: string) => void} hooks.jump  go to that message
 * @param {(message: object) => boolean} [hooks.hidden]  whether a message is not to be shown
 */
export function mountHose(doc, hooks) {
  const $ = (id) => doc.getElementById(id);
  const dialog = $('hose');
  const list = $('hose-list');
  if (!dialog || !list) return null;

  /** Newest first, as it is read. */
  let stream = [];
  let paused = false;
  let held = 0;

  const when = (at) =>
    at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

  /** One line: whose chat, who said it, what they said, and the ways in. */
  function rowFor({ message, room }) {
    const li = doc.createElement('li');
    li.className = 'hose-line';
    li.dataset.room = room;

    const mark = doc.createElement('span');
    mark.className = 'hose-marks';
    // Three at most, as a chip does: a room can combine ten, and the rest are
    // counted rather than crammed in.
    const subjects = hooks.subjectsOf(room) ?? [];
    for (const subject of subjects.slice(0, 3)) mark.append(hooks.swatch(doc, subject, 12));
    if (subjects.length > 3) {
      const more = doc.createElement('span');
      more.className = 'hose-more';
      more.textContent = `+${subjects.length - 3}`;
      mark.append(more);
    }

    const head = doc.createElement('p');
    head.className = 'hose-head';
    const where = doc.createElement('span');
    where.className = 'hose-where';
    where.textContent = subjects.join(' + ');
    const who = doc.createElement('span');
    who.className = 'hose-who';
    who.textContent = message.author ?? '';
    const at = doc.createElement('time');
    at.className = 'hose-at';
    at.textContent = when(message.at);
    head.append(where, who, at);
    if (message.machine) {
      const made = doc.createElement('span');
      made.className = 'hose-tag';
      made.textContent = 'system message';
      head.append(made);
    }

    const body = doc.createElement('p');
    body.className = `hose-said${message.sealed ? ' sealed' : ''}`;
    body.textContent = message.sealed ? 'Encrypted. Open the chat to read it.' : message.body ?? '';

    const ways = doc.createElement('p');
    ways.className = 'hose-ways';
    const context = doc.createElement('button');
    context.type = 'button';
    context.textContent = 'View context';
    context.setAttribute('aria-label', `Open ${subjects.join(' and ')}`);
    context.addEventListener('click', () => {
      close();
      hooks.open(room);
    });
    const jump = doc.createElement('button');
    jump.type = 'button';
    jump.className = 'hose-jump';
    jump.textContent = 'Jump';
    jump.setAttribute('aria-label', `Go to what ${message.author} said`);
    jump.addEventListener('click', () => {
      close();
      hooks.jump(room, message.id);
    });
    ways.append(context, jump);

    li.append(mark, head, body, ways);
    return li;
  }

  function draw() {
    list.textContent = '';
    for (const line of stream) list.append(rowFor(line));
    $('hose-none').hidden = stream.length > 0;
    $('hose-held').hidden = !held;
    if (held) $('hose-held').textContent = `${held} more while paused`;
  }

  /**
   * Something was said in a room this person is in.
   *
   * Held rather than drawn while paused, because a line that moves out from
   * under a pointer on its way to being read is worse than a line that waits.
   */
  function add(message, room) {
    if (!message?.id || hooks.hidden?.(message)) return;
    if (stream.some((line) => line.message.id === message.id)) return;
    if (paused) {
      held += 1;
      if (!dialog.open) return;
      $('hose-held').hidden = false;
      $('hose-held').textContent = `${held} more while paused`;
      return;
    }
    const line = { message, room };
    stream.unshift(line);
    const dropped = stream.length > KEEP ? stream.pop() : null;
    // One row in at the top and, if it pushed one off the end, one row out —
    // rather than drawing the whole stream again for every message. A busy
    // hour is two hundred rows redrawn two hundred times otherwise.
    if (dialog.open) {
      list.prepend(rowFor(line));
      if (dropped) list.lastElementChild?.remove();
      $('hose-none').hidden = true;
    }
  }

  function open() {
    if (dialog.open) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.open = true;
    draw();
  }

  function close() {
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.open = false;
  }

  $('hose-close')?.addEventListener('click', close);
  $('hose-pause')?.addEventListener('click', () => {
    paused = !paused;
    held = 0;
    $('hose-pause').setAttribute('aria-pressed', String(paused));
    $('hose-pause').textContent = paused ? 'Resume' : 'Pause';
    $('hose-held').hidden = true;
  });

  return {
    add,
    open,
    close,
    draw,
    get isOpen() {
      return Boolean(dialog.open);
    },
    get lines() {
      return stream.length;
    },
  };
}
