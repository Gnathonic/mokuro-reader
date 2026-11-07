/**
 * Request validation, responses, the cookie's name and attributes, and the
 * log line: everything the three routes share before and after their own work.
 */
import { json, type Cookies } from '@sveltejs/kit';

/** What a handler needs from SvelteKit's RequestEvent (a test passes a fake). */
export interface AuthEvent {
  request: Request;
  url: URL;
  cookies: Pick<Cookies, 'get' | 'set' | 'delete'>;
}

/** The ONLY error codes the routes ever answer with. */
export type AuthErrorCode =
  | 'method_not_allowed'
  | 'unsupported_media_type'
  | 'forbidden'
  | 'payload_too_large'
  | 'bad_request'
  | 'not_configured'
  | 'no_session'
  | 'reauth'
  | 'pop_clock'
  | 'consent_incomplete'
  | 'transient'
  | 'server_config'
  | 'internal';

export type RouteName = 'session' | 'refresh' | 'logout';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * A JSON answer that no cache keeps. Every route answers through this (or
 * `fail`), never `throw error()`: SvelteKit's error path parses the Accept
 * header, which these routes must never reach.
 */
export function reply(
  status: number,
  body: Record<string, unknown>,
  extra?: HeadersInit
): Response {
  const headers = new Headers(NO_STORE);
  if (extra) new Headers(extra).forEach((value, name) => headers.set(name, value));
  return json(body, { status, headers });
}

export function fail(
  status: number,
  error: AuthErrorCode,
  extra?: Record<string, unknown>,
  headers?: HeadersInit
): Response {
  return reply(status, { error, ...(extra ?? {}) }, headers);
}

/** Any method but POST (SvelteKit's `fallback`). */
export function methodNotAllowed(): Response {
  return fail(405, 'method_not_allowed', undefined, { Allow: 'POST' });
}

/**
 * One line per request: the route, the status, what happened and, where there
 * is one, Google's error code and the key id. Never a token, a code, a cookie
 * or a body — the call sites pass only these fields.
 */
export function logAuth(fields: {
  route: RouteName;
  status: number;
  event: string;
  googleError?: string;
  kid?: string;
}): void {
  const line = JSON.stringify({ scope: 'gdrive-auth', ...fields });
  if (fields.status >= 500) console.error(line);
  else if (fields.status >= 400) console.warn(line);
  else console.log(line);
}

export const BODY_LIMIT_BYTES = 4096;

class BodyTooLarge extends Error {}

/**
 * Read at most `limit` bytes of the body. Counted while streaming, because a
 * Content-Length check alone is bypassed by a chunked body.
 */
async function readCapped(request: Request, limit: number): Promise<Uint8Array> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > limit) throw new BodyTooLarge();
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      // Stop reading, but never cancel: SvelteKit's Node stream answers a
      // cancel by destroying the socket, and the 413 would never be sent. The
      // stream applies backpressure (it pauses the request once its small
      // queue is full), so nothing more is buffered.
      reader.releaseLock();
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export type Validated =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: Response; event: string };

/**
 * The checks every route runs before any crypto or Google call: JSON only,
 * same-origin only (the Origin header must name the request's own origin, any
 * Sec-Fetch-Site must be `same-origin` — SameSite=Strict alone lets a sibling
 * subdomain through), the custom X-Requested-With header (no form or simple
 * request can set it), and a body of at most BODY_LIMIT_BYTES that parses to
 * a JSON object. POST only is the route's own export (`fallback` answers the
 * rest). `allowEmptyBody`: an empty body reads as `{}` (every other check
 * still applies — `/logout`, whose body is optional).
 */
export async function validateRequest(
  event: AuthEvent,
  options: { allowEmptyBody?: boolean } = {}
): Promise<Validated> {
  const { request, url } = event;
  const reject = (status: number, error: AuthErrorCode, why: string): Validated => ({
    ok: false,
    response: fail(status, error),
    event: why
  });

  if (request.method !== 'POST') {
    return { ok: false, response: methodNotAllowed(), event: 'method' };
  }

  const contentType = (request.headers.get('content-type') ?? '').split(';')[0].trim();
  if (contentType.toLowerCase() !== 'application/json') {
    return reject(415, 'unsupported_media_type', 'content_type');
  }

  const origin = request.headers.get('origin');
  if (!origin || origin !== url.origin) return reject(403, 'forbidden', 'origin');

  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite !== null && fetchSite !== 'same-origin') {
    return reject(403, 'forbidden', 'sec_fetch_site');
  }

  if (request.headers.get('x-requested-with') !== 'XMLHttpRequest') {
    return reject(403, 'forbidden', 'x_requested_with');
  }

  let raw: Uint8Array;
  try {
    raw = await readCapped(request, BODY_LIMIT_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLarge) return reject(413, 'payload_too_large', 'body_size');
    return reject(400, 'bad_request', 'body_read');
  }

  if (raw.byteLength === 0 && options.allowEmptyBody) return { ok: true, body: {} };

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    return reject(400, 'bad_request', 'body_json');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return reject(400, 'bad_request', 'body_shape');
  }
  return { ok: true, body: body as Record<string, unknown> };
}

// ------------------------------------------------------------------ the cookie

/** 180 days, the same as the server-side idle limit. */
export const COOKIE_MAX_AGE_S = 180 * 24 * 60 * 60;

/** Plain HTTP on this machine: a browser refuses `__Host-` and `Secure` there. */
export function isLoopbackHttp(url: URL): boolean {
  if (url.protocol !== 'http:') return false;
  const host = url.hostname;
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '[::1]' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/**
 * `__Host-gdrive_rt` everywhere — the prefix makes the browser refuse the
 * cookie unless it is Secure, Path=/ and has no Domain, so no sibling host can
 * plant or shadow it. Only plain HTTP on loopback (the dev server) uses the
 * bare name, which the browser would otherwise drop. A plain-named cookie is
 * never read over HTTPS.
 */
export function cookieName(url: URL): string {
  return isLoopbackHttp(url) ? 'gdrive_rt' : '__Host-gdrive_rt';
}

function cookieAttributes(url: URL) {
  return {
    path: '/',
    httpOnly: true,
    secure: !isLoopbackHttp(url),
    sameSite: 'strict' as const
  };
}

export function setSessionCookie(event: AuthEvent, value: string): void {
  event.cookies.set(cookieName(event.url), value, {
    ...cookieAttributes(event.url),
    maxAge: COOKIE_MAX_AGE_S
  });
}

export function clearSessionCookie(event: AuthEvent): void {
  // A deletion must carry the same attributes, or the browser keeps a
  // `__Host-` cookie.
  event.cookies.delete(cookieName(event.url), cookieAttributes(event.url));
}

export function readSessionCookie(event: AuthEvent): string | undefined {
  return event.cookies.get(cookieName(event.url)) || undefined;
}
