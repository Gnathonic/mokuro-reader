/**
 * mokuro-bunko identity-endpoint client.
 *
 * mokuro-bunko >= 0.1.4 exposes `GET /login/api/me`, which reports whether the
 * supplied credentials (Basic, or a bunko >= 0.5.1 bearer token) are valid and
 * which permissions the account has.
 * This lets the reader detect bad credentials reliably (a bare PROPFIND
 * "succeeds" anonymously on mokuro-bunko, so a connection test alone cannot).
 *
 * Anything that does not look exactly like the new endpoint resolves to
 * `unsupported`, in which case callers must fall back to the existing
 * generic-WebDAV heuristics (copyparty, nextcloud, nginx, older mokuro-bunko).
 *
 * This module must stay dependency-free (no Svelte / $app imports).
 */
import { webdavAuthorization } from '../../core/providers/webdav-authorization';
import type {
  AddFilesPermissions,
  CuratedScope,
  CuratedVolume,
  SeriesMetadataPermissions
} from '../../provider-interface';

export interface ServerPermissions {
  canWriteProgress: boolean;
  canAddFiles: boolean;
  canModifyDelete: boolean;
  /**
   * Per-series metadata (names/links/tag/unit/spine offsets) edit scope. Absent = no
   * restriction — an older bunko that doesn't report the field, or a plain WebDAV server.
   */
  metadata?: SeriesMetadataPermissions;
  /**
   * Who may publish the shared `curated` layer (bunko >= 0.8): `all` any
   * volume, `owned` the volumes this account controls, `none` never. Absent =
   * not reported (an older bunko keeps no curated layer). `volumes` (only under
   * `owned`): its uploads in series folders it does not own; absent = not
   * reported, so only `metadata.ownedSeries`.
   */
  curated?: { scope: CuratedScope; volumes?: CuratedVolume[] };
  /**
   * Where this account may add files (bunko >= 0.8 records series owners):
   * `all` anywhere, `open` every series but `closedSeries` (owned by other
   * accounts), `none` nowhere. Its PRESENCE says the server enforces series
   * owners; absent = an older bunko, where no series is closed.
   */
  addFiles?: AddFilesPermissions;
}

export type IdentityResult =
  | {
      kind: 'authenticated';
      username: string;
      role: string;
      permissions: ServerPermissions;
      /** The `/login/api/me` URL that answered (the bunko root's mount, subpath or origin). */
      endpoint?: string;
      /** The server's own version, when it reports one (bunko >= 0.8.0). */
      serverVersion?: string;
      /** Root files the server keeps per account (`per_user_files`), when it reports them. */
      perUserFiles?: string[];
      /**
       * Layer ids the server keeps per account (`per_user_layers`, bunko >= 0.8:
       * `edit` covers `edit` and `edit-<n>`). Absent = it keeps them shared.
       */
      perUserLayers?: string[];
    }
  | { kind: 'invalid-credentials' }
  | { kind: 'rate-limited' } // recognizable 429
  // 200 authenticated:false when NO creds were sent
  | { kind: 'anonymous'; serverVersion?: string; perUserFiles?: string[]; perUserLayers?: string[] }
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

/** Like the metadata scope: `open` with no (or a non-array) `closedSeries` closes nothing. */
function normalizeAddFilesPermissions(value: unknown): AddFilesPermissions | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const a = value as Record<string, unknown>;
  if (a.scope !== 'all' && a.scope !== 'open' && a.scope !== 'none') return undefined;
  if (a.scope !== 'open') return { scope: a.scope };
  const closedSeries = Array.isArray(a.closedSeries)
    ? a.closedSeries.filter((s): s is string => typeof s === 'string')
    : [];
  return { scope: 'open', closedSeries };
}

/**
 * `curated`, or nothing: anything but one of the three scopes = not reported.
 * A non-array `volumes` is not reported either (an older bunko: the owned
 * series only), and an entry without both strings is dropped.
 */
function normalizeCuratedPermissions(value: unknown): ServerPermissions['curated'] {
  if (!value || typeof value !== 'object') return undefined;
  const c = value as Record<string, unknown>;
  if (c.scope !== 'all' && c.scope !== 'owned' && c.scope !== 'none') return undefined;
  if (c.scope !== 'owned' || !Array.isArray(c.volumes)) return { scope: c.scope };
  const volumes = c.volumes.flatMap((v: unknown) => {
    const e = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
    return typeof e?.series === 'string' && typeof e.volume === 'string'
      ? [{ series: e.series, volume: e.volume }]
      : [];
  });
  return { scope: 'owned', volumes };
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
  const curated = normalizeCuratedPermissions(p.curated);
  if (curated) permissions.curated = curated;
  const addFiles = normalizeAddFilesPermissions(p.addFiles);
  if (addFiles) permissions.addFiles = addFiles;
  return permissions;
}

/** A top-level string-array field, or nothing: anything else is "not reported". */
function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((f) => typeof f === 'string')
    ? (value as string[])
    : undefined;
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
  // bunko >= 0.8.0 reports its version; older servers simply omit it.
  const version =
    typeof record?.version === 'string' && record.version ? { serverVersion: record.version } : {};
  // Root files and layer ids the server keeps per account.
  const files = stringList(record?.per_user_files);
  const layers = stringList(record?.per_user_layers);
  const perUser = {
    ...(files ? { perUserFiles: files } : {}),
    ...(layers ? { perUserLayers: layers } : {})
  };

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
          permissions,
          ...version,
          ...perUser
        };
      }
      // 200 "authenticated" without a permissions object is not the contract shape
      return { kind: 'unsupported' };
    }
    if (authenticated === false) {
      return credsSent
        ? { kind: 'invalid-credentials' }
        : { kind: 'anonymous', ...version, ...perUser };
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

/**
 * `token`, when given, is sent instead of the password (`webdavAuthorization`):
 * a dead token answers `invalid-credentials`, which the caller turns into a
 * re-issue from the stored password.
 */
export async function fetchServerIdentity(
  serverUrl: string,
  username?: string,
  password?: string,
  fetchImpl: typeof fetch = fetch,
  token?: string | null
): Promise<IdentityResult> {
  const authorization = webdavAuthorization({ username, password, token });
  const credsSent = !!authorization;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (authorization) {
    headers.Authorization = authorization;
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
      if (result) return result.kind === 'authenticated' ? { ...result, endpoint: url } : result;
    } catch {
      // network error / timeout: try the next candidate
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return { kind: 'unsupported' };
}
