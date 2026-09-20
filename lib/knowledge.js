/**
 * A small hierarchy of subjects, as a starting map.
 *
 * Every entry is `child: parent`, so this is an edge list rather than nested
 * objects — easier to read, easier to extend by hand, and exactly the shape a
 * tool baking one out of Wikipedia would produce.
 *
 * It is deliberately shallow and deliberately incomplete. Its job is to give
 * subjects somewhere sensible to sit before anyone has joined them, not to be
 * a theory of knowledge; a subject it has never heard of is left unanchored
 * and placed by membership, which is the old behaviour and a perfectly good
 * fallback. Pass your own to `atlas({ anchors })` for a catalogue like yours.
 */
export const knowledge = {
  arts: 'knowledge',
  humanities: 'knowledge',
  sciences: 'knowledge',
  making: 'knowledge',
  living: 'knowledge',

  // arts
  'visual art': 'arts',
  art: 'visual art',
  painting: 'visual art',
  sculpture: 'visual art',
  photography: 'visual art',
  architecture: 'visual art',
  typography: 'visual art',
  cinema: 'arts',
  literature: 'arts',
  poetry: 'literature',
  writing: 'literature',

  music: 'arts',
  jazz: 'music',
  opera: 'music',
  techno: 'music',
  'folk music': 'music',
  guitar: 'music',
  piano: 'music',

  // humanities
  philosophy: 'humanities',
  ethics: 'philosophy',
  logic: 'philosophy',
  metaphysics: 'philosophy',
  linguistics: 'humanities',
  history: 'humanities',
  archaeology: 'history',
  anthropology: 'humanities',

  // sciences
  mathematics: 'sciences',
  topology: 'mathematics',
  cryptography: 'mathematics',
  computing: 'sciences',
  compilers: 'computing',
  databases: 'computing',
  robotics: 'computing',

  'earth and sky': 'sciences',
  astronomy: 'earth and sky',
  geology: 'earth and sky',
  cartography: 'earth and sky',

  biology: 'sciences',
  botany: 'biology',
  mycology: 'biology',
  birding: 'biology',
  entomology: 'biology',
  'marine biology': 'biology',
  genetics: 'biology',
  neuroscience: 'biology',

  // making
  craft: 'making',
  ceramics: 'craft',
  weaving: 'craft',
  woodwork: 'craft',
  blacksmithing: 'craft',
  bookbinding: 'craft',

  food: 'making',
  baking: 'food',
  fermentation: 'food',
  coffee: 'food',
  tea: 'food',
  cocktails: 'food',
  cheese: 'food',

  // living
  outdoors: 'living',
  cycling: 'outdoors',
  climbing: 'outdoors',
  sailing: 'outdoors',
  running: 'outdoors',
  games: 'living',
  chess: 'games',
  go: 'games',
};
