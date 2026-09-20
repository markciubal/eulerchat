# eulerchat

A chat room shaped like an Euler diagram. Subjects are regions on a plane, the
places where they overlap are rooms, and a coordinate is an address.

```
npm i eulerchat      # the layout engine, or
npx eulerchat        # the chat server
```

The layout engine stands on its own and has no server or DOM in it, so it will
draw area-proportional Euler diagrams for anything; the chat app is one caller.

```js
import { census, layout, zones, atlas } from 'eulerchat';
```

```
npm install
npm start          # http://localhost:8787 — three hand-written subjects
npm run start:large # 1000 interests, 4000 people
npm test

node server/index.js --interests 300 --people 2000
```

## Using it in your own project

Three independent pieces, each usable without the others. Typed, ESM, and the
library half has no dependencies at all.

### Draw a diagram

```js
import { census, layout, toSVG } from 'eulerchat';

const people = [
  new Set(['art']), new Set(['art', 'philosophy']), new Set(['philosophy']),
];

const svg = toSVG(layout(census(people)), { title: 'interests' });
```

`toSVG` returns a standalone SVG string — no DOM, no stylesheet, styles
inlined — so it can go to a file, an `<img>`, an HTTP response or a
rasteriser. `census` counts by containment (a region's population is everyone
holding *all* of its subjects), which is what circle areas mean.

For more than three subjects, or any zone arity, use the atlas. It needs
exclusive counts, so `zones` rather than `census`:

```js
import { zones, atlas, toSVG } from 'eulerchat';

const map = atlas(zones(people, ['art', 'philosophy', 'music']));
map.report.exact;        // no region drawn that nobody occupies, none lost
map.report.disconnected; // subjects that ended up in more than one patch

toSVG(map, { theme: 'dark', size: 1200 });
```

Both layouts report what they could not do. `layout(...).fit` carries
`faithful`, `phantoms`, `worst` and a per-region breakdown; `atlas(...).report`
carries `exact`, `wellFormed` and `worstSplit`. Neither is ever silently wrong.

### Use the routing without the drawing

The delivery rule is one pure predicate, and the census is a plain `Map`:

```js
import { receives, census, neighbourhood } from 'eulerchat';

receives(['art', 'philosophy'], ['art']);              // true
receives(['art'], ['art', 'philosophy']);              // false
neighbourhood(census(people), ['art'], 3);             // what to show someone
```

### Notifications

Delivery and notification are different questions. `T ⊆ S` settles which
messages *reach* you, and in a busy subject that is a great many. Which of
them deserve your attention is answered by the shape of the room:

| Room | Reaches | |
|---|---|---|
| `art` | everyone holding art | you are one of a crowd — counted, not shown |
| `art+philosophy` | only people holding both | narrower, more specific — badged |
| a room of two | almost only you | nearly a direct message — interrupts |

Narrow rooms are loud and broad rooms are quiet, which is the opposite of
what message volume alone would give you. Being named always interrupts;
the room you are currently reading never does.

```js
import { classify } from 'eulerchat';

classify(event, {
  userId, name, subscription,
  intimate: 8,        // at or below this many people, a room is conspicuous
  muted: ['art'],
  viewing: 'art+philosophy',   // what they are reading does not interrupt them
});
// -> { kind, level: 'quiet' | 'notify' | 'alert', room, title, body } | null
```

It returns `null` for anything in a room the watcher could not already read.
That rule is the one worth keeping whatever else is tuned: a notification must
never reveal a conversation somebody is not part of.

**Two events no flat chat model has.** Rooms here are derived from membership,
so they genuinely come into and go out of existence — and the incremental
census knows the exact moment a region key is created or destroyed:

```
"art ∩ music ∩ philosophy now exists"
 Nobody held all of these before. You are the only one here so far.
```

Subscribe to them, on the world itself, with no transport attached:

```js
const stop = world.watch((event) => {
  // { type: 'message' | 'room-opened' | 'room-closed', room, ... }
});
```

