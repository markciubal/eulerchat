/**
 * A room whose name only two people can work out.
 *
 * Every other room here is named after what it is about: `art`, or
 * `art+philosophy`, or `kite-fox-9/art`. Anybody can read the name, and that
 * is the point - a room is a place, and places have addresses you can say out
 * loud. A portal is the one exception. Its name is derived from a secret the
 * two people already share, so both of them compute the same address and
 * nobody else can compute it at all.
 *
 * WHY NOT JUST AN UNGUESSABLE STRING. A random name would also be hard to
 * guess, and it is what the group invitations here already do. The difference
 * is what happens next: a random name has to be sent to the other person
 * somehow, it is a bearer token for as long as it exists, and once it has
 * leaked it has leaked for good. A derived name is never transmitted at all -
 * it is recomputed from keys both people are already holding - and because
 * the day goes into the derivation, a name that does leak stops working
 * tomorrow.
 *
 * WHAT IT DOES NOT DO, which is the part that must not be overstated:
 *
 *   - It does not hide that two people are talking, or when. The server still
 *     routes the messages. It sees an opaque name, two members and a pattern
 *     of activity, and that is enough to know a conversation is happening and
 *     roughly how busy it is. Only the contents and the address are hidden,
 *     and the contents only if the messages are sealed as well.
 *   - It does not authenticate anybody. The public keys come from the server,
 *     so a dishonest server can offer a key of its own and derive the address
 *     with you. This is the same limit sealing has, for the same reason, and
 *     it is written out at more length in `lib/seal.js`.
 *   - It is not a lock on the room. Anyone who learns today's address can
 *     join like anybody else; the routing has no idea portals exist. It is a
 *     door in a place nobody else can find, not a door that refuses to open.
 *
 * The rotation is what makes the third point survivable rather than fatal.
 */

const subtle = globalThis.crypto?.subtle;
const CURVE = { name: 'ECDH', namedCurve: 'P-256' };
const ENCODE = new TextEncoder();

/**
 * How a portal's name begins.
 *
 * A prefix rather than a hash that could be anything, because the server has
 * to recognise one without being able to derive it - the open read side
 * refuses to publish these, and it can only refuse what it can spot. So the
 * name says "this is a portal" and says nothing else.
 */
export const PORTAL_PREFIX = 'portal-';

/** Whether a subject is one of these. */
export const isPortal = (subject) => String(subject ?? '').startsWith(PORTAL_PREFIX);

/**
 * Whether a region is a portal, or touches one.
 *
 * Any region that contains a portal subject is named after it, so the whole
 * key has to be withheld rather than only the bare subject.
 */
export const isPortalRoom = (roomKey) =>
  String(roomKey ?? '')
    .split('+')
    .some(isPortal);

/**
 * The letters a subject may contain: lowercase, digits, spaces and hyphens,
 * and no more than 31 of them. Base32 without padding fits inside that, and
 * `portal-` plus twenty-four of them comes to exactly 31.
 */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const LENGTH = 24;

function base32(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/** The day, as both sides will spell it. UTC, so two time zones agree. */
export const dayOf = (when = new Date()) => new Date(when).toISOString().slice(0, 10);

/**
 * The address this person and that person share today.
 *
 * Both sides call this with their own private key and the other's public one,
 * and ECDH gives them the same secret - so they arrive at the same name
 * without either of them ever sending it. Change the day and the name
 * changes with it.
 *
 * @param {{pair: CryptoKeyPair}} me
 * @param {JsonWebKey} theirPublicKey
 * @param {{on?: Date | string}} [options]  which day; today by default
 * @returns {Promise<string>} a subject name, safe to hand to `addSubject`
 */
export async function portalWith(me, theirPublicKey, { on } = {}) {
  const theirs = await subtle.importKey('jwk', theirPublicKey, CURVE, false, []);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: theirs }, me.pair.privateKey, 256);
  const material = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);

  // Its own label, like every other use of this secret in the package. A name
  // derived under one label tells you nothing about a key derived under
  // another, so publishing the address gives away nothing about the messages.
  const bits = await subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: ENCODE.encode(`eulerchat/portal/${dayOf(on ?? new Date())}`),
    },
    material,
    256,
  );

  return PORTAL_PREFIX + base32(new Uint8Array(bits)).slice(0, LENGTH);
}

/**
 * Today's address and yesterday's.
 *
 * A conversation that was open at midnight should not stop working because
 * the clock moved, and two people can be on opposite sides of it. Whoever is
 * looking for a portal checks both; whoever is opening one uses the first.
 */
export async function portalsWith(me, theirPublicKey) {
  const today = new Date();
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  return [
    await portalWith(me, theirPublicKey, { on: today }),
    await portalWith(me, theirPublicKey, { on: yesterday }),
  ];
}
