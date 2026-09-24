/**
 * Answering the question someone is having right now.
 *
 * Two things, because people arrive with two different kinds of question.
 *
 * "What is this thing?" is answered by a small (i) beside the control, giving
 * a plain sentence and, behind a second click, the longer story. Nothing is
 * explained in terms of anything else on the page, and no word appears in an
 * explanation that is not a word somebody already had before they arrived —
 * no regions, no arity, no census, no Euler.
 *
 * "Is this room worth going into?" is answered by hovering it. A count on its
 * own does not settle that: forty people who last spoke in March is a
 * different room from four who are talking now. So hovering shows how busy it
 * is and what was said last.
 */

import { named } from '../lib/cluster.js';

/**
 * Written for somebody who has never seen this before and is not going to
 * read a manual. `short` is what they get for free; `more` is there for the
 * one in ten who wants to know why.
 */
export const HELP = {
  atlas: {
    title: 'Map',
    short:
      'Each shape is an interest. Where shapes overlap is a chat for people '
      + 'in both.',
    more:
      'Bigger shapes have more people. Click a spot to open its chat. Drag to '
      + 'move it, and scroll or pinch to zoom. In 3D, turn it with two fingers, or by '
      + 'dragging with the right mouse button. "Reset view" under View goes back. '
      + '"Expand" opens the map full screen. Right-click a chat — or hold a finger on '
      + 'it — for what else can be done with it, branching out into a community '
      + 'included.',
  },
  rooms: {
    title: 'Chats',
    short:
      'Every chat on the map, as a list. Select one to open it.',
    more:
      'The number is how many people are in it. Bold ones are chats you are '
      + 'in. The small squares show which interests it combines. Hover to see how busy '
      + 'it is and the last message.',
  },
  interests: {
    title: 'Interests',
    short:
      'What you have joined, related interests, and popular ones. Search to find '
      + 'anything else, or browse by category at the bottom of the list.',
    more:
      'Joining an interest puts you in its chat and in any chat it '
      + 'shares with your other interests. You can leave any time. Click the coloured '
      + 'square next to an interest to change its colour.',
  },
  funnel: {
    title: 'When I join, also join',
    short:
      'Interests can be very specific. This also puts you somewhere broader, so there '
      + 'are more people to find.',
    more:
      'If you join "Roman archaeology" and someone else joins "medieval archaeology", '
      + 'you never meet. Set this to "Its field" and you are both also in '
      + '"archaeology".',
  },
  minimap: {
    title: 'Minimap',
    short:
      'Every interest at once, small. Yours are the dark dots, and the dashed box '
      + 'marks where they are.',
    more:
      'Related interests sit near each other. It shows how much else there is and '
      + 'where you are in it. Press it to explore all of them.',
  },
  catalogue: {
    title: 'Pick from the full list',
    short:
      'Every interest there is, grouped under the big categories. Pick one to join it.',
    more:
      'Each category starts with itself, then its fields, then the interests in each '
      + 'field, indented further the more specific they are. The number is how many '
      + 'people are in it. Ones you have already joined are marked and cannot be '
      + 'picked again.',
  },
  relief: {
    title: 'Heights',
    short:
      'In 3D, each chat stands as tall as it has been busy lately, compared '
      + 'with the busiest on the whole site.',
    more:
      'Recent messages count the most: one from an hour ago counts half as much as '
      + 'one just now. Drag with one finger to move around. Drag with two fingers to '
      + 'turn it and tilt it and see behind tall ones, or drag with the right mouse '
      + 'button, or with Shift. Pinch or double-tap to zoom. Or switch 3D off for the '
      + 'flat map.',
  },
  explorer: {
    title: 'All interests',
    short:
      'Every interest there is, laid out by subject. Bigger dots have more people. '
      + 'Yours are outlined. Lines join interests people often hold together.',
    more:
      'Zoom in to see the names of fields, then of interests. Pick a dot to join it, '
      + 'or type a name to find one. A picked dot shows its own lines and lists what '
      + 'it is most often held with. A line needs at least two people holding both, '
      + 'so no line ever points to one person.',
  },
  alerts: {
    title: 'Desktop alerts',
    short:
      'Get a desktop notification when someone mentions you, or when a small '
      + 'chat you are in gets busy.',
    more:
      'You are not told about every message. Busy chats only show a count.',
  },
  hose: {
    title: 'Hose',
    short:
      'Everything said in the chats you are in, as it is said, newest first.',
    more:
      'The map says where conversations are and a chat says what is in one; '
      + 'this says whether anything is happening. Each line wears the same '
      + 'squares the map draws its chat with. View context opens that chat; '
      + 'Jump opens it at that message and lights it where it stands. Nothing '
      + 'is fetched for this \u2014 it is the messages that arrive anyway.',
  },
  profanity: {
    title: 'Profanity',
    short:
      'How much swearing to put up with from one person in a day before this '
      + 'browser mutes them for you.',
    more:
      'Ten a day, five a day, or none at all. Counted for each person '
      + 'separately and forgotten at the end of the day. At no tolerance the '
      + 'message is not shown at all, rather than folded away. Muting happens '
      + 'here and nowhere else: the server is never told, the person is not '
      + 'told, and you can undo any of it in this panel.',
  },
  stats: {
    title: 'Statistics',
    short:
      'Numbers about this place, worked out in your own browser from what this '
      + 'page can already see.',
    more:
      'Nothing is asked of the server for them: they come from the catalogue All '
      + 'interests is drawn from, the map in front of you, and what this browser '
      + 'keeps on its own disk. The working is shown beside the answers. What '
      + 'cannot be seen from here — the server’s disk, how many people there '
      + 'are, anything in a chat you are not in — is said rather than guessed.',
  },
  machines: {
    title: 'Made-up people',
    short:
      'Fills this server with made-up people holding made-up interests, so there '
      + 'is a map to look at before anybody else arrives.',
    more:
      'They are not people and they say nothing: nothing here posts on their '
      + 'behalf. Edit the number to change how many. Turning it off takes away '
      + 'exactly the ones it made and leaves everybody else alone. It is offered '
      + 'only where the server is somebody’s own machine, never on anything '
      + 'that looks like a deployment.',
  },
  fit: {
    title: 'Map accuracy',
    short:
      'Sizes on the map are to scale: twice the area means twice the people. This '
      + 'line says when the drawing could not get that exactly right.',
    more:
      'Some combinations cannot all be drawn at exact size at once. When that happens '
      + 'it says so here. It does not affect anything you can do.',
  },
  open: {
    title: 'This place is public',
    short:
      'Anything you send unencrypted can be read by anyone, not only the people in '
      + 'the chat. Anyone can download every chat.',
    more:
      'This is deliberate: it lets people search and build on what is here. Treat '
      + 'anything you post unencrypted as public. To keep a message to the people in '
      + 'the chat, tick Encrypt.',
  },
  privacy: {
    title: 'Encryption',
    short:
      'Encrypted messages are scrambled before they leave your browser, and only '
      + 'people in the chat can read them. Unencrypted messages are public.',
    more:
      'This is the only setting here that keeps anything private. It does not stop '
      + 'the people you send it to from copying it, and it does not hide who you are '
      + 'talking to or when. If a message cannot be encrypted, it is not sent.',
  },
  recording: {
    title: 'Keeping a copy',
    short:
      'Your browser keeps a copy of what is said here. The server deletes everything '
      + 'after 12 hours.',
    more:
      'This only affects your copy. Anyone can read this place and keep what they '
      + 'read, so assume anything said here has been saved by someone.',
  },
  layout: {
    title: 'Layout',
    short:
      'Drag the divider between the map and the chat to resize them. "Pop '
      + 'out" makes the map a window you can move and resize. Your browser remembers '
      + 'the layout.',
    more:
      '"Swap sides" moves the map to the other side. Drag the map window to either '
      + 'side of the screen to dock it there, or use its "Dock" buttons. "Reset" puts '
      + 'the map back on the left. The arrow keys move the divider, and move the map '
      + 'window from its title; with Shift they resize it.',
  },
  appearance: {
    title: 'Theme',
    short:
      'Change how this place looks: light or dark, its colours, its lettering and '
      + 'its corners. There are twenty themes to pick from.',
    more:
      'Your choice is saved in this browser and only you see it. "Match system" goes '
      + 'back to following your device.',
  },
  adjust: {
    title: 'Adjust',
    short:
      'Start from any theme and change it. Text stays easy to read wherever you put '
      + 'the sliders.',
    more:
      'You choose the colour and how strong it is; how light or dark each part ends '
      + 'up is worked out for you, so nothing can become too faint to read. What you '
      + 'make is kept as "Your own".',
  },
  colour: {
    title: 'Colours',
    short:
      'Each interest gets a colour from its name, so it stays the same. Click its '
      + 'square to choose a different one.',
    more:
      'Colours you choose are saved in this browser and only you see them. Useful '
      + 'when two interests look too similar.',
  },
  key: {
    title: 'Your key',
    short:
      'Anyone can type any name. The letters after yours come from a key only this '
      + 'browser has, so they cannot be faked.',
    more:
      'They show you are the same person as before, and they link everything you post '
      + 'under that key. There is no account behind it. "New key", under Settings, '
      + 'discards it: nothing can link you to the old one afterwards, and it cannot be '
      + 'recovered.',
  },
  deletion: {
    title: 'Deleting messages',
    short:
      'The server deletes messages after 12 hours and keeps a record of what it '
      + 'deleted. Check compares that record with what you deleted and what you kept.',
    more:
      'Each entry is linked to the one before it, so the record cannot be changed later '
      + 'without it showing. Encrypted messages are included: the record names their '
      + 'scrambled text, so only people who received a message can recognise it. The '
      + 'record cannot show that nobody else kept a copy.',
  },
  cluster: {
    title: 'Groups',
    short:
      'For the people around you. Create a group and they scan the code or open the '
      + 'link, and you are all in the same chat.',
    more:
      'Inside, everything is laid out as it is outside, with the same interests in the '
      + 'same places, and the map draws a line round the group. Interests you join there '
      + 'are only shared with people in it. Anyone with the name can join, and group '
      + 'names are listed publicly, so a group is easy to find. Messages inside are '
      + 'public unless encrypted.',
  },
  lurk: {
    title: 'Lurking',
    short:
      'You came in by a quick-join code, so you are watching this one chat '
      + 'without being part of it. The people in it see how many are lurking, never '
      + 'who, and nothing is saved on this device.',
    more:
      'No key is made or shown and no earlier visit is picked up, so this visit ties you '
      + 'to nothing. Encrypted messages stay locked: they are for the people in the '
      + 'chat. "Join in" makes you part of it so you can talk; "Look around" '
      + 'shows the rest of the place. Either one ends lurking, and this device '
      + 'goes back to keeping your key and name as usual.',
  },
  quickjoin: {
    title: 'Quick join',
    short:
      'A code for this chat. Whoever scans it can lurk in it straight away, '
      + 'reading along without joining anything.',
    more:
      'The chat shows how many are lurking, and nothing about who. '
      + 'That is no more than this place already allows, since unencrypted messages are '
      + 'public. They can join in whenever they like.',
  },
  muting: {
    title: 'Muting',
    short:
      'Muting someone folds their messages away, for you only. They are not told, and '
      + 'nobody else is affected.',
    more:
      'It follows their key, so it lasts for as long as they keep it. Someone without a '
      + 'key stays muted until you close the page. If someone uses profanity you are asked '
      + 'whether to mute them. Nothing is muted unless you say so, and you can stop being '
      + 'asked here.',
  },
  votes: {
    title: 'Votes',
    short:
      'Agree or disagree with a message. Press the same button again to undo.',
    more:
      'Votes are not reports. Disagreement does not get anyone moderated.',
  },
  reporting: {
    title: 'Reporting',
    short:
      'Every message from someone else has a "report" link. Use it for abuse, threats '
      + 'or other rule-breaking.',
    more:
      'You will be asked why. Nobody in the chat is told who reported. For an '
      + 'encrypted message, you are asked before its text is shown to a moderator.',
  },
  composer: {
    title: 'Posting',
    short:
      'Type a message and press Post. Everyone in this chat will see it.',
    more:
      'If the box is greyed out, either no chat is open or you have not '
      + 'joined all of its interests. The chat panel shows what to join.',
  },
  search: {
    title: 'Search',
    short:
      'Type to search interests. Press + to create one that does not exist yet.',
    more: null,
  },
  subjects: {
    title: 'Interests on the map',
    short:
      'How many interests the map shows at once. More shows more, but is harder to '
      + 'read.',
    more:
      'Above five the map gets crowded and shapes start to split. Three is clearest.',
  },
};

