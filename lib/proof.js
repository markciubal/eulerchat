/**
 * Showing that you hold a key, to somebody who will not take your word for it.
 *
 * A public key is public. Everybody in the place is sent everybody else's, so
 * a connection that says "this one is mine" has said nothing: anyone can say
 * it about any key. Before a key is allowed to mean anything - a name that is
 * recognisably the same person as yesterday, a moderator's standing - the
 * holder has to do something only the private half can do.
 *
 * The identity keys here are ECDH keys, which agree secrets and cannot sign.
 * So the check is an agreement rather than a signature: the verifier makes a
 * keypair for this one question and a random nonce; both sides derive the same
 * secret, one from each private half; the prover returns a MAC over the nonce
 * under it. Only the two private keys involved can produce that MAC, and the
 * verifier's is thrown away afterwards.
 *
 * WHY IT IS NOT "DECRYPT THIS AND SEND IT BACK", which would have reused
 * `seal` and been three lines: a client that decrypts whatever it is handed
 * and returns the plaintext is a decryption service. A server could pass off a
 * real sealed message as the challenge and be given its contents. The MAC key
 * below is derived under its own label, so nothing a prover ever returns is,
 * or helps to recover, a key that wraps a message - whoever's public key it
 * was handed as the "verifier's".
 *
 * WHAT THIS DOES NOT DO:
 *
 *   - It does not say who anybody is. It says that this connection holds the
 *     private half of this key. Keys cost nothing to make, so one person can
 *     be as many keys as they like: a key is a pseudonym, not a person, and
 *     one key, one vote is not one person, one vote.
 *   - It does not protect the key. Whoever can run script on the page's
 *     origin can use it, and a browser profile that is copied takes the key
 *     along.
 *   - It does not bring a lost key back. There is no account behind it and
 *     nobody to ask.
 */

const subtle = globalThis.crypto?.subtle;
const CURVE = { name: 'ECDH', namedCurve: 'P-256' };
const ENCODE = new TextEncoder();

const toHex = (buffer) =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

const fromHex = (text) => {
  const clean = /^(?:[0-9a-f]{2})+$/i.test(text) ? text : '';
  return Uint8Array.from(clean.match(/../g) ?? [], (pair) => parseInt(pair, 16));
};

/** The secret two keys share, as a key that can only make and check MACs. */
async function agree(mine, theirs) {
  const other = await subtle.importKey('jwk', theirs, CURVE, false, []);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: other }, mine, 256);
  const material = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);

  return subtle.deriveKey(
    // Its own label, and that is the whole of the safety argument above:
    // `eulerchat/wrap` is what message keys are wrapped under, and a key
    // derived under a different label is unrelated to it.
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: ENCODE.encode('eulerchat/proof') },
    material,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
}

/**
 * Ask whoever claims `publicKey` to show that they hold it.
 *
 * Send `offer` to them; hand what comes back to `check`. A challenge answers
 * once: a second attempt is refused whatever it says, so a wrong answer cannot
 * be followed by a better guess at the same question.
 *
 * Throws if `publicKey` is not a usable P-256 key, which is the caller's cue
 * to refuse the claim rather than to challenge it.
 *
 * @param {JsonWebKey} publicKey  the key being claimed
 * @returns {Promise<{offer: {publicKey: JsonWebKey, nonce: string}, check: (mac: string) => Promise<boolean>}>}
 */
export async function challenge(publicKey) {
  const once = await subtle.generateKey(CURVE, false, ['deriveBits']);
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const key = await agree(once.privateKey, publicKey);
  const offer = { publicKey: await subtle.exportKey('jwk', once.publicKey), nonce };

  let spent = false;
  return {
    offer,
    async check(mac) {
      if (spent) return false;
      spent = true;
      try {
        return await subtle.verify('HMAC', key, fromHex(String(mac ?? '')), ENCODE.encode(nonce));
      } catch {
        return false;
      }
    },
  };
}

/**
 * Answer a challenge with the key you hold.
 *
 * @param {{publicKey: JsonWebKey, nonce: string}} offer
 * @param {{pair: CryptoKeyPair}} me
 * @returns {Promise<string>} what to send back
 */
export async function prove(offer, me) {
  const key = await agree(me.pair.privateKey, offer.publicKey);
  return toHex(await subtle.sign('HMAC', key, ENCODE.encode(String(offer.nonce))));
}

/** How much of a fingerprint is shown beside a name. The whole of it is the identity. */
export const MARK_LENGTH = 8;

/** The part of a key's fingerprint that is written after a name. */
export const mark = (keyId) => String(keyId ?? '').slice(0, MARK_LENGTH);