`Notifications` in `eulerchat/app` wires those to per-person preferences,
unread counts and a backlog for people who are away. A listener returning
false means undelivered, and it is held until they reconnect:

```js
import { Notifications } from 'eulerchat/app';

const notes = new Notifications(world);
notes.onNotify((userId, note) => myPushService.send(userId, note));
notes.drain(userId);   // what they missed, most urgent first
```


### Mount the chat server in an app you already have

```js
import { createEulerChat, World, seed } from 'eulerchat/app';

const chat = createEulerChat({
  world: seed(new World()),   // or your own, built with addSubject/addUser/join
  server: myHttpServer,       // attaches to yours; omit to get its own
  mount: '/chat',             // lives under a path; omit for the root
  serveClient: true,          // also serve the bundled UI
});

chat.world;     // membership, messages, diagramFor(), atlasFor()
chat.sessions;  // who is connected, and on what
chat.close();
```

### Or bring your own transport

The `World` holds no connections. Delivery is a question about membership, and
it answers with people:

```js
const audience = world.audienceFor(['art', 'philosophy']);  // user ids
```

Where those people currently are is a separate concern, and `Sessions` is one
answer to it — but anything will do, because nothing in the world requires a
socket:

```js
import { Sessions } from 'eulerchat/app';

const live = new Sessions();          // generic over whatever a connection is
live.open('s1', userId, myChannel);
for (const s of live.reaching(audience)) s.socket.send(payload);
```

One person may hold several connections at once — two tabs, a phone and a
laptop — and `forUser`, `present` and `reaching` are all written for that.

Importing this does not bind a port or read `process.argv`. The CLI
(`npx eulerchat`) is a thin wrapper that adds those and a crash reporter.

It answers for its own paths and stays silent on everything else, so your
routes are untouched — and it takes first refusal on them, because a host that
ends its routing with a catch-all 404 would otherwise reply before this ever
ran. If you would rather place it yourself, behind your own middleware, pass
`serveClient: false` and call `chat.handleRequest` wherever you like.

There are four worked examples in `examples/`: drawing a diagram from set data
with no server at all, adding the rooms to an app you already have, driving the
rooms over your own transport, and building an atlas.

### Subpaths

| import | what |
|---|---|
| `eulerchat` | everything below, re-exported |
| `eulerchat/regions` | region algebra: `census`, `zones`, `receives`, `neighbourhood` |
| `eulerchat/euler` | circle layout: `layout`, `lensArea`, `separation` |
| `eulerchat/atlas` | routed layout: `atlas` |
| `eulerchat/svg` | `toSVG` |
| `eulerchat/notify` | `classify`, `mentions` — what is worth interrupting for |
| `eulerchat/taxonomy` | `radialLayout`, `anchorsFor` — where subjects sit |
| `eulerchat/knowledge` | a small default hierarchy |
| `eulerchat/mold` | `Mold`, `weave` — what grows between them |
| `eulerchat/abbrev` | `shortLabels`, `abbreviate` — naming the overlaps |
| `eulerchat/knowledge` | the bundled hierarchy, and `subfields()` |
| `eulerchat/adapt` | `fromRows` — read the tables you already have |
| `eulerchat/embed` | `mountMap`, `viewFor` — the map in an element you own |
| `eulerchat/react` | `<EulerMap />` |
| `eulerchat/app` | `createEulerChat` |
| `eulerchat/store` | `World`, `seed` |


## The two decisions everything else follows from

### 1. Delivery is containment, not partition

A message tagged with a set of subjects **T** reaches every reader whose
subscription **S** satisfies `T ⊆ S`.

The tempting alternative is to treat each Venn region as a sealed room: a post
in the art-only lune goes only to people who are in art and *not* philosophy.
That is backwards. The person who loves both is the most engaged reader you
have, and strict lunes hide half the platform from them. Containment means:

| Post in | Reaches |
|---|---|
| `art` | everyone in art, including the art+philosophy crowd |
| `art+philosophy` | only people holding both, because it assumes both contexts |

