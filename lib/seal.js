/**
 * A fresh key for every message, and a server that cannot read any of them.
 *
 * Each message gets its own AES-GCM key, used once and thrown away. That key
 * is then wrapped separately for each person who should be able to read it,
 * using a secret derived from their public key and the sender's — so the
 * server carries a ciphertext and a bag of wrapped keys, none of which it can
 * open. Nothing is reused between messages, so one key recovered is one
 * message lost rather than a conversation.
 *
 * WHAT THIS DOES NOT DO, which matters more than what it does:
 *
 *   - It does not stop anyone in the room keeping a copy. They are given the
 *     plaintext; that is the point of sending it to them. A recipient can
 *     write every word to their own disk forever and nothing here can tell,
 *     let alone prevent it. Deleting the server's copy after twelve hours
 *     deletes the server's copy.
 *   - It does not authenticate anybody. The server decides which public keys
 *     belong to a room, so a dishonest server can add a key of its own and be
 *     handed a wrapped key like any other member. This protects a conversation
 *     from a server that stores and later leaks, not from one that is actively
 *     against you. Defending against that needs people to compare keys by some
 *     route the server does not control, which is not built.
 *   - It does not hide who is talking to whom, or when, or how often. The
 *     server routes, so the server knows.
 *
 * Standard primitives only, through the platform's own crypto: ECDH on P-256
 * to agree a secret, HKDF to turn it into a key, AES-GCM to use it. No
 * invented constructions.
 */

const subtle = globalThis.crypto?.subtle;
const CURVE = { name: 'ECDH', namedCurve: 'P-256' };
const ENCODE = new TextEncoder();
const DECODE = new TextDecoder();

const b64 = (bytes) => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (const byte of view) out += String.fromCharCode(byte);
  return btoa(out);
};

const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** A fresh identity. Not stored; see `rememberedIdentity` for one that is. */
export async function identity() {
  const pair = await subtle.generateKey(CURVE, false, ['deriveKey', 'deriveBits']);
  const publicKey = await subtle.exportKey('jwk', pair.publicKey);
  return { pair, publicKey, id: await fingerprint(publicKey) };
}

/**
 * Where a browser keeps its key between visits.
 *
 * One operation, and it is "keep this unless you already hold one, then tell
 * me which you hold" - in a single transaction, because two tabs opening at
 * the same moment would otherwise each make a key, each save it, and one of
 * them would spend the session as somebody the next reload has never heard of.
 *
 * The private key goes in as the object it is. It was made non-extractable and
 * stays that way: IndexedDB stores the handle, and script can use it but
 * cannot read it out.
 */
function browserStore(name = 'eulerchat') {
  if (typeof indexedDB === 'undefined') return null;

  const within = (work) =>
    new Promise((resolve, reject) => {
      const opening = indexedDB.open(name, 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore('identity');
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const db = opening.result;
        const tx = db.transaction('identity', 'readwrite');
        let answer;
        work(tx.objectStore('identity'), (value) => {
          answer = value;
        });
        tx.oncomplete = () => {
          db.close();
          resolve(answer);
        };
        tx.onerror = tx.onabort = () => {
          db.close();
          reject(tx.error);
        };
      };
    });

  return {
    keep: (candidate) =>
      within((table, answer) => {
        const asked = table.get('me');
        asked.onsuccess = () => {
          if (asked.result) return answer(asked.result);
          table.put(candidate, 'me');
          answer(candidate);
        };
      }),
    drop: () => within((table) => table.delete('me')),
  };
}

/**
 * The same identity as last time, where there is somewhere to keep one.
 *
 * What makes a name worth anything: `wren` today and `wren` tomorrow are the
 * same person only if they hold the same key, and a key made afresh on every
 * page load says nothing about yesterday.
 *
 * It is also a decision against anonymity, and it should be made knowingly. A
 * key that persists makes everything said under it linkable, by anybody, for
 * as long as it is kept - which is the point of it and the cost of it. So the
 * way out has to be as easy as the way in: `forgetIdentity` drops the key, and
 * whoever comes back afterwards is a stranger.
 *
 * Never throws for want of storage. A private window, a full disk or a browser
 * with no IndexedDB gets a working identity that lasts as long as the page,
 * and `kept: false` so that an interface can say so.
 *
 * @param {{keep: (candidate: object) => Promise<object>} | null} [store]
 */
export async function rememberedIdentity(store = browserStore()) {
  const fresh = await identity();
  if (!store) return { ...fresh, kept: false };

  try {
    const held = await store.keep({ pair: fresh.pair, publicKey: fresh.publicKey });
    if (!held?.pair?.privateKey || !held.publicKey) return { ...fresh, kept: false };
    // Named again from the key rather than read back from storage, so what is
    // stored cannot claim to be a key it is not.
    return { pair: held.pair, publicKey: held.publicKey, id: await fingerprint(held.publicKey), kept: true };
  } catch {
    return { ...fresh, kept: false };
  }
}

/** Drop the stored key. Whoever asks for an identity next is somebody new. */
export async function forgetIdentity(store = browserStore()) {
  try {
    await store?.drop?.();
    return true;
  } catch {
    return false;
  }
}

/** A short, stable name for a public key, so a wrapped key can be addressed. */
export async function fingerprint(jwk) {
  const bytes = ENCODE.encode(`${jwk.x}.${jwk.y}`);
  const digest = await subtle.digest('SHA-256', bytes);
  return b64(digest).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
}

/** The secret two people share, as a key for wrapping one message key. */
async function agree(mine, theirs) {
  const other = await subtle.importKey('jwk', theirs, CURVE, false, []);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: other }, mine, 256);
  const material = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);

  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: ENCODE.encode('eulerchat/wrap') },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Seal one message for a set of readers.
 *
 * @param {string} text
 * @param {{pair: CryptoKeyPair, publicKey: JsonWebKey}} me
 * @param {Array<JsonWebKey>} readers  public keys of everybody who may read it
 * @returns {Promise<object>} an envelope safe to hand to a server
 */
export async function seal(text, me, readers) {
  // Used once, for this message, and never held.
  const once = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = await subtle.encrypt({ name: 'AES-GCM', iv }, once, ENCODE.encode(text));
  const raw = await subtle.exportKey('raw', once);

  const keys = {};
  for (const reader of readers) {
    const wrapper = await agree(me.pair.privateKey, reader);
    const wrapIv = crypto.getRandomValues(new Uint8Array(12));
    const wrapped = await subtle.encrypt({ name: 'AES-GCM', iv: wrapIv }, wrapper, raw);
    keys[await fingerprint(reader)] = { iv: b64(wrapIv), key: b64(wrapped) };
  }

  return { sealed: true, from: me.publicKey, iv: b64(iv), body: b64(body), keys };
}

/**
 * Open an envelope addressed to you, or return null if it was not.
 *
 * Null rather than throwing: not being a recipient is the ordinary case for
 * anything that arrives after you joined, and it is not an error.
 */
export async function unseal(envelope, me) {
  if (!envelope?.sealed) return null;
  const mine = envelope.keys?.[me.id];
  if (!mine) return null;

  const wrapper = await agree(me.pair.privateKey, envelope.from);
  const raw = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(mine.iv) }, wrapper, unb64(mine.key));
  const once = await subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
  const text = await subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(envelope.iv) },
    once,
    unb64(envelope.body),
  );
  return DECODE.decode(text);
}

/** Whether this environment can do any of the above. */
export const available = () => Boolean(subtle?.generateKey);
