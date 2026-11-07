/**
 * ULID generation: 48-bit millisecond timestamp plus 80 random bits, encoded
 * as 26 Crockford base32 characters.
 *
 * IDs are strictly increasing within one generator. When two IDs share a
 * millisecond (or the clock moves backwards), the random part of the previous
 * ID is incremented instead of drawn fresh. The increment is a random value in
 * [1, 2^32] rather than 1, so events created in the same millisecond still get
 * independent sampling fractions from `shouldKeepEvent`, which reads the last
 * 40 bits.
 */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RANDOM_BYTES = 10;

function encodeTime(ms: number): string {
  let out = "";
  let t = ms;
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

/** Encodes 80 bits as 16 base32 characters, most significant first. */
function encodeRandom(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  return out;
}

/** Adds `amount` to a big-endian byte array in place. Returns false on overflow. */
function addInPlace(bytes: Uint8Array, amount: number): boolean {
  let carry = amount;
  for (let i = bytes.length - 1; i >= 0 && carry > 0; i--) {
    const sum = (bytes[i] ?? 0) + (carry % 256);
    carry = Math.floor(carry / 256) + (sum > 255 ? 1 : 0);
    bytes[i] = sum & 255;
  }
  return carry === 0;
}

export function createUlidGenerator(now: () => number = Date.now): () => string {
  let lastTime = -1;
  const random = new Uint8Array(RANDOM_BYTES);
  const step = new Uint32Array(1);

  return () => {
    let time = now();
    if (time <= lastTime) {
      time = lastTime;
      crypto.getRandomValues(step);
      if (!addInPlace(random, (step[0] ?? 0) + 1)) {
        // 80 bits exhausted within one millisecond: move to the next one.
        time = lastTime + 1;
        crypto.getRandomValues(random);
      }
    } else {
      crypto.getRandomValues(random);
    }
    lastTime = time;
    return encodeTime(time) + encodeRandom(random);
  };
}