Nobody is structurally hidden from anybody, and a subscriber to *n* subjects
sees exactly `2ⁿ − 1` rooms. See `receives()` in [lib/regions.js](lib/regions.js).

A single subject is a room like any other — hold one interest and you can talk
in it with everyone else who holds it, overlap or no overlap. Two consequences
follow, and both are load-bearing:

- **The lit area on the map is the audience.** Regions are *drawn* exclusively
  (the fill for `art` is art minus everything else) but *routed* by
  containment, so selecting `art` lights the whole art circle rather than the
  art-only sliver. The same `receives` predicate decides both, so the picture
  cannot promise an audience the router will not deliver.
- **Every room is listed, not only clicked.** A room whose exclusive area is
  covered over by its neighbours has no ground to click, which happens most
  often to single-subject rooms since those are what the overlaps eat into.
  The chips under the diagram reach every room regardless of geometry.

### 2. Euler, not Venn

A Venn diagram insists every intersection exists. An Euler diagram draws only
the non-empty ones. Real subject spaces are Euler-shaped — most combinations of
subjects have nobody in them — and a Venn build would manufacture `2ⁿ − 1`
rooms, nearly all of them dead. Empty rooms are what kill chat platforms, and
exponentially many empty rooms kill them faster.

So regions are derived from membership rather than enumerated from the
catalogue. A region nobody occupies never acquires a key, is never drawn, and
cannot be walked into. In the seeded world nobody holds both music and
philosophy, so `music+philosophy` does not exist — not empty, *absent*. Join
both and it comes into being.

## Positions are derived, never authored

If someone places the circles by hand the map lies: two circles can visually
overlap while sharing no members. Instead:

- a circle's **area** is its population
- a lens **area** is the shared membership of those two subjects
- positions are solved from the census, deterministically — the same census
  always produces the same picture

So the diagram is a live picture of the social graph, and adjacency means
something. That is also the discovery mechanism: a circle you are not in is
visible precisely because it overlaps one you are.

## The diagram reports its own dishonesty

Three circles give you three distances. Those three distances fix three
pairwise overlaps **and** the triple intersection — four quantities from three
knobs, so something must be wrong. Left alone, a spring solver satisfies the
pairs perfectly and dumps the entire error on the triple, which is the worst
possible outcome: the triple is the region this product exists for. Measured on
a symmetric three-subject world, that is a **39%** overshoot.

`layout()` re-solves for least total relative error instead, trading a few
percent on each pair to pull the triple back to ~13%, and then audits every
region by sampling and reports what it could not achieve:

```js
fit.regions   // every region: true population vs drawn area, worst first
fit.worst     // the region the picture is least honest about
fit.faithful  // false when any region is materially misdrawn
fit.drawable  // false past three circles
```

The UI prints this under the diagram. A picture that cannot be accurate says so.

## Nobody sees more than three circles

Four sets cannot be drawn as a Venn diagram with circles. This is a geometric
fact, not a rendering budget — ellipses reach five, and arbitrary closed curves
manage any number at the cost of looking like nothing at all. Rather than
degrade past that point, each person gets their own local view: the subjects
they hold, plus the neighbouring subjects that share the most members with
them, capped at three. Region arity is capped to match, so every room that
exists is a room that can be drawn.

### Circles are the reason for the residual error

Three circles give three distances, and three distances have to satisfy three
pairwise overlaps *and* the triple — four targets, three knobs. The leftover
shows up as the few percent `fit` reports.

An ellipse adds an aspect ratio and a rotation, which is enough freedom to
satisfy everything. Measured against the same three worlds:

| world | circles | ellipses | aspect needed |
|---|---|---|---|
| symmetric, small triple | 11.9% | 0.7% | 1.34 |
| symmetric, fat triple | 6.6% | 0.4% | 1.25 |
| lopsided | 2.1% | 0.9% | 1.05 |

