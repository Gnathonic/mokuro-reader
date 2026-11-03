/**
 * Proof of possession of the device key a session is bound to.
 *
 * The browser holds a non-extractable ECDSA P-256 key (WebCrypto, its own
 * IndexedDB database). A request proves possession by sending the public JWK,
 * a millisecond timestamp and a signature (SHA-256, raw r||s as WebCrypto
 * produces it) over
 *
 *     mokuro-pop-v1|<origin>|POST|<path>|<ts>
 *
 * The sealed cookie carries the key's RFC 7638 thumbprint (`cnf`); a copied
 * cookie is useless without the key that never leaves the browser that signed
 * in. The timestamp must be within POP_MAX_SKEW_MS of the server's clock; a
 * client whose clock is off is told the server time (`pop_clock`) and retries
 * once with the offset.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { fromBase64Url, toBase64Url, utf8 } from './bytes';

export const POP_MAX_SKEW_MS = 10 * 60 * 1000;

export interface PopJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

export interface PopProof {
  jwk: PopJwk;
  ts: number;
  sig: string;
}

/** The signed message: what a proof attests to. */
export function popMessage(origin: string, path: string, ts: number): string {
  return `mokuro-pop-v1|${origin}|POST|${path}|${ts}`;
}

/** RFC 7638 thumbprint: SHA-256 over the required members, lexicographic, no whitespace. */
export function jwkThumbprint(jwk: PopJwk): string {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
  return toBase64Url(createHash('sha256').update(canonical).digest());
}

/**
 * A P-256 coordinate: exactly 32 bytes in CANONICAL base64url. A looser check
 * (43 alphabet characters) lets the last character's spare bits vary: Node
 * decodes each spelling to the same point, so one key would have up to 16
 * thumbprints, and `cnf` would no longer name one key.
 */
function isCoordinate(text: string): boolean {
  const bytes = fromBase64Url(text);
  return bytes !== null && bytes.length === 32;
}

/** A request body's `pop`, as a well-formed proof, or null. Only the public members are read. */
export function parseProof(value: unknown): PopProof | null {
  const proof = value as { jwk?: Record<string, unknown>; ts?: unknown; sig?: unknown } | null;
  if (!proof || typeof proof !== 'object') return null;
  const jwk = proof.jwk;
  if (!jwk || typeof jwk !== 'object') return null;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') return null;
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') return null;
  if (!isCoordinate(jwk.x) || !isCoordinate(jwk.y)) return null;
  if (typeof proof.ts !== 'number' || !Number.isSafeInteger(proof.ts) || proof.ts < 0) return null;
  if (typeof proof.sig !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(proof.sig)) return null;
  return { jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, ts: proof.ts, sig: proof.sig };
}

export type ProofCheck =
  | { ok: true; thumbprint: string }
  | { ok: false; reason: 'clock' | 'bad_key' | 'bad_signature' };

/**
 * Check a well-formed proof for `path` at `origin`: its clock, then its
 * signature. The caller compares the thumbprint with the session's `cnf`.
 */
export function checkProof(proof: PopProof, origin: string, path: string, now: number): ProofCheck {
  if (Math.abs(proof.ts - now) > POP_MAX_SKEW_MS) return { ok: false, reason: 'clock' };
  const signature = fromBase64Url(proof.sig);
  if (!signature || signature.length !== 64) return { ok: false, reason: 'bad_signature' };
  let key;
  try {
    // Rejects a point that is not on the curve.
    key = createPublicKey({ key: { ...proof.jwk }, format: 'jwk' });
  } catch {
    return { ok: false, reason: 'bad_key' };
  }
  let valid = false;
  try {
    valid = verify(
      'sha256',
      utf8(popMessage(origin, path, proof.ts)),
      { key, dsaEncoding: 'ieee-p1363' },
      signature
    );
  } catch {
    valid = false;
  }
  return valid
    ? { ok: true, thumbprint: jwkThumbprint(proof.jwk) }
    : { ok: false, reason: 'bad_signature' };
}
