/**
 * The browser's device key: created only on sign-in, non-extractable, in its
 * own IndexedDB database, one per browser even when two tabs race, and its
 * proofs verify on the server (`$lib/server/gdrive-auth/pop.ts`).
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deleteDeviceKey,
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

  it('sign-out deletes it, from memory and from storage; the next sign-in makes a new one', async () => {
    const before = await ensureDeviceKey();
    expect(await deleteDeviceKey()).toBe(true);
    // Neither this tab's memory nor a fresh read (a reload) has it.
    expect(await loadDeviceKey()).toBeNull();
    forgetCachedDeviceKeyForTest();
    expect(await loadDeviceKey()).toBeNull();
    const after = await ensureDeviceKey();
    expect(await publicJwk(after!)).not.toEqual(await publicJwk(before!));
  });

  describe('another tab (its own module instance) deletes or replaces the key', () => {
    /** A second tab: the same browser storage, its own in-memory module state. */
    async function otherTab(): Promise<typeof import('./device-key')> {
      vi.resetModules();
      return import('./device-key');
    }

    it('a sign-in here after the other tab signed out stores the key it binds to', async () => {
      const tabA = await otherTab();
      const tabB = await otherTab();
      expect(await tabA.ensureDeviceKey()).not.toBeNull();
      // Tab B has used the key (a refresh read it).
      expect(await tabB.loadDeviceKey()).not.toBeNull();
      // Tab A signs out.
      expect(await tabA.deleteDeviceKey()).toBe(true);

      // Tab B's Connect: the key it hands the sign-in must be the one stored,
      // or the page Google returns to finds none and the session is unbound.
      const signingIn = await tabB.ensureDeviceKey();
      expect(signingIn).not.toBeNull();
      const afterRedirect = await otherTab();
      const stored = await afterRedirect.loadDeviceKey();
      expect(stored).not.toBeNull();
      expect(await publicJwk(stored!)).toEqual(await publicJwk(signingIn!));
    });

    it('a key the other tab made by signing in again is the one this tab signs with', async () => {
      const tabA = await otherTab();
      const tabB = await otherTab();
      const k1 = await tabA.ensureDeviceKey();
      expect(await publicJwk((await tabB.loadDeviceKey())!)).toEqual(await publicJwk(k1!));

      await tabA.deleteDeviceKey();
      const k2 = await tabA.ensureDeviceKey();
      expect(await publicJwk(k2!)).not.toEqual(await publicJwk(k1!));
      // The shared cookie is now bound to K2: tab B must prove with K2.
      expect(await publicJwk((await tabB.loadDeviceKey())!)).toEqual(await publicJwk(k2!));
    });

    it('a key the other tab deleted is not signed with here', async () => {
      const tabA = await otherTab();
      const tabB = await otherTab();
      await tabA.ensureDeviceKey();
      expect(await tabB.loadDeviceKey()).not.toBeNull();
      await tabA.deleteDeviceKey();
      expect(await tabB.loadDeviceKey()).toBeNull();
    });
  });

  it('deleting with no key, or with storage refusing, never throws', async () => {
    expect(await deleteDeviceKey()).toBe(true);
    vi.spyOn(indexedDB, 'open').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(await deleteDeviceKey()).toBe(false);
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
