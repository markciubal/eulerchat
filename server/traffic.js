/**
 * Made-up traffic, for the demo: made-up people talking now and then, and
 * coming and going, so that the place can be watched moving and tried out
 * among others. Only ever started by `server/demo.js`, which refuses to run
 * anywhere that looks like a deployment; the server a deployment runs never
 * asks for it.
 *
 * Every word of it is a system message, marked as such on the message itself,
 * in its hash and in the open API, and the browser says so beside the name —
 * the same as the sample world's lines and the machine questions. Only the
 * made-up people ever say anything here: never a real person, online or not.
 *
 * How busy a room is follows three modes rather than one curve. Most rooms
 * are quiet, a word every hour or so; a good share are steady, every few
 * minutes; and a few are busy, twice a minute or more. A single skewed curve
 * gives a map where one room towers and everything else is flat; three modes
 * give the map what a real place has — a floor, a middle and a few peaks — and
 * the heights and the Chats list something to tell apart.
 */

import { parse, restrict, neighbourhood } from '../lib/regions.js';
import { clusterOf, named } from '../lib/cluster.js';
import { isPortalRoom } from '../lib/portal.js';
import { ask } from '../lib/questions.js';

/**
 * The three kinds of room, by how often somebody says something in one: the
 * share of rooms of each kind, and the time between words there, on average.
 * Each room is spread about its kind's average by up to a factor of two
 * either way, so the three are three humps and not three spikes.
 */
export const MODES = [
  { name: 'quiet', share: 0.62, every: 60 * 60_000 },
  { name: 'steady', share: 0.3, every: 4 * 60_000 },
  { name: 'busy', share: 0.08, every: 25_000 },
];

/**
 * For how long, after somebody real arrives, the rooms round them are busier,
 * and how much busier.
 */
export const ARRIVAL_FOR = 30_000;
export const ARRIVAL_BOOST = 6;

/** A number from a room's name, the same every time: its kind, and its spread. */
function hashOf(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/**
 * Which kind of room this is, and how many words a minute are said in it.
 * Worked out from the room's name alone, so a room is always the same kind
 * however often the demo is restarted, and nothing has to be kept per room.
 *
 * @param {string} room
 * @returns {{mode: string, perMinute: number}}
 */
export function paceOf(room) {
  const h = hashOf(room);
  let at = 0;
  let mode = MODES.at(-1);
  for (const m of MODES) {
    at += m.share;
    if (h < at) {
      mode = m;
      break;
    }
  }
  // A second, independent draw from the same name for where it sits in its
  // hump: a factor of two either way, evenly on a log scale.
  const spread = 2 ** (hashOf(`${room}\u0000spread`) * 2 - 1);
  return { mode: mode.name, perMinute: 60_000 / (mode.every * spread) };
}

/**
 * Whether a room is one made-up people talk in: the open world only. Never a
 * group — the people at a table did not ask for company — and never a portal,
 * which two people made for themselves.
 */
const open = (room) => !isPortalRoom(room) && parse(room).every((s) => clusterOf(s) === null);

/**
 * Pick from weighted things by where a number falls in their running total:
 * one division per pick, however many there are.
 */
function sampler(items, weightOf) {
  const kept = [];
  const totals = [];
  let total = 0;
  for (const item of items) {
    const w = weightOf(item);
    if (!(w > 0)) continue;
    total += w;
    kept.push(item);
    totals.push(total);
  }
  return {
    size: kept.length,
    total,
    pick(random) {
      if (!kept.length) return null;
      const x = random() * total;
      let lo = 0;
      let hi = totals.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (totals[mid] < x) lo = mid + 1;
        else hi = mid;
      }
      return kept[lo];
    },
  };
}

/** How many things happen in a stretch of time, for a rate: Poisson, by Knuth. */
function howMany(mean, random) {
  if (mean <= 0) return 0;
  if (mean > 30) return Math.max(0, Math.round(mean + Math.sqrt(mean) * gaussian(random)));
  const limit = Math.exp(-mean);
  let n = 0;
  let p = random();
  while (p > limit) {
    n += 1;
    p *= random();
  }
  return n;
}

