import { browser } from '$app/environment';
import { writable, type Readable } from 'svelte/store';
import { showSnackbar } from '$lib/util/snackbar';
import { anilistRequest, AniListError } from './providers/anilist';

const TOKEN_KEY = 'anilist_token';
const EXPIRES_KEY = 'anilist_token_expires_at';
const USER_KEY = 'anilist_user';
const RETURN_KEY = 'anilist_return';
const DEFAULT_TTL_SEC = 365 * 24 * 60 * 60; // AniList tokens last one year

/**
 * True when this fragment is an implicit-grant callback rather than a route.
 *
 * The order of the fragment's parameters is the provider's choice, not ours, so
 * matching on a `#access_token=` prefix would miss a perfectly valid
 * `#token_type=Bearer&access_token=…`. App routes always start `#/`, which no
 * query string can, so that is the cheap way to tell the two apart.
 */
export function isAniListCallbackHash(hash: string): boolean {
  if (!hash.startsWith('#') || hash.startsWith('#/')) return false;
  return new URLSearchParams(hash.slice(1)).has('access_token');
}

export interface AniListUser {
  id: number;
  name: string;
}

export function getAniListClientId(): string | undefined {
  const raw = import.meta.env.VITE_ANILIST_CLIENT_ID as string | undefined;
  const id = raw?.trim();
  return id ? id : undefined;
}

export function buildAniListAuthorizeUrl(clientId: string): string {
  return `https://anilist.co/api/v2/oauth/authorize?client_id=${encodeURIComponent(clientId)}&response_type=token`;
}

function readStoredUser(): AniListUser | null {
  if (!browser) return null;
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed?.id === 'number' && typeof parsed?.name === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

const _anilistUser = writable<AniListUser | null>(readStoredUser());
export const anilistUser: Readable<AniListUser | null> = { subscribe: _anilistUser.subscribe };

// Whether a (believed-valid) session exists, independent of whether the
// Viewer lookup that names the user has resolved. Placeholder `false` here —
// the real initial value is assigned below, once `getAniListToken` exists, so
// a stale/expired token found at module load can clear itself via
// `clearAniListSession()` without racing this binding's own initialization
// (calling `getAniListToken()` inside this very initializer would try to
// `.set()` a store that's still being constructed).
const _anilistConnected = writable<boolean>(false);
export const anilistConnected: Readable<boolean> = { subscribe: _anilistConnected.subscribe };

function clearAniListSession(): void {
  if (!browser) return;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EXPIRES_KEY);
  localStorage.removeItem(USER_KEY);
  _anilistUser.set(null);
  _anilistConnected.set(false);
}

/**
 * Current access token, or null when absent/expired/corrupt (in which case the
 * whole session is cleared — a missing or non-positive expiry is treated as
 * invalid, never as "doesn't expire").
 */
export function getAniListToken(): string | null {
  if (!browser) return null;
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return null;
  const expiresAt = Number(localStorage.getItem(EXPIRES_KEY));
  if (!Number.isFinite(expiresAt) || expiresAt <= 0 || Date.now() >= expiresAt) {
    clearAniListSession();
    return null;
  }
  return token;
}

// Real initial value, now that clearAniListSession() (reachable if the stored
// token turns out to be stale) can safely set an already-initialized store.
_anilistConnected.set(getAniListToken() !== null);

/** Redirect flow (no popup): remember where we were, then leave for AniList. */
export function startAniListLogin(): void {
  const clientId = getAniListClientId();
  if (!browser || !clientId) return;
  sessionStorage.setItem(RETURN_KEY, window.location.hash || '#/catalog');
  window.location.assign(buildAniListAuthorizeUrl(clientId));
}

export function parseAniListCallbackHash(
  hash: string
): { accessToken: string; expiresInSec: number } | null {
  if (!isAniListCallbackHash(hash)) return null;
  const params = new URLSearchParams(hash.slice(1));
  const accessToken = params.get('access_token');
  if (!accessToken) return null;
  const expiresInSec = Number(params.get('expires_in') || 0);
  return { accessToken, expiresInSec };
}

/**
 * Handle the implicit-grant callback fragment. Stores the token synchronously
 * (so callers can immediately proceed) and resolves the Viewer in the background.
 * Returns true when the hash was a callback and was consumed.
 *
 * Callers MUST only invoke this when the callback has been verified as
 * originating from a login this tab started (see `initRouter`'s use of
 * `consumeAniListReturnHash`) — this function itself has no way to tell an
 * attacker-crafted `#access_token=…` link from a legitimate redirect.
 */
export async function handleAniListCallbackHash(hash: string): Promise<boolean> {
  const parsed = parseAniListCallbackHash(hash);
  if (!parsed || !browser) return false;
  const ttlSec = parsed.expiresInSec > 0 ? parsed.expiresInSec : DEFAULT_TTL_SEC;
  try {
    localStorage.setItem(TOKEN_KEY, parsed.accessToken);
    localStorage.setItem(EXPIRES_KEY, String(Date.now() + ttlSec * 1000));
    _anilistConnected.set(true);
  } catch (error) {
    console.warn('[anilist-auth] Failed to store AniList token:', error);
    return false;
  }
  try {
    const data = await anilistRequest<{ Viewer: AniListUser | null }>(
      'query { Viewer { id name } }',
      {},
      parsed.accessToken
    );
    if (data.Viewer) {
      const user = { id: data.Viewer.id, name: data.Viewer.name };
      localStorage.setItem(USER_KEY, JSON.stringify(user));
      _anilistUser.set(user);
    }
  } catch (error) {
    if (error instanceof AniListError && error.code === 'UNAUTHORIZED') {
      // The token AniList just issued was rejected outright — drop it rather
      // than leave a session around that will only 401 again later.
      handleAniListUnauthorized();
    } else {
      console.warn('[anilist-auth] Viewer lookup failed:', error);
    }
  }
  return true;
}

/** Return-route saved by startAniListLogin(); cleared on read. */
export function consumeAniListReturnHash(): string | null {
  if (!browser) return null;
  const value = sessionStorage.getItem(RETURN_KEY);
  sessionStorage.removeItem(RETURN_KEY);
  return value;
}

export function disconnectAniList(): void {
  clearAniListSession();
}

/** 401 from AniList: drop the session and tell the user; pending pushes stay queued. */
export function handleAniListUnauthorized(): void {
  clearAniListSession();
  showSnackbar('AniList session expired — reconnect in Settings');
}
