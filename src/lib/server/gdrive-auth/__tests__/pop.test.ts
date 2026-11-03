/**
 * Proofs signed by WebCrypto in-test (as the browser signs them) and checked by
 * the server's node:crypto verify.
 */
import { describe, expect, it } from 'vitest';
import { checkProof, jwkThumbprint, parseProof, POP_MAX_SKEW_MS } from '../pop';
import { toBase64Url } from '../bytes';
import { deviceKey, ORIGIN } from './helpers';

const NOW = Date.UTC(2026, 10, 3, 12);
const PATH = '/api/gdrive/refresh';

describe('proof of possession', () => {
  it('verifies a WebCrypto signature (raw r||s) and names the key by its RFC 7638 thumbprint', async () => {
    const key = await deviceKey();
    const proof = await key.prove(PATH, NOW);
    const check = checkProof(parseProof(proof)!, ORIGIN, PATH, NOW);
    expect(check).toEqual({ ok: true, thumbprint: jwkThumbprint(key.jwk) });

    // The thumbprint, computed independently: SHA-256 of the canonical member order.
    const canonical = JSON.stringify({ crv: 'P-256', kty: 'EC', x: key.jwk.x, y: key.jwk.y });
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
    expect(jwkThumbprint(key.jwk)).toBe(toBase64Url(new Uint8Array(digest)));
  });

  it('refuses a signature made by another key than the one presented', async () => {
    const signer = await deviceKey();
    const other = await deviceKey();
    const proof = { ...(await signer.prove(PATH, NOW)), jwk: other.jwk };
    expect(checkProof(proof, ORIGIN, PATH, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('a proof is for one origin, one path and one timestamp', async () => {
    const key = await deviceKey();
    const proof = await key.prove(PATH, NOW);
    expect(checkProof(proof, 'https://other.example', PATH, NOW).ok).toBe(false);
    expect(checkProof(proof, ORIGIN, '/api/gdrive/session', NOW).ok).toBe(false);
    expect(checkProof({ ...proof, ts: NOW + 1 }, ORIGIN, PATH, NOW).ok).toBe(false);
  });

  it('tolerates ten minutes of clock skew either way, and no more', async () => {
    const key = await deviceKey();
    for (const ts of [NOW - POP_MAX_SKEW_MS, NOW + POP_MAX_SKEW_MS - 1]) {
      expect(checkProof(await key.prove(PATH, ts), ORIGIN, PATH, NOW).ok).toBe(true);
    }
    for (const ts of [NOW - POP_MAX_SKEW_MS - 1, NOW + POP_MAX_SKEW_MS + 1]) {
      expect(checkProof(await key.prove(PATH, ts), ORIGIN, PATH, NOW)).toEqual({
        ok: false,
        reason: 'clock'
      });
    }
  });

  it('refuses a point that is not on the curve', async () => {
    const key = await deviceKey();
    const proof = await key.prove(PATH, NOW);
    const bogus = { ...proof, jwk: { ...proof.jwk, y: proof.jwk.x } };
    expect(checkProof(bogus, ORIGIN, PATH, NOW).ok).toBe(false);
  });

  it('parses only well-formed public proofs, and keeps only the public members', async () => {
    const key = await deviceKey();
    const proof = await key.prove(PATH, NOW);
    expect(parseProof(proof)).toEqual(proof);
    expect(parseProof({ ...proof, jwk: { ...proof.jwk, d: 'secret', alg: 'ES256' } })?.jwk).toEqual(
      proof.jwk
    );
    for (const bad of [
      null,
      'proof',
      { ...proof, jwk: undefined },
      { ...proof, jwk: { ...proof.jwk, crv: 'P-384' } },
      { ...proof, jwk: { ...proof.jwk, kty: 'RSA' } },
      { ...proof, jwk: { ...proof.jwk, x: 'short' } },
      { ...proof, ts: '1' },
      { ...proof, ts: 1.5 },
      { ...proof, sig: proof.sig.slice(1) },
      { ...proof, sig: undefined }
    ]) {
      expect(parseProof(bad)).toBeNull();
    }
  });

  it('accepts one spelling per coordinate: a non-canonical x (same point) is refused', async () => {
    const key = await deviceKey();
    const proof = await key.prove(PATH, NOW);
    // 32 bytes take 43 base64url characters, the last carrying 2 spare bits.
    // Flipping the lowest one spells the SAME bytes another way.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(proof.jwk.x.at(-1)!);
    const x = proof.jwk.x.slice(0, -1) + alphabet[last ^ 1];
    const loose = { ...proof, jwk: { ...proof.jwk, x } };

    // Node itself decodes it to the very same point: the signature verifies
    // under it, with another thumbprint. That is why parsing must refuse it.
    const unparsed = checkProof(loose, ORIGIN, PATH, NOW);
    expect(unparsed.ok).toBe(true);
    expect(unparsed.ok && unparsed.thumbprint).not.toBe(jwkThumbprint(proof.jwk));

    expect(parseProof(loose)).toBeNull();
    expect(parseProof({ ...proof, jwk: { ...proof.jwk, y: x } })).toBeNull();
    expect(parseProof(proof)).toEqual(proof);
  });
});
