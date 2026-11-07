import { createHash } from 'node:crypto';
import { concatBytes, fromBase64, toBase64Url, utf8 } from './bytes';

/** The server's environment, as `$env/dynamic/private` hands it over. */
export type AuthEnv = Record<string, string | undefined>;

/** One cookie-sealing key and the id a sealed cookie names it by. */
export interface SessionKey {
  kid: string;
  raw: Uint8Array;
}

export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  /** Seals every new cookie. */
  current: SessionKey;
  /** Still opens cookies sealed before a rotation; they are re-sealed with `current`. */
  previous?: SessionKey;
  /** Bound cookies need a proof of possession (`GDRIVE_POP=off` lifts it). */
  popRequired: boolean;
}

const KEY_BYTES = 32;

/**
 * The key id: a short hash of the key, so a cookie says which key sealed it
 * without saying anything about the key. Not secret.
 */
function keyId(raw: Uint8Array): string {
  const digest = createHash('sha256')
    .update(concatBytes(utf8('mokuro-gdrive-kid|'), raw))
    .digest();
  return toBase64Url(digest.slice(0, 6));
}

/** A base64 key that decodes to exactly 32 bytes, or null (an empty value is unset). */
function parseKey(value: string | undefined): SessionKey | null {
  if (!value || value.trim() === '') return null;
  const raw = fromBase64(value);
  if (!raw || raw.length !== KEY_BYTES) return null;
  return { kid: keyId(raw), raw };
}

/**
 * The backend's configuration, or null when any required part is missing,
 * empty or malformed — every route then answers 501 `not_configured` and the
 * client keeps the implicit sign-in. A malformed `GDRIVE_SESSION_KEY_PREV`
 * counts too: a typo there must be loud, not a silent sign-out of everyone
 * whose cookie it should still open.
 */
export function readAuthConfig(env: AuthEnv): AuthConfig | null {
  const clientId = (env.GDRIVE_CLIENT_ID || env.VITE_GDRIVE_CLIENT_ID || '').trim();
  const clientSecret = (env.GDRIVE_CLIENT_SECRET ?? '').trim();
  const current = parseKey(env.GDRIVE_SESSION_KEY);
  if (!clientId || !clientSecret || !current) return null;

  const prevValue = env.GDRIVE_SESSION_KEY_PREV;
  let previous: SessionKey | undefined;
  if (prevValue && prevValue.trim() !== '') {
    const parsed = parseKey(prevValue);
    if (!parsed) return null;
    // The same key twice is not a rotation.
    if (parsed.kid !== current.kid) previous = parsed;
  }

  return {
    clientId,
    clientSecret,
    current,
    ...(previous ? { previous } : {}),
    popRequired: (env.GDRIVE_POP ?? '').trim().toLowerCase() !== 'off'
  };
}
