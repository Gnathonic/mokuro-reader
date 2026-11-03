/**
 * The browser's device key: created only on sign-in, non-extractable, in its
 * own IndexedDB database, one per browser even when two tabs race, and its
 * proofs verify on the server (`$lib/server/gdrive-auth/pop.ts`).
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureDeviceKey,
  forgetCachedDeviceKeyForTest,
  loadDeviceKey,
  signProof
} from './device-key';
import { checkProof, jwkThumbprint, parseProof } from '$lib/server/gdrive-auth/pop';

const ORIGIN = 'https://reader.example';

async function resetDb() {
  forgetCachedDeviceKeyForTest();
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('mokuro-device-key');
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
});

async function publicJwk(pair: CryptoKeyPair) {
  const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { kty, crv, x, y };
}

describe('the device key', () => {
  it('is never created by a read', async () => {
    expect(await loadDeviceKey()).toBeNull();
    const names = (await indexedDB.databases()).map((d) => d.name);
    // The database may exist (opened to look), but holds no key.
    if (names.includes('mokuro-device-key')) {
      forgetCachedDeviceKeyForTest();
      expect(await loadDeviceKey()).toBeNull();
    }
  });

  it('is made on sign-in: ECDSA P-256 with a private half that cannot be exported', async () => {
    const pair = await ensureDeviceKey();
    expect(pair).not.toBeNull();
    expect(pair!.privateKey.extractable).toBe(false);
    expect(pair!.privateKey.algorithm).toMatchObject({ name: 'ECDSA', namedCurve: 'P-256' });
    await expect(crypto.subtle.exportKey('jwk', pair!.privateKey)).rejects.toThrow();
  });

  it('lives in its own database, and survives a reload (a fresh read finds it)', async () => {
    const made = await ensureDeviceKey();
    forgetCachedDeviceKeyForTest();
    const loaded = await loadDeviceKey();
    expect(await publicJwk(loaded!)).toEqual(await publicJwk(made!));
    const names = (await indexedDB.databases()).map((d) => d.name);
    expect(names).toContain('mokuro-device-key');
  });

  it('two tabs signing in at once keep ONE key (add() refuses the second)', async () => {
    const [a, b] = await Promise.all([ensureDeviceKey(), ensureDeviceKey()]);
    expect(await publicJwk(a!)).toEqual(await publicJwk(b!));
    forgetCachedDeviceKeyForTest();
    expect(await publicJwk((await loadDeviceKey())!)).toEqual(await publicJwk(a!));
  });

  it('storage that fails leaves the sign-in unbound, never broken', async () => {
    vi.spyOn(indexedDB, 'open').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(await ensureDeviceKey()).toBeNull();
    expect(await loadDeviceKey()).toBeNull();
  });

  it('signs proofs the server verifies, under the key’s thumbprint', async () => {
    const pair = (await ensureDeviceKey())!;
    const now = Date.now();
    const proof = await signProof(pair, ORIGIN, '/api/gdrive/refresh', now);
    const parsed = parseProof(proof);
    expect(parsed).not.toBeNull();
    const check = checkProof(parsed!, ORIGIN, '/api/gdrive/refresh', now);
    expect(check).toEqual({ ok: true, thumbprint: jwkThumbprint(proof.jwk) });
    // Only the public half travels.
    expect(Object.keys(proof.jwk).sort()).toEqual(['crv', 'kty', 'x', 'y']);
  });
});