The last column is the surprise: allowed aspect ratios up to 3.0, the solver
never wanted more than 1.34. Accuracy does not cost roundness — a 5–34%
ovalling is barely visible and removes nearly all the error.

Not yet adopted, because it is not free. Circle pairs have a closed-form lens
area, which is what makes the audit nearly instant; ellipse pairs have no such
formula, so every region would go back to being sampled. The solver would need
re-tuning against the same budget before this is a straight win.

### Circles get the regions wrong too, not just their sizes

Sizing is the smaller problem. A convex shape cannot always produce *exactly*
the set of regions the data calls for, and it fails in both directions.
Measured over 400 real views of the 1000-interest world:

| | |
|---|---|
| views where a region is drawn that nobody occupies | 5.7% |
| triple rooms drawn too small to click (<20px²) | 22.0% |
| triple rooms drawn as a speck (<300px²) | 24.9% |
| triple rooms drawn well (within 25%) | 33.6% |

Three circles overlapping pairwise tend to share a common patch whether or not
anyone holds all three — and when the overlaps are large, avoiding it is not
merely hard but geometrically impossible. `fit.phantoms` reports any such
region, and their presence makes a diagram unfaithful; removal is attempted but
only kept when it costs no accuracy, because a solver told to remove an
unavoidable phantom will flatten every area in the diagram trying.

Note the second half of that table is a *dynamic range* problem, not a shape
problem. The rooms that come out as specks almost all hold one person, inside
circles holding thirty to ninety. No choice of outline fixes that: a region
carved out big enough to click would no longer have an area proportional to its
population. Flexible boundaries would fix which regions exist; they would not
fix one person being a thousandth of the picture.

## Scale

Measured on a synthetic world of 1000 interests and 4000 people (45,683
occupied regions), which is what `npm run start:large` builds:

| | |
|---|---|
| building a view (`diagramFor`) | 3.7ms median, 6.1ms p95 |
| join round-trip, over a socket | 15.6ms median |
| broadcast after a join, 1000 sessions | 122ms, 27 of 1000 redrawn |
| people whose view contains an overlap room | 100% |

Three things make that hold, and all three are the same idea applied at a
different layer — **never touch the whole world to answer a local question**:

1. **The solver never sees more than three circles.** Because each person is
   projected to their own neighbourhood, the cost of a view is bounded by the
   view rather than by the catalogue. This is the load-bearing claim: a view
   costs about the same at a thousand interests as at three.
2. **A join updates the census in place.** Rebuilding meant re-expanding 4000
   people into 45,683 regions because one person clicked join — about 300ms.
   Joining a subject can only affect regions containing that subject, of which
   there are a handful. That alone took a join from ~300ms to ~15ms.
3. **A session is only redrawn when its own picture moves.** Someone joining an
   obscure interest cannot change a diagram that does not contain it, so each
   session is asked a cheap question first and only the few that answer yes pay
   for a solve. At 1000 sessions a join redraws 27 of them.

The rail follows the same rule: it lists what you hold, what is being suggested
and a few busy rooms, never the catalogue. A thousand rows rebuilt on every
push is the same mistake as a thousand-circle diagram.

### What the numbers do not cover

**First paint is still linear.** A thousand sessions connecting at once costs
~3.3s of solving, because each one is a genuinely different neighbourhood and
the cache cannot help (398 distinct views per 400 people). Spread over real
arrivals this is ~4ms each and invisible; as a thundering herd after a restart
it is not. Solving off the event loop would fix it.

**Density is a product assumption, not a guarantee.** The 100% figure above
holds because the generator clusters people into themes. Spread the same 4000
people uniformly over 1000 interests and essentially no pair would share a
member — every circle drawn disjoint, no overlap rooms, and the product has
nothing to offer. Whether a real population clusters is the question the
prototype cannot answer.

## Layout