function gaussian(random) {
  const u = Math.max(random(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

const LINES = [
  'been circling this one for a while and still no closer.',
  'anyone got a reading list for this?',
  'tried the obvious approach, it did not survive contact.',
  'the received wisdom here seems to be wrong and nobody says so.',
  'small breakthrough today, mostly by accident.',
  'what changed your mind about this?',
  'the two halves of this fit together better than people admit.',
  'starting over from the beginning, third time now.',
  'found an old notebook full of this and none of it makes sense to me now.',
  'is it just me or has this got harder to get into?',
  'somebody explain the appeal, I am halfway convinced.',
  'the best thing I read on this was a footnote.',
];

/** Short reactions, only ever to something actually said. */
export const REPLIES = [
  'agreed, mostly.',
  'not sure that holds up, but go on.',
  'same thing happened to me.',
  'that is the part nobody warns you about.',
  'have you tried going the other way round?',
  'this is the most useful thing said here all week.',
  'I think it depends what you are after.',
  'ha, yes.',
];

const ANSWERS = [
  'good question. I would start with the basics and see what sticks.',
  'that matches what I have seen.',
  'welcome! what got you into it?',
  'I had the same question when I started.',
  'depends — what are you hoping to get out of it?',
  'interesting, say more?',
];

/**
 * Start the made-up people talking, and coming and going, until stopped.
 *
 * @param {object} options
 * @param {import('./store.js').World} options.world
 * @param {(message: object) => void} options.deliver  hand a message to its room
 * @param {() => void} [options.changed]  say that who holds what has changed
 * @param {() => Iterable<string>} [options.present]  who is online: user ids
 * @param {number} [options.rate]  words a second across the whole place
 * @param {number} [options.near]  words a second in the rooms near whoever is online
 * @param {number} [options.churn]  joins and leaves a second
 * @param {number} [options.reply]  the chance a made-up person answers a real one
 * @param {number} [options.warm]  words said at once on starting, so nothing starts flat
 * @param {number} [options.tick]  milliseconds between rounds
 * @param {[number, number]} [options.answerAfter]  how long before an answer, at least and at most, in ms
 * @param {() => number} [options.random]
 */
export function startTraffic(options) {
  const {
    world,
    deliver,
    changed = () => {},
    present = () => [],
    rate = 2,
    near = 0.6,
    churn = 0.4,
    reply = 0.6,
    warm = 2000,
    tick = 250,
    answerAfter = [3000, 12000],
    random = Math.random,
  } = options;

  const synthetic = (userId) => world.profiles.get(userId)?.synthetic === true;
  const people = [...world.members.keys()].filter(synthetic);
  let stopped = false;
  let everywhere = null;
  let builtAt = 0;
  let nearby = null;
  let nearbyFor = '';
  let nearbyAt = 0;
  // Until when the rooms round whoever real is online are livelier than
  // usual; see `around`.
  let freshUntil = 0;
  const timers = new Set();

  const later = (ms, fn) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!stopped) fn();
    }, ms);
    timer.unref?.();
    timers.add(timer);
  };

  /**
   * Every room somebody made-up could talk in, weighted by its pace: rebuilt
   * now and then, as people come and go, since which rooms exist moves with
   * them. Two or more in it, so a room is never one made-up person talking to
   * themselves.
   */
  const rooms = () => {
    const at = Date.now();
    if (!everywhere || at - builtAt > 60_000) {
      const counts = world.census();
      const keys = [];
      for (const [room, n] of counts) if (n >= 2 && open(room)) keys.push(room);
      everywhere = sampler(keys, (room) => paceOf(room).perMinute);
      builtAt = at;
    }
    return everywhere;
  };

  /**
   * The rooms around whoever real is online, in two lots.
   *
   * `mine`: the rooms they are in, which are the only ones whose words reach
   * them. However quiet a room's kind, one somebody real is standing in is
   * spoken in at least as often as a steady one — a room they joined that
   * never said anything would be a demo of nothing.
   *
   * `near`: every occupied room among the dozen interests nearest what they
   * hold, which is what their map shows. Its words do not reach them, but its
   * heights do, in the same three kinds as everywhere else, so what they see
   * has a floor, a middle and peaks too.
   */
  const around = () => {
    const online = [...new Set(present())].filter((u) => world.members.has(u) && !synthetic(u)).sort();
    const at = Date.now();
    const signature = online.map((u) => `${u}:${[...world.subscription(u)].sort().join(',')}`).join('|');
    if (nearby && signature === nearbyFor && at - nearbyAt < 15_000) return nearby;
    // Somebody arrived, or took something up: for a little while the rooms
    // round them are busier, so what they see comes alive while they watch
    // rather than over the next hour.
    if (signature !== nearbyFor && online.length) freshUntil = at + ARRIVAL_FOR;
    const counts = world.census();
    const index = world.index();
    const near = new Set();
    const mine = new Set();
    for (const u of online) {
      const held = [...world.subscription(u)].filter((s) => clusterOf(s) === null);
      const { subjects } = neighbourhood(counts, held, 12, index, { allowed: (s) => clusterOf(s) === null });
      for (const [room, n] of restrict(counts, subjects)) if (n >= 2 && open(room)) near.add(room);
      for (const [room, n] of restrict(counts, held)) if (n >= 2 && open(room)) mine.add(room);
    }
    const steady = 60_000 / MODES.find((m) => m.name === 'steady').every;
    nearby = {
      near: sampler(near, (room) => paceOf(room).perMinute),
      mine: sampler(mine, (room) => Math.max(steady, paceOf(room).perMinute)),
    };
    nearbyFor = signature;
    nearbyAt = at;
    return nearby;
  };

  /** Somebody made-up in the room, who is not whoever it is answering. */
  const speakerIn = (subjects, not = null) => {
    const here = world.audienceFor(subjects).filter((u) => synthetic(u) && u !== not);
    return here.length ? here[Math.floor(random() * here.length)] : null;
  };

  /** One word in a room, from somebody made-up in it, labelled as a machine's. */
  const say = (room, { answering = null } = {}) => {
    const subjects = parse(room);
    const author = speakerIn(subjects, answering?.authorId ?? null);
    if (!author) return null;
    // What a reaction would be to: the latest thing actually said, among the
    // last few, and not another reaction — a thread of "agreed" answering
    // "agreed" is nobody talking.
    const target = (world.messages.get(room) ?? [])
      .slice(-6)
      .reverse()
      .find((m) => !REPLIES.includes(m.body) && Date.now() - m.at < 30 * 60_000);
    let body;
    let replyTo = null;
    if (answering) {
      body = random() < 0.35 ? ask(named(subjects), { random }) : ANSWERS[Math.floor(random() * ANSWERS.length)];
      replyTo = answering.id;
    } else {
      const roll = random();
      if (roll < 0.3 && target) {
        body = REPLIES[Math.floor(random() * REPLIES.length)];
        replyTo = target.id;
      } else if (roll < 0.55) {
        body = ask(named(subjects), { random });
      } else {
        body = LINES[Math.floor(random() * LINES.length)];
      }
    }
    try {
      const message = world.post(author, subjects, body, { machine: true, replyTo });
      deliver(message);
      return message;
    } catch {
      return null;
    }
  };

  /**
   * Somebody made-up takes something up or puts something down: a neighbour
   * of what they hold, or one of theirs let go, keeping between two and eight.
   */
  const comeAndGo = () => {
    if (!people.length) return false;
    const who = people[Math.floor(random() * people.length)];
    const held = [...world.subscription(who)];
    try {
      if (held.length > 2 && (held.length >= 8 || random() < 0.5)) {
        world.leave(who, held[Math.floor(random() * held.length)]);
        return true;
      }
      const index = world.index();
      const from = held[Math.floor(random() * held.length)];
      const next = [...(index.adjacency.get(from) ?? [])].filter((s) => clusterOf(s) === null && !held.includes(s));
      const pool = next.length ? next : index.popular.slice(0, 200);
      const choice = pool[Math.floor(random() * pool.length)];
      if (!choice || held.includes(choice)) return false;
      world.join(who, choice);
      return true;
    } catch {
      return false;
    }
  };

  // Something said everywhere at once to start with, in proportion to each
  // room's pace, so the map has its three kinds of height on the first look
  // rather than after an hour.
  for (let i = 0; i < warm; i++) {
    const room = rooms().pick(random);
    if (room) say(room);
  }

  let lastChanged = 0;
  let pendingChange = false;
  const round = () => {
    if (stopped) return;
    const seconds = tick / 1000;
    try {
      for (let n = howMany(rate * seconds, random); n > 0; n--) {
        const room = rooms().pick(random);
        if (room) say(room);
      }
      if (near > 0) {
        const local = around();
        // Half in the rooms they are in, where they hear it; half round
        // about, where they see it. Just after they arrive or take something
        // up, round about is much busier, so the heights come up while they
        // watch; their own rooms only twice as busy, so that what they hear is
        // still somebody now and then and not a flood.
        const fresh = Date.now() < freshUntil;
        const lots = [
          [local.mine, (near / 2) * (fresh ? 2 : 1)],
          [local.near, (near / 2) * (fresh ? ARRIVAL_BOOST : 1)],
        ];
        for (const [lot, pace] of lots) {
          for (let n = howMany(pace * seconds, random); n > 0; n--) {
            const room = lot.pick(random);
            if (room) say(room);
          }
        }
      }
      for (let n = howMany(churn * seconds, random); n > 0; n--) {
        if (comeAndGo()) pendingChange = true;
      }
      // Who holds what is told at most once a second, whatever the churn.
      if (pendingChange && Date.now() - lastChanged >= 1000) {
        pendingChange = false;
        lastChanged = Date.now();
        changed();
      }
    } catch {
      /* a round missed is nothing lost; the next one comes */
    }
    later(tick, round);
  };
  later(tick, round);

  return {
    /**
     * A real person said something: now and then somebody made-up in the
     * room answers, a few seconds later, the way a room with people in it
     * would. Never to a system message, which is nobody.
     */
    heard(message) {
      if (stopped || !message || message.machine || synthetic(message.authorId)) return;
      if (!open(message.room) || random() >= reply) return;
      const [soonest, latest] = answerAfter;
      later(soonest + random() * (latest - soonest), () => say(message.room, { answering: message }));
    },
    stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}

