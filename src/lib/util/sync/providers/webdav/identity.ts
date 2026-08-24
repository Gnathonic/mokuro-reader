/**
 * mokuro-bunko identity-endpoint client.
 *
 * mokuro-bunko >= 0.1.4 exposes `GET /login/api/me`, which reports whether the
 * supplied Basic credentials are valid and which permissions the account has.
 * This lets the reader detect bad credentials reliably (a bare PROPFIND
 * "succeeds" anonymously on mokuro-bunko, so a connection test alone cannot).
 *
 * Anything that does not look exactly like the new endpoint resolves to
 * `unsupported`, in which case callers must fall back to the existing
 * generic-WebDAV heuristics (copyparty, nextcloud, nginx, older mokuro-bunko).
 *
 * This module must stay dependency-free (no Svelte / $app imports).
 */
import { basicAuthHeader } from '$lib/util/base64';
import type { SeriesMetadataPermissions } from '../../provider-interface';

export interface ServerPermissions {
  canWriteProgress: boolean;
  canAddFiles: boolean;
  canModifyDelete: boolean;
  /**
   * Per-series metadata (names/links/tag/unit/spine offsets) edit scope. Absent = no
   * restriction — an older bunko that doesn't report the field, or a plain WebDAV server.
   */
  metadata?: SeriesMetadataPermissions;
}

export type IdentityResult =
  | { kind: 'authenticated'; username: string; role: string; permissions: ServerPermissions }
  | { kind: 'invalid-credentials' }
  | { kind: 'rate-limited' } // recognizable 429
  | { kind: 'anonymous' } // 200 authenticated:false when NO creds were sent
  | { kind: 'unsupported' }; // anything unrecognizable -> generic WebDAV server

const REQUEST_TIMEOUT_MS = 10000;

/** Derive candidate /login/api/me URLs: subpath mount first, then origin root. */
function deriveCandidateUrls(serverUrl: string): string[] {
  const baseWithSlash = serverUrl.endsWith('/') ? serverUrl : serverUrl + '/';
  const candidates: string[] = [];
  try {
    const subpath = new URL('login/api/me', baseWithSlash).toString();
    const root = new URL('/login/api/me', baseWithSlash).toString();
    candidates.push(subpath);
    if (root !== subpath) candidates.push(root);
  } catch {
    // Invalid base URL - no candidates, caller resolves to unsupported
  }
  return candidates;
}

/** `scope: 'owned'` with no (or a non-array) `ownedSeries` is treated as an empty list, not
 * a parse failure — the scope itself is still meaningful (nothing is owned yet). */
function normalizeMetadataPermissions(value: unknown): SeriesMetadataPermissions | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const m = value as Record<string, unknown>;
  if (m.scope !== 'all' && m.scope !== 'owned' && m.scope !== 'none') return undefined;
  if (m.scope !== 'owned') return { scope: m.scope };
  const ownedSeries = Array.isArray(m.ownedSeries)
    ? m.ownedSeries.filter((s): s is string => typeof s === 'string')
    : [];
  return { scope: 'owned', ownedSeries };
}

function normalizePermissions(value: unknown): ServerPermissions | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as Record<string, unknown>;
  const permissions: ServerPermissions = {
    canWriteProgress: p.canWriteProgress === true,
    canAddFiles: p.canAddFiles === true,
    canModifyDelete: p.canModifyDelete === true
  };
  const metadata = normalizeMetadataPermissions(p.metadata);
  if (metadata) permissions.metadata = metadata;
  return permissions;
}

/** Terminal result for this candidate, or null to advance to the next one. */
function interpretResponse(
  status: number,
  body: unknown,
  credsSent: boolean,
  jsonParsed: boolean
): IdentityResult | null {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  const authenticated = record?.authenticated;

  if (status === 200) {
    // A non-JSON 200 (reverse proxy default page, SPA fallback serving the app
    // shell for the subpath candidate) is not recognizably ours - it must NOT
    // terminate the search, or it masks a working /login/api/me at the origin
    // root. Only a parsed-JSON 200 is terminal.
    if (!jsonParsed) return null;
    if (authenticated === true) {
      const permissions = normalizePermissions(record?.permissions);
      if (permissions) {
        return {
          kind: 'authenticated',
          username: typeof record?.username === 'string' ? record.username : '',
          role: typeof record?.role === 'string' ? record.role : '',
          permissions
        };
      }
      // 200 "authenticated" without a permissions object is not the contract shape
      return { kind: 'unsupported' };
    }
    if (authenticated === false) {
      return credsSent ? { kind: 'invalid-credentials' } : { kind: 'anonymous' };
    }
    // H1: 200 without a boolean `authenticated` field = old mokuro-bunko
    // (<= 0.1.3 returned {username, role, created_at}) or some other server.
    return { kind: 'unsupported' };
  }

  if (status === 401) {
    // H2: only a JSON body carrying authenticated:false is recognizably ours;
    // an nginx/old-bunko 401 must NOT surface as invalid credentials.
    if (authenticated === false) return { kind: 'invalid-credentials' };
    return null;
  }

  if (status === 429) {
    if (authenticated === false) return { kind: 'rate-limited' };
    return null;
  }

  // 404 / 405 / 5xx / anything else: try the next candidate
  return null;
}

export async function fetchServerIdentity(
  serverUrl: string,
  username?: string,
  password?: string,
  fetchImpl: typeof fetch = fetch
): Promise<IdentityResult> {
  const credsSent = !!password; // header rule: Authorization iff password non-empty
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (credsSent) {
    headers.Authorization = basicAuthHeader(username ?? '', password!);
  }

  for (const url of deriveCandidateUrls(serverUrl)) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers,
        signal: controller.signal
      });

      let body: unknown = null;
      let jsonParsed = false;
      try {
        body = await response.json();
        jsonParsed = true;
      } catch {
        body = null; // non-JSON body: only recognizable via status rules below
      }

      const result = interpretResponse(response.status, body, credsSent, jsonParsed);
      if (result) return result;
    } catch {
      // network error / timeout: try the next candidate
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return { kind: 'unsupported' };
}