```
lib/index.js      the public API (`import { layout, atlas } from 'eulerchat'`)
lib/regions.js    region algebra — addresses, containment, census, zones
lib/euler.js      circle solver, refinement, and the honesty audit
lib/atlas.js      routed-boundary layout: growth, tracing, smoothing
server/store.js   world state, the T ⊆ S routing rule, incremental census
server/populate.js synthetic worlds at scale
server/index.js   static files + WebSocket
public/diagram.js circle rendering and the coordinate → room lookup
public/atlasview.js atlas rendering and its point-in-territory lookup
public/app.js     state and wiring
```

`lib/` is served to the browser as well as imported by the server, so the
client and server share one definition of what a region address is.

## Embedding it: point at your data

The chat server is one way in and not the interesting one for most callers. If
you already know who your people are and what they are interested in — a users
table, a join table, a GraphQL response — you can have the map without a
connection, a poll or an adapter layer.

```jsx
import { EulerMap } from 'eulerchat/react';

<EulerMap
  users={db.users}              // [{ id, username, novelty }]
  interests={db.userInterests}  // [{ user_id, interest }]
  focus={currentUser.id}
  onSelectRoom={(room) => open(room.key)}
/>
```

That is the whole integration. Column names are guessed (`id`/`user_id`,
`username`/`name`/`handle`, `interest`/`subject`/`tag`), and named when they
cannot be:

```jsx
<EulerMap users={rows} columns={{ id: 'uuid', name: 'profile.displayName', subjects: 'tags' }} />
```

Interests may hang off the person as an array or a comma-separated column
instead of living in their own table. Subject names are normalised on the way
in, so `theory of entomology` and `modern entomology` do not become two rooms.

React is an **optional** peer dependency. Nothing else in the package imports
it, and `mountMap(element, options)` is the same thing without a framework:

```js
import { mountMap } from 'eulerchat/embed';
const map = mountMap(element, { users, interests, focus: userId });
map.update({ view: 'atlas' });
map.destroy();
```

Or `viewFor(data, { focus })` for the numbers with nothing drawn.

### Steering what people are shown

A `novelty` column decides which way somebody gets pushed when the map
suggests a subject they do not hold. At 0 it offers the nearest neighbour —
the subject most of their people already share, which is the one they were
most likely to find unaided. At 1 it prefers a subject reachable *through*
people but far away in the hierarchy, which is what a new community looks like
from the inside.

Stored as a fraction or a percentage, either is read. Left out entirely,
people get the middle rather than an extreme.

```
entomologist, novelty 0.0  ->  mycology   (same field, strongest overlap)
entomologist, novelty 1.0  ->  poetry     (different division, but bridged)
```

The crossover is around 0.53 for that pair: reaching across the map has to be
worth more than a strong neighbour before it wins, which is the behaviour you
want from a dial rather than a switch.


## Where subjects sit, and what grows between them

The atlas originally placed subjects by shared membership alone. That is
honest about the community and useless as a map: topology and geometry are
drawn as strangers until somebody happens to hold both, a brand new subject
has no position at all, and every coordinate shifts as people come and go.

Three layers now, each doing one job:

| | decides | from |
|---|---|---|
| **taxonomy** | where subjects *sit* | a knowledge hierarchy, before anyone joins |
| **mould** | which way the ground *runs* between them | agents, fed by who bridges what |
| **quotas** | how much ground each zone *gets* | population — exactly, as before |

Only the first two are new, and neither touches the third, which is why the
map can take an organic shape without giving up the exactness the atlas exists
for.

### A hierarchy anchors the map

```js
import { radialLayout, anchorsFor, knowledge, atlas, zones } from 'eulerchat';

const where = radialLayout(knowledge);          // or your own `child: parent`
const anchors = anchorsFor(subjects, where);
atlas(zones(people, subjects), { anchors });
```

The bundled hierarchy is three layers of academic fields of study: six or so
divisions, the fields within them, and beneath those the subfields — and it is
the subfields people join. Somebody joins `entomology`, not `biology`; the
field above it is there to say where entomology *is*, so that it sits beside
mycology and nowhere near topology before a single person has joined either.

### The funnel: joining narrow without being alone