/**
 * What says this process is running somewhere real. The demo refuses to start
 * if any of these is set: a deployment should never have made-up people in it,
 * and the surest way to keep them out is for the demo to check where it is
 * rather than to trust whoever started it.
 */
const PRODUCTION = [
  ['NODE_ENV', (v) => v === 'production', 'NODE_ENV is production'],
  ['DYNO', Boolean, 'running on a Heroku dyno'],
  ['RENDER', Boolean, 'running on Render'],
  ['FLY_APP_NAME', Boolean, 'running on Fly.io'],
  ['RAILWAY_ENVIRONMENT', Boolean, 'running on Railway'],
  ['VERCEL', Boolean, 'running on Vercel'],
  ['K_SERVICE', Boolean, 'running on Cloud Run'],
  ['AWS_EXECUTION_ENV', Boolean, 'running on AWS'],
  ['WEBSITE_SITE_NAME', Boolean, 'running on Azure App Service'],
  ['KUBERNETES_SERVICE_HOST', Boolean, 'running in Kubernetes'],
];

/**
 * Why this looks like production, if it does.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}  reasons; none when it looks like somebody's own machine
 */
export function productionSigns(env = process.env) {
  return PRODUCTION.filter(([name, test]) => env[name] !== undefined && test(env[name])).map(([, , why]) => why);
}