const NS = 'http://www.w3.org/2000/svg';

/**
 * Put an (i) beside everything that asked for one.
 *
 * A button rather than a `title` attribute: a native tooltip waits a second,
 * cannot be opened from a keyboard, and has nowhere to put a second paragraph.
 */
export function attachHelp(root, { onOpen } = {}) {
  // A Document has no ownerDocument; it is one.
  const doc = root.ownerDocument ?? root;
  for (const anchor of root.querySelectorAll('[data-help]')) {
    if (anchor.querySelector(':scope > .info')) continue;
    const entry = HELP[anchor.dataset.help];
    if (!entry) continue;

    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'info';
    button.textContent = 'i';
    button.setAttribute('aria-label', `Help: ${entry.title}`);
    button.addEventListener('click', (evt) => {
      evt.stopPropagation();
      onOpen?.(anchor.dataset.help, button);
    });
    anchor.append(button);
  }
}

/** When something happened, in words rather than a timestamp. */
export function when(at) {
  if (!at) return '';
  const ago = Math.max(0, Date.now() - at);
  const minutes = Math.round(ago / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/** How busy, said plainly. Nobody wants "0.4 messages per minute". */
export function busyness(stats) {
  if (!stats || !stats.messages) return 'nothing said here yet';
  const rate = stats.perMinute ?? 0;
  if (rate >= 3) return 'very busy right now';
  if (rate >= 1) return 'busy right now';
  if (rate > 0) return 'someone is talking';
  return 'quiet at the moment';
}

/**
 * One floating panel, reused. It carries either an explanation or a room's
 * activity, because two panels that can both be open at once is two panels
 * that will be.
 */
export function createCard(doc) {
  const card = doc.createElement('div');
  card.className = 'card';
  card.hidden = true;
  doc.body.append(card);

  let pinned = false;

  // A modal dialog lifts itself above the page and leaves everything outside
  // it underneath and inert — this card included, if it stays where it was
  // made. So it goes into whichever one is open, and home again when none is.
  const lift = () => {
    let modal = null;
    try {
      modal = doc.querySelector('dialog:modal');
    } catch {
      /* a selector engine that has not heard of `:modal` has no modals either */
    }
    const home = modal ?? doc.body;
    if (card.parentNode !== home) home.append(card);
  };

  const place = (near) => {
    lift();
    const box = near.getBoundingClientRect?.();
    if (!box) return;
    const width = 280;
    const left = Math.min(Math.max(8, box.left), (doc.documentElement?.clientWidth ?? 1200) - width - 8);
    const below = box.bottom + 8;
    card.style.left = `${left}px`;
    card.style.top = `${below}px`;
  };

  const heading = (text) => {
    const h = doc.createElement('strong');
    h.textContent = text;
    return h;
  };

  return {
    /** An explanation, with the longer version behind a second click. */
    explain(key, near) {
      const entry = HELP[key];
      if (!entry) return;
      card.textContent = '';
      card.append(heading(entry.title));

      const short = doc.createElement('p');
      short.textContent = entry.short;
      card.append(short);

      if (entry.more) {
        const more = doc.createElement('button');
        more.type = 'button';
        more.className = 'more';
        more.textContent = 'Tell me more';
        more.addEventListener('click', (evt) => {
          evt.stopPropagation();
          const extra = doc.createElement('p');
          extra.textContent = entry.more;
          more.replaceWith(extra);
        });
        card.append(more);
      }

      pinned = true;
      card.hidden = false;
      place(near);
    },

    /** What is going on in a room, for somebody deciding whether to go in. */
    room(room, near) {
      if (pinned) return;
      card.textContent = '';
      card.append(heading(named(room.subjects).join(' and ')));

      const who = doc.createElement('p');
      who.className = 'who';
      const people = `${room.population} ${room.population === 1 ? 'person' : 'people'}`;
      // And how many are lurking in it, when anybody is: a number, never who.
      const watching = room.lurkers ? ` · ${room.lurkers} lurking` : '';
      who.textContent = room.member
        ? `${people}${watching} · you are in this one`
        : `${people}${watching} · join to take part`;
      card.append(who);

      const stats = room.stats ?? { messages: room.messages ?? 0 };
      const activity = doc.createElement('p');
      activity.className = 'activity';
      activity.textContent = stats.messages
        ? `${busyness(stats)} · ${stats.messages} message${stats.messages === 1 ? '' : 's'} in all`
        : 'nothing said here yet';
      card.append(activity);

      if (stats.last) {
        const last = doc.createElement('p');
        last.className = 'last';
        const name = doc.createElement('strong');
        // A system message says so here as it does in the room.
        name.textContent = stats.last.machine
          ? `System message, as ${stats.last.author}: `
          : `${stats.last.author}: `;
        last.append(name, doc.createTextNode(stats.last.body));
        card.append(last);

        const ago = doc.createElement('p');
        ago.className = 'ago';
        ago.textContent = when(stats.last.at);
        card.append(ago);
      }

      card.hidden = false;
      place(near);
    },

    hide(force = false) {
      if (pinned && !force) return;
      pinned = false;
      card.hidden = true;
    },

    get pinned() {
      return pinned;
    },
    get element() {
      return card;
    },
  };
}

export { NS };