A catalogue of two hundred subfields is finer-grained than most communities
are large. The person in entomology and the person in mycology share nothing
at all as far as the rooms are concerned — which is true of their subjects and
false of them, and the reason they never meet.

So a join can carry upward:

```js
world.setFunnel(userId, 1);        // 0 = just this, 1 = + its field, 2 = + its division
world.join(userId, 'entomology');  // -> entomology, biology
```

Both now hold `biology` and have somewhere to find each other, without either
having to claim their real interest is something broader than it is. Their own
rooms are untouched — widening adds, it does not replace — and the broader
room is created if the catalogue has not got it yet, because a funnel that
quietly does nothing whenever the field happens to be missing is worse than no
funnel. It never reaches the root: a room containing everybody is not a room.

### Hobbies, not only fields

The taxonomy is academic in structure and not in content. Hobbies are the
largest division in it — handcraft, cooking, games, outdoors, growing,
movement, tinkering, collections, playing music, writing — because a catalogue
that only admits scholarship has nothing to offer somebody who came for bread
and bicycles. Same three layers, so a hobby funnels upward exactly as a
subfield does.

### A facet is not a different subject

`theory of entomology`, `modern entomology` and `field entomology` are
entomology. Three rooms for one small community is fragmentation nobody would
defend if asked directly, so `addSubject` normalises:

```js
world.addSubject('theory of entomology');   // -> 'entomology'
world.addSubject('history of jazz');        // -> 'jazz'
world.addSubject('theory of everything');   // -> unchanged
world.addSubject('field theory');           // -> unchanged
```

A facet is only stripped when what remains is a subject the hierarchy actually
knows, and that restraint is the whole safety of it — a rule that stripped
unconditionally would quietly rename things nobody meant to rename.

Laid out radially — siblings adjacent, unrelated branches apart — and
deterministic. Names it does not know are left unanchored and placed by
co-membership as before; a facet like `modern jazz` resolves to `jazz`, so a
real catalogue anchors without anyone curating every phrasing. Cycles are
tolerated, because a hierarchy baked out of Wikipedia will have them.

What this buys, measured by churning a population and seeing how far subjects
move on a map 1000 units across:

| | mean drift | worst |
|---|---|---|
| membership only | 444 | 589 |
| anchored to a hierarchy | **40** | **68** |

Eleven times steadier. That is the difference between a map that breathes and
one that rearranges itself around whoever is currently online — the objection
that made the atlas a snapshot rather than a surface.

### A mould weaves the routes

```js
atlas(counts, { anchors, mold: true });   // or { mold: { generations, agents } }
```

Subjects are food; the people holding two subjects are the traffic between
them. Agents shuttle along their own pair, deposit, sense and turn, and the
field diffuses and decays — so the routes people actually bridge get trodden
into existence and the rest fade. `atlas(...).network` reports what it joined.

It is not free, and the defaults are not the textbook ones. With the values a
general Physarum model uses, agents merge into a single mass governed by the
geometry, and the network that emerges came out **anti-correlated** with the
co-membership it was supposed to be tracing. Two things fix it: agents that
keep their pair for good rather than merely starting on it, and connectivity
measured by widest path rather than along the straight line between two
subjects — a mould route bends by nature, and a chord probe scores a perfectly
good curved channel at zero.

Correlation between channel strength and people bridging a pair, across four
populations, three never used for tuning: **0.69, 0.97, 0.42, 1.00**.


### Everything is on the map, and you are somewhere on it

A view can only draw a handful of subjects legibly, which leaves someone with
no idea what else exists or whereabouts they are among it. So the view is a
neighbourhood and the minimap is the whole thing:

```js
world.overview();   // every occupied subject at its place in the hierarchy
```

Subjects the hierarchy has never heard of are not dropped — they go on an
outer ring, which then reads as exactly what it is, everything not yet
classified. Facets of one subject would otherwise stack invisibly on top of
it (`modern painting`, `early painting` and `field painting` all resolving to
`painting`), so each cluster is fanned into a small constellation: on a
catalogue of 600, 599 distinct positions.

