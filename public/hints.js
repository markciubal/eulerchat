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

/**
 * Written for somebody who has never seen this before and is not going to
 * read a manual. `short` is what they get for free; `more` is there for the
 * one in ten who wants to know why.
 */
export const HELP = {
  atlas: {
    title: 'The map',
    short:
      'Each shape is an interest people are here to talk about. Where two shapes overlap, ' +
      'the part where they cross is its own conversation, for the people interested in both.',
    more:
      'Bigger shapes have more people in them, and so do bigger overlaps. Click anywhere ' +
      'to open the conversation for that spot. Scroll to zoom in — the labels write ' +
      'themselves out in full once there is room — drag to move around, and press ' +
      '"back to my interests" to return.',
  },
  rooms: {
    title: 'The conversations',
    short: 'Every conversation on the picture above, as a button. Click one to read it.',
    more:
      'The number beside each is how many people are in it. The ones in darker text are ' +
      'ones you have joined and can post in. Hover over any of them to see how busy it ' +
      'is and what was said last.',
  },
  interests: {
    title: 'Your interests',
    short:
      'What you have joined, what we think you might like, and the busiest places here. ' +
      'Search to find anything else.',
    more:
      'Joining an interest puts you in its conversation and in any conversation it shares ' +
      'with your other interests. You can leave again at any time and nothing is lost.',
  },
  funnel: {
    title: 'Joining wider',
    short:
      'Interests here can be quite specific. This also puts you somewhere broader, so ' +
      'there are more people to find.',
    more:
      'If you join "Roman archaeology" and somebody else joins "medieval archaeology", ' +
      'you will never bump into each other — you have not picked the same thing. Set this ' +
      'to "the field it is in" and you are both also in "archaeology", where you would.',
  },
  minimap: {
    title: 'Everything there is',
    short:
      'Every interest here at once, tiny. The dark dots are yours, and the dashed box ' +
      'shows the part of it you are in.',
    more:
      'Things near each other on this are related — all the sciences sit together, all ' +
      'the crafts sit together. It is here so you can see how much else there is, and ' +
      'roughly where you are among it.',
  },
  alerts: {
    title: 'Desktop alerts',
    short:
      'Let your computer tell you when somebody says your name, or when a small ' +
      'conversation you are in gets busy.',
    more:
      'You will not be told about every message. Busy places stay quiet and only show a ' +
      'number; you are only interrupted for something that is actually about you.',
  },
  fit: {
    title: 'About this picture',
    short:
      'The sizes here mean something: a circle twice the size has twice the people. This ' +
      'line says when the drawing could not quite manage that.',
    more:
      'Circles cannot always be arranged to get every size exactly right at once. When ' +
      'that happens this says so rather than quietly showing you something wrong. It ' +
      'does not affect anything you can do — you can ignore it.',
  },
  privacy: {
    title: 'Encrypting what you send',
    short:
      'Your messages are locked before they leave, with a different key each time, and ' +
      'only the people in the conversation can unlock them. The server passes them on ' +
      'without being able to read them.',
    more:
      'It does not stop the people you are talking to. They can read it — that is the ' +
      'point — and nothing can stop them keeping a copy. It also does not hide who you ' +
      'are talking to or when. What it does is make the server useless to anyone who ' +
      'breaks into it later.',
  },
  recording: {
    title: 'Keeping your own copy',
    short:
      'Your browser keeps what is said here, so you still have it after the server ' +
      'forgets. The server forgets everything after twelve hours.',
    more:
      'This is about your copy only. Everybody else chooses for themselves, and somebody ' +
      'who wants a record of a conversation will have one whatever you or we set — so ' +
      'treat anything you say here as something that can be kept.',
  },
  reporting: {
    title: 'Reporting a message',
    short:
      'Every message somebody else wrote has a small "report" next to it. Use it if '
      + 'something said here is abusive, threatening or otherwise wrong.',
    more:
      'You are asked what was wrong with it, which is what tells a moderator what to look '
      + 'for. Nobody in the conversation is told that you reported it. If a message was '
      + 'encrypted, reporting it shows that one message to a moderator and nothing else — '
      + 'you are asked first, because otherwise nobody could see what you are complaining '
      + 'about.',
  },
  composer: {
    title: 'Writing here',
    short: 'Type and press post. Everyone in this conversation will see it.',
    more:
      'If the box is greyed out, you have not joined all of the interests this ' +
      'conversation belongs to. Join them on the right and the box wakes up.',
  },
  search: {
    title: 'Finding an interest',
    short: 'Type a few letters to search. Press + to create one that is not here yet.',
    more: null,
  },
  subjects: {
    title: 'How many subjects to show',
    short: 'More subjects means more of the place at once, and a busier picture.',
    more:
      'Past five or so it gets hard to read and the shapes start to break up. Three is ' +
      'the clearest.',
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
    button.setAttribute('aria-label', `What is ${entry.title.toLowerCase()}?`);
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

  const place = (near) => {
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
      card.append(heading(room.subjects.join(' and ')));

      const who = doc.createElement('p');
      who.className = 'who';
      const people = `${room.population} ${room.population === 1 ? 'person' : 'people'}`;
      who.textContent = room.member
        ? `${people} · you are in this one`
        : `${people} · join to take part`;
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
        name.textContent = `${stats.last.author}: `;
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
