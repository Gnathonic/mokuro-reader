import { describe, expect, it } from 'vitest';
import { readAuthConfig, type AuthConfig } from '../config';
import {
  COOKIE_MAX_BYTES,
  needsReseal,
  seal,
  sessionExpired,
  unseal,
  SealTooLargeError,
  RESEAL_AFTER_MS,
  SESSION_MAX_AGE_MS,
  SESSION_MAX_IDLE_MS,
  type SealContext,
  type SessionPayload
} from '../seal';
import { fromBase64Url, toBase64Url } from '../bytes';
import { testEnv, throwawayKey } from './helpers';

const NOW = Date.UTC(2026, 10, 3);
const DAY = 24 * 60 * 60 * 1000;

function config(overrides: Record<string, string | undefined> = {}): AuthConfig {
  const parsed = readAuthConfig(testEnv(overrides));
  if (!parsed) throw new Error('test config did not parse');
  return parsed;
}

const context: SealContext = {
  clientId: 'test-client.apps.example',
  origin: 'https://reader.example',
  cookieName: '__Host-gdrive_rt'
};

const payload: SessionPayload = { rt: '1//refresh-token', iat0: NOW, ts: NOW };

describe('seal / unseal', () => {
  it('round-trips a session, bound or not', () => {
    const c = config();
    for (const p of [payload, { ...payload, cnf: 'A'.repeat(43) }]) {
      const opened = unseal(seal(p, c.current, context), c, context);
      expect(opened).toEqual({ ok: true, payload: p, sealedWith: 'current' });
    }
  });

  it('is v1.<kid>.<iv>.<ciphertext||tag>, with a fresh 12-byte IV every time', () => {
    const c = config();
    const a = seal(payload, c.current, context);
    const b = seal(payload, c.current, context);
    expect(a).not.toBe(b);
    const [version, kid, iv, body] = a.split('.');
    expect(version).toBe('v1');
    expect(kid).toBe(c.current.kid);
    expect(fromBase64Url(iv)?.length).toBe(12);
    // JSON + 16-byte tag
    expect(fromBase64Url(body)!.length).toBe(JSON.stringify(payload).length + 16);
    expect(a.split('.')[2]).not.toBe(b.split('.')[2]);
    // The token never shows through.
    expect(a).not.toContain('refresh-token');
  });

  it('refuses any tampering: body, IV, kid, version, shape', () => {
    const c = config();
    const value = seal(payload, c.current, context);
    const [v, kid, iv, body] = value.split('.');
    const flip = (part: string) => {
      const bytes = fromBase64Url(part)!;
      bytes[bytes.length - 1] ^= 1;
      return toBase64Url(bytes);
    };
    expect(unseal([v, kid, iv, flip(body)].join('.'), c, context)).toEqual({
      ok: false,
      reason: 'bad_tag'
    });
    expect(unseal([v, kid, flip(iv), body].join('.'), c, context)).toEqual({
      ok: false,
      reason: 'bad_tag'
    });
    expect(unseal([v, 'AAAAAAAA', iv, body].join('.'), c, context)).toEqual({
      ok: false,
      reason: 'unknown_kid'
    });
    expect(unseal(['v2', kid, iv, body].join('.'), c, context).ok).toBe(false);
    expect(unseal([v, kid, iv].join('.'), c, context).ok).toBe(false);
    expect(unseal('', c, context).ok).toBe(false);
    expect(unseal('x'.repeat(COOKIE_MAX_BYTES + 1), c, context).ok).toBe(false);
  });

  it('opens only where it was sealed: origin, client and cookie name are in the AAD', () => {
    const c = config();
    const value = seal(payload, c.current, context);
    for (const other of [
      { ...context, origin: 'https://other.example' },
      { ...context, origin: 'http://reader.example' },
      { ...context, clientId: 'other-client.apps.example' },
      { ...context, cookieName: 'gdrive_rt' }
    ]) {
      expect(unseal(value, c, other)).toEqual({ ok: false, reason: 'bad_tag' });
    }
  });

  it('a cookie from another key with the same kid label is still refused (the tag)', () => {
    const a = config();
    const b = config();
    const value = seal(payload, a.current, context);
    // Pretend b's key had a's id: the AEAD tag still fails.
    const forged = { current: { ...b.current, kid: a.current.kid } };
    expect(unseal(value, forged, context)).toEqual({ ok: false, reason: 'bad_tag' });
  });

  it('rotation: the previous key still opens, and asks for a re-seal with the current one', () => {
    const oldKey = throwawayKey();
    const before = config({ GDRIVE_SESSION_KEY: oldKey });
    const value = seal(payload, before.current, context);

    const rotated = config({ GDRIVE_SESSION_KEY: throwawayKey(), GDRIVE_SESSION_KEY_PREV: oldKey });
    const opened = unseal(value, rotated, context);
    expect(opened).toMatchObject({ ok: true, sealedWith: 'previous' });
    if (opened.ok) expect(needsReseal(opened, NOW)).toBe(true);

    // Once PREV is dropped, the old cookie is dead.
    const dropped = config({ GDRIVE_SESSION_KEY: throwawayKey() });
    expect(unseal(value, dropped, context)).toEqual({ ok: false, reason: 'unknown_kid' });
  });

  it('refuses to produce a value the browser would drop', () => {
    const c = config();
    expect(() => seal({ ...payload, rt: 'r'.repeat(3500) }, c.current, context)).toThrow(
      SealTooLargeError
    );
    expect(() => seal({ ...payload, rt: 'r'.repeat(2000) }, c.current, context)).not.toThrow();
  });

  it('refuses to seal or open a malformed payload', () => {
    const c = config();
    expect(() => seal({ ...payload, rt: '' }, c.current, context)).toThrow();
    expect(() => seal({ ...payload, cnf: 'short' }, c.current, context)).toThrow();
  });
});

