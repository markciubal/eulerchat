/**
 * Fields of study, and the subfields people actually join.
 *
 * Three layers: a handful of broad divisions, the fields within them, and
 * beneath those the subfields — and it is the subfields that are the rooms.
 * Somebody joins `entomology`, not `biology`; the field above it is there to
 * say where entomology *is*, so that it sits near mycology and nowhere near
 * topology before a single person has joined either.
 *
 * Academic divisions are the basis because they are the one taxonomy of
 * subjects that people already share. It is not complete and is not meant to
 * be — the practices at the end are there because a catalogue of interests is
 * not a university prospectus, and anything it has never heard of still works,
 * it simply goes unanchored.
 *
 * Every entry is `child: parent`, an edge list rather than nested objects:
 * easier to extend by hand, and exactly the shape a tool baking one out of
 * Wikipedia would produce.
 */
export const knowledge = {
  humanities: 'knowledge',
  arts: 'knowledge',
  'social sciences': 'knowledge',
  'natural sciences': 'knowledge',
  'formal sciences': 'knowledge',
  'applied sciences': 'knowledge',
  hobbies: 'knowledge',

  // --- humanities ----------------------------------------------------------
  history: 'humanities',
  'ancient history': 'history',
  'medieval history': 'history',
  'modern history': 'history',
  'economic history': 'history',
  'art history': 'history',
  historiography: 'history',

  philosophy: 'humanities',
  ethics: 'philosophy',
  logic: 'philosophy',
  metaphysics: 'philosophy',
  epistemology: 'philosophy',
  aesthetics: 'philosophy',
  'philosophy of mind': 'philosophy',
  'political philosophy': 'philosophy',
  phenomenology: 'philosophy',

  literature: 'humanities',
  poetry: 'literature',
  fiction: 'literature',
  drama: 'literature',
  'literary criticism': 'literature',
  'comparative literature': 'literature',

  linguistics: 'humanities',
  phonetics: 'linguistics',
  syntax: 'linguistics',
  semantics: 'linguistics',
  'historical linguistics': 'linguistics',
  sociolinguistics: 'linguistics',

  archaeology: 'humanities',
  'classical archaeology': 'archaeology',
  'prehistoric archaeology': 'archaeology',
  classics: 'humanities',
  'religious studies': 'humanities',
  theology: 'religious studies',
  'comparative religion': 'religious studies',

  // --- arts ----------------------------------------------------------------
  'visual art': 'arts',
  painting: 'visual art',
  drawing: 'visual art',
  sculpture: 'visual art',
  printmaking: 'visual art',
  ceramics: 'visual art',
  photography: 'visual art',
  illustration: 'visual art',

  music: 'arts',
  composition: 'music',
  'music theory': 'music',
  musicology: 'music',
  jazz: 'music',
  opera: 'music',
  'electronic music': 'music',
  'folk music': 'music',
  'choral music': 'music',

  'performing arts': 'arts',
  theatre: 'performing arts',
  dance: 'performing arts',
  puppetry: 'performing arts',

  film: 'arts',
  cinematography: 'film',
  screenwriting: 'film',
  'film theory': 'film',
  animation: 'film',

  design: 'arts',
  'graphic design': 'design',
  typography: 'design',
  'industrial design': 'design',
  'textile design': 'design',

  architecture: 'arts',
  'urban design': 'architecture',
  'landscape architecture': 'architecture',
  'architectural history': 'architecture',

  // --- social sciences -----------------------------------------------------
  anthropology: 'social sciences',
  'cultural anthropology': 'anthropology',
  'biological anthropology': 'anthropology',
  ethnography: 'anthropology',

  sociology: 'social sciences',
  criminology: 'sociology',
  demography: 'sociology',
  'social theory': 'sociology',

  psychology: 'social sciences',
  'cognitive psychology': 'psychology',
  'developmental psychology': 'psychology',
  'clinical psychology': 'psychology',
  'social psychology': 'psychology',

  economics: 'social sciences',
  microeconomics: 'economics',
  macroeconomics: 'economics',
  econometrics: 'economics',
  'behavioural economics': 'economics',

  'political science': 'social sciences',
  'international relations': 'political science',
  'public policy': 'political science',

  geography: 'social sciences',
  'human geography': 'geography',
  cartography: 'geography',
  geopolitics: 'geography',

  law: 'social sciences',
  'constitutional law': 'law',
  'criminal law': 'law',
  'international law': 'law',

  education: 'social sciences',
  pedagogy: 'education',

  // --- natural sciences ----------------------------------------------------
  physics: 'natural sciences',
  mechanics: 'physics',
  thermodynamics: 'physics',
  optics: 'physics',
  'quantum mechanics': 'physics',
  'particle physics': 'physics',
  astrophysics: 'physics',

  chemistry: 'natural sciences',
  'organic chemistry': 'chemistry',
  'inorganic chemistry': 'chemistry',
  'physical chemistry': 'chemistry',
  biochemistry: 'chemistry',

  biology: 'natural sciences',
  botany: 'biology',
  zoology: 'biology',
  entomology: 'biology',
  mycology: 'biology',
  ornithology: 'biology',
  genetics: 'biology',
  ecology: 'biology',
  microbiology: 'biology',
  'marine biology': 'biology',
  neuroscience: 'biology',
  'evolutionary biology': 'biology',

  'earth science': 'natural sciences',
  geology: 'earth science',
  meteorology: 'earth science',
  oceanography: 'earth science',
  hydrology: 'earth science',
  volcanology: 'earth science',

  astronomy: 'natural sciences',
  cosmology: 'astronomy',
  'planetary science': 'astronomy',
  'observational astronomy': 'astronomy',

  // --- formal sciences -----------------------------------------------------
  mathematics: 'formal sciences',
  algebra: 'mathematics',
  geometry: 'mathematics',
  topology: 'mathematics',
  'number theory': 'mathematics',
  analysis: 'mathematics',
  combinatorics: 'mathematics',
  probability: 'mathematics',

  statistics: 'formal sciences',
  'bayesian statistics': 'statistics',
  'experimental design': 'statistics',

  'computer science': 'formal sciences',
  algorithms: 'computer science',
  compilers: 'computer science',
  databases: 'computer science',
  cryptography: 'computer science',
  'machine learning': 'computer science',
  'computer graphics': 'computer science',
  'distributed systems': 'computer science',
  'programming languages': 'computer science',
  'computer networks': 'computer science',

  // --- applied sciences ----------------------------------------------------
  engineering: 'applied sciences',
  'civil engineering': 'engineering',
  'mechanical engineering': 'engineering',
  'electrical engineering': 'engineering',
  'chemical engineering': 'engineering',
  'aerospace engineering': 'engineering',
  robotics: 'engineering',

  medicine: 'applied sciences',
  anatomy: 'medicine',
  physiology: 'medicine',
  immunology: 'medicine',
  epidemiology: 'medicine',
  psychiatry: 'medicine',
  pharmacology: 'medicine',

  agriculture: 'applied sciences',
  agronomy: 'agriculture',
  horticulture: 'agriculture',
  'soil science': 'agriculture',

  'environmental science': 'applied sciences',
  conservation: 'environmental science',
  'climate science': 'environmental science',

  'information science': 'applied sciences',
  'library science': 'information science',
  'data science': 'information science',

  // --- hobbies -------------------------------------------------------------
  // Not fields of study, and the map is poorer without them: most people's
  // interests are not academic, and a catalogue that only admits scholarship
  // has nothing to offer somebody who came for bread and bicycles. Same three
  // layers, so a hobby funnels upward exactly as a subfield does.
  handcraft: 'hobbies',
  woodwork: 'handcraft',
  weaving: 'handcraft',
  knitting: 'handcraft',
  quilting: 'handcraft',
  pottery: 'handcraft',
  blacksmithing: 'handcraft',
  bookbinding: 'handcraft',
  glassblowing: 'handcraft',
  leatherwork: 'handcraft',
  'jewellery making': 'handcraft',
  'model making': 'handcraft',
  calligraphy: 'handcraft',

  cooking: 'hobbies',
  baking: 'cooking',
  'bread making': 'cooking',
  pastry: 'cooking',
  fermentation: 'cooking',
  brewing: 'cooking',
  barbecue: 'cooking',
  preserving: 'cooking',
  coffee: 'cooking',
  tea: 'cooking',
  cheesemaking: 'cooking',

  games: 'hobbies',
  chess: 'games',
  go: 'games',
  'board games': 'games',
  'tabletop roleplaying': 'games',
  'video games': 'games',
  puzzles: 'games',
  'card games': 'games',

  outdoors: 'hobbies',
  hiking: 'outdoors',
  climbing: 'outdoors',
  cycling: 'outdoors',
  sailing: 'outdoors',
  running: 'outdoors',
  kayaking: 'outdoors',
  camping: 'outdoors',
  foraging: 'outdoors',
  fishing: 'outdoors',
  birdwatching: 'outdoors',
  stargazing: 'outdoors',

  growing: 'hobbies',
  gardening: 'growing',
  houseplants: 'growing',
  bonsai: 'growing',
  beekeeping: 'growing',
  'vegetable growing': 'growing',

  movement: 'hobbies',
  yoga: 'movement',
  'martial arts': 'movement',
  swimming: 'movement',
  weightlifting: 'movement',
  skateboarding: 'movement',
  surfing: 'movement',

  tinkering: 'hobbies',
  electronics: 'tinkering',
  '3d printing': 'tinkering',
  'amateur radio': 'tinkering',
  drones: 'tinkering',
  'retro computing': 'tinkering',
  'car restoration': 'tinkering',
  'model trains': 'tinkering',

  collections: 'hobbies',
  'stamp collecting': 'collections',
  'coin collecting': 'collections',
  'record collecting': 'collections',
  'book collecting': 'collections',
  antiques: 'collections',

  'playing music': 'hobbies',
  guitar: 'playing music',
  piano: 'playing music',
  singing: 'playing music',
  drumming: 'playing music',
  djing: 'playing music',
  songwriting: 'playing music',

  writing: 'hobbies',
  'creative writing': 'writing',
  journaling: 'writing',
  zines: 'writing',
};

/** The fields — the layer above what people join. */
export const fields = Object.keys(knowledge).filter(
  (name) => knowledge[Object.keys(knowledge).find((k) => k === name)] !== undefined,
);

/** Subjects with nothing beneath them: the subfields people join. */
export function subfields(parents = knowledge) {
  const hasChildren = new Set(Object.values(parents));
  return Object.keys(parents).filter((name) => !hasChildren.has(name)).sort();
}