The atlas itself opens framed on the subjects you hold, with exactly 20px of
margin. Padding in pixels cannot simply be added to a viewBox — the viewBox is
in user units and the scale between them is the thing being solved for, so
widening the box to make room shrinks the very margin it widened for.
`fitTo` solves for the scale first.

### The overlaps are labelled

The overlaps are the most interesting ground on the map and were the only part
left unnamed, because the full names do not fit where subjects meet. Initials
do — each shortened only as far as it can be without becoming ambiguous among
what is on screen:

| on screen | labels |
|---|---|
| music, philosophy, math | `mu`, `p`, `ma` — `p` is unique alone, `m` is not |
| + mathematics | `mu`, `p`, `math`, `mathe` |
| amateur running, amateur go | `ar`, `ag` — a phrase gives its initials |

So an overlap reads `mu + p + ma`, and hovering gives the full names and how
many people are there.

The atlas pans and zooms, and the short forms are not permanent: they exist
only because the full names do not fit, so once there is room the real name is
what appears. Two things make that work. Labels hold a constant size on
*screen*, which means their size in map units shrinks as the map grows under
them — without that they would scale with everything else and never fit any
better. And "does it fit" is asked against the room the zone actually has,
which the layout already worked out when it decided where to put the label:
the distance transform that finds the deepest point knows how deep it is, and
that depth is the radius of the largest circle the zone will hold. Labels sit at the deepest point of the zone's own
ground rather than at the seed it grew from, which after growth can be
somewhere else entirely.

```js
import { shortLabels, abbreviate } from 'eulerchat';
abbreviate(['music', 'philosophy', 'math'], shortLabels(subjects));  // 'mu + p + ma'
```


## Two views, two bargains

The map and the atlas answer the same question with opposite trade-offs, and
both are in the UI because neither dominates.

| | **map** (circles) | **atlas** (routed boundaries) |
|---|---|---|
| subjects at once | 3 | any; legible to about 5 |
| zone arity | 3 | any — a six-subject zone draws fine |
| regions drawn that nobody occupies | 5.7% of views | none, by construction |
| rooms too small to click | 22% of three-way rooms | none, by construction |
| area error | a few %, sometimes 12% | ~1% |
| stability | continuous — a join nudges a radius | regrown; a different population grows differently |
| cost | ~4ms, per viewer, live | ~180ms, on request |

The atlas exists because convex shapes cannot produce an arbitrary set of
regions. Three circles overlapping pairwise share a common patch whether or not
anyone holds all three, and at realistic overlaps avoiding it is not merely
hard but geometrically impossible. So the atlas stops drawing shapes and
intersecting them, and instead gives every zone its ground first — grown
outward from a seed until it holds its share — then traces the outline of each
subject's territory afterwards. Exactness is then a property of the
construction rather than something a solver fits toward.

What it gives up is continuity. The boundaries come out of a growth process, so
a small change in the population does not make a small change in the picture —
which destroys the spatial memory a live map depends on, and is why the map is
still the thing you sit in and the atlas is something you ask for.

**Where it stops working.** Legibility, not accuracy, is the limit:

| subjects | rooms | subjects split across patches | verdict |
|---|---|---|---|
| 3 | 7 | 0 | clean |
| 4 | 14 | 2 | workable |
| 5 | 20 | 4 | cluttered |
| 6 | 30 | 6 | fragmented |
| 8 | 41 | 8 | fragmented |

Those verdicts come from looking at renders (`npm run render`), not from the
numbers. Five was called readable until somebody looked at it: the big
territories are fine but the middle fills with slivers, and a subject arriving
in three pieces reads as three subjects that happen to share a colour.

Areas stay exact at every size; what degrades is that a subject's territory
arrives in several pieces instead of one. That is the known hard part of Euler
layout — realising an arbitrary region structure with every subject connected
is not always possible at all — and it does not respond to more space or a
finer grid, so it is reported (`report.disconnected`, `report.worstSplit`)
rather than papered over. The default is five.