describe('server-side expiry', () => {
  it('dies after 180 idle days, and 365 days after the first consent however used', () => {
    expect(sessionExpired(payload, NOW + SESSION_MAX_IDLE_MS)).toBe(false);
    expect(sessionExpired(payload, NOW + SESSION_MAX_IDLE_MS + 1)).toBe(true);
    const busy = { ...payload, ts: NOW + 300 * DAY };
    expect(sessionExpired(busy, NOW + 301 * DAY)).toBe(false);
    expect(sessionExpired(busy, NOW + SESSION_MAX_AGE_MS + 1)).toBe(true);
  });

  it('re-seals only once ts is over a week old', () => {
    const fresh = { payload, sealedWith: 'current' as const };
    expect(needsReseal(fresh, NOW + RESEAL_AFTER_MS)).toBe(false);
    expect(needsReseal(fresh, NOW + RESEAL_AFTER_MS + 1)).toBe(true);
  });
});

describe('readAuthConfig', () => {
  it('needs a client id, a secret and a 32-byte key', () => {
    expect(readAuthConfig(testEnv())).not.toBeNull();
    expect(readAuthConfig(testEnv({ GDRIVE_CLIENT_SECRET: undefined }))).toBeNull();
    expect(readAuthConfig(testEnv({ GDRIVE_CLIENT_SECRET: '  ' }))).toBeNull();
    expect(readAuthConfig(testEnv({ GDRIVE_SESSION_KEY: '' }))).toBeNull();
    expect(readAuthConfig(testEnv({ GDRIVE_SESSION_KEY: 'not base64!' }))).toBeNull();
    const bytes = (n: number) => btoa(String.fromCharCode(...new Uint8Array(n).fill(7)));
    expect(readAuthConfig(testEnv({ GDRIVE_SESSION_KEY: bytes(31) }))).toBeNull();
    expect(readAuthConfig(testEnv({ GDRIVE_SESSION_KEY: bytes(33) }))).toBeNull();
    expect(readAuthConfig(testEnv({ GDRIVE_SESSION_KEY: bytes(32) + '\n' }))).not.toBeNull();
    expect(
      readAuthConfig(testEnv({ GDRIVE_CLIENT_ID: undefined, VITE_GDRIVE_CLIENT_ID: undefined }))
    ).toBeNull();
  });

  it('falls back to VITE_GDRIVE_CLIENT_ID for the client id', () => {
    const c = readAuthConfig(
      testEnv({ GDRIVE_CLIENT_ID: undefined, VITE_GDRIVE_CLIENT_ID: 'vite-client' })
    );
    expect(c?.clientId).toBe('vite-client');
    expect(readAuthConfig(testEnv({ VITE_GDRIVE_CLIENT_ID: 'vite-client' }))?.clientId).toBe(
      'test-client.apps.example'
    );
  });

  it('a malformed PREV key is a configuration error, not a silent sign-out', () => {
    expect(readAuthConfig(testEnv({ GDRIVE_SESSION_KEY_PREV: 'garbage' }))).toBeNull();
    expect(readAuthConfig(testEnv({ GDRIVE_SESSION_KEY_PREV: '' }))?.previous).toBeUndefined();
    const key = throwawayKey();
    // The current key named again is no rotation.
    expect(
      readAuthConfig(testEnv({ GDRIVE_SESSION_KEY: key, GDRIVE_SESSION_KEY_PREV: key }))?.previous
    ).toBeUndefined();
  });

  it('proofs are required unless GDRIVE_POP=off', () => {
    expect(readAuthConfig(testEnv())?.popRequired).toBe(true);
    expect(readAuthConfig(testEnv({ GDRIVE_POP: 'on' }))?.popRequired).toBe(true);
    expect(readAuthConfig(testEnv({ GDRIVE_POP: 'off' }))?.popRequired).toBe(false);
    expect(readAuthConfig(testEnv({ GDRIVE_POP: 'OFF' }))?.popRequired).toBe(false);
  });

  it('the key id is stable for a key and says nothing about it', () => {
    const key = throwawayKey();
    const a = readAuthConfig(testEnv({ GDRIVE_SESSION_KEY: key }))!;
    const b = readAuthConfig(testEnv({ GDRIVE_SESSION_KEY: key }))!;
    expect(a.current.kid).toBe(b.current.kid);
    expect(a.current.kid).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(key).not.toContain(a.current.kid);
  });
});
