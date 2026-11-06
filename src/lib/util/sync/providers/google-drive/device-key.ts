/**
 * This browser's device key for the Drive auth backend: a non-extractable
 * ECDSA P-256 key pair (WebCrypto) kept in its OWN IndexedDB database, never
 * in the Dexie catalog. A sign-in binds the server session to the key's
 * thumbprint, and every refresh proves possession by signing
 *
 *     mokuro-pop-v1|<origin>|POST|<path>|<ts>
 *
 * (`src/lib/server/gdrive-auth/pop.ts` checks it). A copied session cookie is
 * then useless on another machine: the private key cannot be exported.
 *
 * The key is only ever CREATED in the sign-in path (`ensureDeviceKey`), with
 * `add()`, so two tabs signing in at once keep one key (the loser's
 * ConstraintError reads the winner's). Every other path only reads it, except
 * sign-out, which deletes it (`deleteDeviceKey`): a session bound to a deleted
 * key can never refresh again, whoever holds a copy of its cookie. Storage
 * failures never block a sign-in: the session is simply unbound. Nothing
 * here remembers the key between calls (`loadDeviceKey`): every tab of the
 * browser shares the one stored key, and another tab may delete or replace it.
 */

const DB_NAME = 'mokuro-device-key';
const DB_VERSION = 1;
const STORE = 'keys';
const RECORD_ID = 'gdrive-pop';

export const POP_VERSION = 'mokuro-pop-v1';

interface KeyRecord {
  id: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  createdAt: number;
}

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

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('device key database blocked'));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      let result: T;
      request.onsuccess = () => (result = request.result);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? request.error);
      tx.onabort = () => reject(tx.error ?? request.error ?? new Error('transaction aborted'));
    });
  } finally {
    db.close();
  }
}

function isKeyPair(record: unknown): record is KeyRecord {
  const r = record as Partial<KeyRecord> | null | undefined;
  return (
    !!r &&
    typeof CryptoKey !== 'undefined' &&
    r.privateKey instanceof CryptoKey &&
    r.publicKey instanceof CryptoKey
  );
}

/** The read in flight, shared by callers at once. Never kept once it settles. */
let cached: Promise<CryptoKeyPair | null> | null = null;

/**
 * The stored key pair, or null (none yet, or storage unreadable). Never
 * creates one. Every call reads storage (only a read already in flight is
 * shared): another tab may delete the key (its sign-out) or replace it (its
 * next sign-in) at any time, and a remembered copy would then hand this tab's
 * sign-in a key the page Google returns to cannot find (an unbound session),
 * or sign this tab's refreshes with a key the shared cookie is no longer
 * bound to. One small IndexedDB read per sign-in, refresh or sign-out.
 */
export function loadDeviceKey(): Promise<CryptoKeyPair | null> {
  if (!cached) {
    const read: Promise<CryptoKeyPair | null> = withStore<KeyRecord | undefined>(
      'readonly',
      (store) => store.get(RECORD_ID)
    )
      .then((record) =>
        isKeyPair(record) ? { privateKey: record.privateKey, publicKey: record.publicKey } : null
      )
      .catch((error) => {
        console.warn('Drive device key unreadable:', error?.name ?? error);
        return null;
      })
      .finally(() => {
        if (cached === read) cached = null;
      });
    cached = read;
  }
  return cached;
}

/**
 * The key pair, created if this browser has none. The sign-in path only. Null
 * when the browser cannot make or keep one: the sign-in goes on unbound.
 */
export async function ensureDeviceKey(): Promise<CryptoKeyPair | null> {
  const existing = await loadDeviceKey();
  if (existing) return existing;
  try {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'sign',
      'verify'
    ])) as CryptoKeyPair;
    const record: KeyRecord = {
      id: RECORD_ID,
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      createdAt: Date.now()
    };
    try {
      await withStore('readwrite', (store) => store.add(record));
    } catch (error) {
      // Another tab stored its key first: that one is THE key.
      if ((error as DOMException | null)?.name === 'ConstraintError') {
        cached = null; // a read in flight may predate the winner's add
        return await loadDeviceKey();
      }
      throw error;
    }
    return pair;
  } catch (error) {
    console.warn('Drive device key not created; signing in unbound:', (error as Error)?.name);
    return null;
  }
}

/**
 * Forget this browser's key (sign-out). A session bound to it can then never
 * refresh again: no proof for its thumbprint can be signed anywhere. The next
 * sign-in creates a new key. Never throws; false when storage refused.
 */
export async function deleteDeviceKey(): Promise<boolean> {
  cached = null;
  try {
    await withStore('readwrite', (store) => store.delete(RECORD_ID));
    return true;
  } catch (error) {
    console.warn('Drive device key not deleted:', (error as Error)?.name ?? error);
    return false;
  } finally {
    // A read that started before the delete must not bring the old key back.
    cached = null;
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function popMessage(origin: string, path: string, ts: number): string {
  return `${POP_VERSION}|${origin}|POST|${path}|${ts}`;
}

/** A proof for `path`, signed now (`ts` from the caller: the clock offset is theirs). */
export async function signProof(
  pair: CryptoKeyPair,
  origin: string,
  path: string,
  ts: number
): Promise<PopProof> {
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    pair.privateKey,
    new TextEncoder().encode(popMessage(origin, path, ts))
  );
  return {
    jwk: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! },
    ts,
    sig: base64Url(new Uint8Array(signature))
  };
}

/** Tests: drop a read in flight (the database is the test's to reset). */
export function forgetCachedDeviceKeyForTest(): void {
  cached = null;
}