## Deploying

There is a `Procfile` and the port comes from `process.env.PORT`, so it boots
on a single dyno. Memory is not the constraint — a world of 1000 interests and
50,000 people is 36.5MB of heap, a connected session about 4.8KB, and a diagram
push 3.1KB on the wire. A 512MB dyno has room to spare.

What it does **not** survive is being scaled out:

- **Two dynos are two separate chat rooms.** All state is one in-memory
  `World`, so `ps:scale web=2` splits the population in half with no error and
  no symptom beyond people not hearing each other. This is the blocker, and it
  is the only one that needs architecture rather than code.
- **A dyno restart empties the world.** Heroku cycles dynos at least daily, and
  every deploy does the same. Every message and membership is gone.
- **Solving blocks the event loop.** Layouts run on the main thread, so a burst
  of first paints stalls all other traffic — worse on a shared-CPU dyno than on
  a laptop.
- **One long run ended in an unexplained exit.** A server left up for hours
  exited with code 1 and left no stack behind, and the cause is still not
  known. The obvious gaps were closed afterwards — sockets, the socket server
  and the HTTP server all have error listeners now, and the heartbeat skips
  anything not open — but none of those reproduce it, so the fix is unproven.
  What was certainly missing was the evidence: uncaught exceptions and
  rejections now print a stack and the session counts before exiting.

Idle timeouts are handled: the server pings every 25s, inside Heroku's 55s
cutoff, and the client reconnects with backoff and resumes its identity and
memberships within a 60s grace window.

### What sharing state would take

The pure algebra in `lib/` is already independent of where state lives; only
`World` would be replaced.

- **Census → Redis hash.** `#touch` already does nothing but increment and
  decrement a handful of counters per join, and deletes on zero. That is
  `HINCRBY` plus a conditional `HDEL`, and the Euler property survives the
  translation unchanged.
- **Fan-out → Redis pub/sub.** Publish per subject; each dyno subscribes to the
  subjects its own connections hold and applies `T ⊆ S` locally.
- **Layout cache → Redis, keyed by `censusSignature`.** The key already exists
  and is already content-addressed, so it is shareable as-is.
- **Messages and memberships → Postgres**, with Redis as the hot index.

## Known limits

- **State is in memory.** Restarting resets the world.
- **Solving blocks the event loop.** Every layout runs on the main thread, so a
  burst of first paints stalls all other traffic. Fine at prototype
  concurrency, not at a thundering herd.
- **Abuse is bounded, not solved.** A subscription is capped at 32 because the
  census enumerates subsets up to arity three and is therefore cubic in what
  one person holds — uncapped, a single client holding 300 subjects built 4.5
  million regions and pushed *everyone's* view past a second. The catalogue is
  capped, and each connection gets a leaky bucket priced by how expensive each
  frame is. None of that is authentication.
- **No moderation, no auth.** Derived rooms have a real unsolved question
  behind them: neither parent circle's moderators obviously own the
  intersection, and rooms grow exponentially while moderators do not.
- **Anyone can create a subject.** Whoever controls circle creation controls
  whether the map stays legible; this prototype does not control it at all.
- **Rendering is verified by rasteriser, not by browser.** `npm run render`
  draws the real components through a DOM shim and rasterises them, which is
  what caught the labels sitting on boundaries, the enclosed white holes, and
  the overlap that came out grey. It does not exercise CSS, layout, blend
  modes or any interaction — no browser has run this yet.
- **The atlas can leave a lake.** Growth stops when zones reach their quota, so
  a gap fully enclosed by territories can survive. Small ones are absorbed by
  whichever neighbours are still short of their share; a large one stays, and
  reads as a hole in the middle of the map.
- **Subject colours can collide.** Hues come from a hash of the name, which is
  stable across reloads but says nothing about what else is on screen, so a
  view can come up with three neighbouring blues.
