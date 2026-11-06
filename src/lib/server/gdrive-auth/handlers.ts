/**
 * The three Drive auth routes: `/api/gdrive/session` (redeem a sign-in's code
 * and set the sealed refresh cookie), `/api/gdrive/refresh` (a fresh access
 * token from the cookie) and `/api/gdrive/logout` (clear, and with
 * `everywhere: true` also revoke).
 *
 * The browser never sees the refresh token: it lives sealed in an HttpOnly
 * cookie (`seal.ts`), optionally bound to a device key (`pop.ts`). There is no
 * database — the cookie IS the session. Every answer is JSON with
 * `Cache-Control: no-store` and one of the fixed error codes (`http.ts`).
 */
import { readAuthConfig, type AuthConfig, type AuthEnv } from './config';
import {
  exchangeCode,
  googleEndpoints,
  grantsDriveFile,
  refreshAccessToken,
  remainingBudget,
  revokeToken,
  type FetchLike
} from './google';
import {
  clearSessionCookie,
  cookieName,
  fail,
  logAuth,
  readSessionCookie,
  reply,
  setSessionCookie,
  validateRequest,
  type AuthEvent,
  type RouteName
} from './http';
import { checkProof, parseProof } from './pop';
import {
  needsReseal,
  seal,
  sessionExpired,
  unseal,
  SealTooLargeError,
  type SealContext,
  type SessionPayload
} from './seal';

export interface AuthDeps {
  env: AuthEnv;
  fetch?: FetchLike;
  now?: () => number;
}

/** The static page Google redirects back to (`static/oauth/`). */
export const CALLBACK_PATH = '/oauth/google-callback.html';
export const SESSION_PATH = '/api/gdrive/session';
export const REFRESH_PATH = '/api/gdrive/refresh';

/** An authorization code: printable ASCII without spaces (RFC 6749 VSCHAR). */
const CODE_PATTERN = /^[\x21-\x7e]{1,512}$/;
/** RFC 7636 §4.1: 43–128 unreserved characters. */
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

function sealContext(event: AuthEvent, config: AuthConfig): SealContext {
  return {
    clientId: config.clientId,
    origin: event.url.origin,
    cookieName: cookieName(event.url)
  };
}

/** Run a handler body; anything it throws is a logged 500, never SvelteKit's error page. */
async function guarded(route: RouteName, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    logAuth({
      route,
      status: 500,
      event: `exception:${error instanceof Error ? error.name : 'unknown'}`
    });
    return fail(500, 'internal');
  }
}

export function handleSession(event: AuthEvent, deps: AuthDeps): Promise<Response> {
  const route: RouteName = 'session';
  return guarded(route, async () => {
    const validated = await validateRequest(event);
    if (!validated.ok) {
      logAuth({ route, status: validated.response.status, event: validated.event });
      return validated.response;
    }
    const config = readAuthConfig(deps.env);
    if (!config) {
      logAuth({ route, status: 501, event: 'not_configured' });
      return fail(501, 'not_configured');
    }
    const now = (deps.now ?? Date.now)();
    const { code, code_verifier: codeVerifier, pop } = validated.body;
    if (
      typeof code !== 'string' ||
      !CODE_PATTERN.test(code) ||
      typeof codeVerifier !== 'string' ||
      !VERIFIER_PATTERN.test(codeVerifier)
    ) {
      logAuth({ route, status: 400, event: 'bad_code' });
      return fail(400, 'bad_request');
    }

    // Bind the session to the device key that signed this request, if any.
    // Checked BEFORE the code is redeemed: a clock retry must still find the
    // code unused. With GDRIVE_POP=off a bad proof only leaves the session
    // unbound; it never blocks a sign-in.
    let cnf: string | undefined;
    if (pop !== undefined && pop !== null) {
      const proof = parseProof(pop);
      const check = proof ? checkProof(proof, event.url.origin, SESSION_PATH, now) : null;
      if (check?.ok) {
        cnf = check.thumbprint;
      } else if (config.popRequired) {
        if (check?.reason === 'clock') {
          logAuth({ route, status: 401, event: 'pop_clock' });
          return fail(401, 'pop_clock', { serverTime: now });
        }
        logAuth({ route, status: 400, event: check ? `pop_${check.reason}` : 'pop_malformed' });
        return fail(400, 'bad_request');
      }
    }

    const fetchImpl = deps.fetch ?? defaultFetch;
    const endpoints = googleEndpoints(deps.env);
    // Wall-clock time, not deps.now: this measures the function's own budget.
    const exchangeStarted = Date.now();
    const outcome = await exchangeCode(fetchImpl, endpoints, config, {
      code,
      codeVerifier,
      redirectUri: event.url.origin + CALLBACK_PATH
    });

    if (outcome.kind === 'invalid_grant') {
      logAuth({ route, status: 401, event: 'code_rejected', googleError: outcome.googleError });
      return fail(401, 'reauth');
    }
    if (outcome.kind === 'server_config') {
      logAuth({ route, status: 503, event: 'server_config', googleError: outcome.googleError });
      return fail(503, 'server_config');
    }
    if (outcome.kind === 'transient') {
      logAuth({ route, status: 503, event: 'transient', googleError: outcome.googleError });
      return fail(503, 'transient');
    }

    // A grant we will not keep is revoked at once, so the next consent starts
    // clean (and, without a refresh token, is sure to get one).
    const refuse = async (
      why: string,
      status: number,
      error: 'consent_incomplete' | 'internal'
    ) => {
      // Both Google calls must fit under maxDuration: were the function killed
      // mid-revoke, the client would get a non-JSON 504 and the grant this
      // was meant to end would stay live.
      await revokeToken(
        fetchImpl,
        endpoints,
        outcome.refreshToken ?? outcome.accessToken,
        remainingBudget(Date.now() - exchangeStarted)
      );
      logAuth({ route, status, event: why });
      return fail(status, error);
    };
    if (!grantsDriveFile(outcome.scope)) return refuse('scope_missing', 403, 'consent_incomplete');
    if (!outcome.refreshToken) return refuse('no_refresh_token', 403, 'consent_incomplete');

    const payload: SessionPayload = {
      rt: outcome.refreshToken,
      iat0: now,
      ts: now,
      ...(cnf ? { cnf } : {})
    };
    let sealed: string;
    try {
      sealed = seal(payload, config.current, sealContext(event, config));
    } catch (error) {
      if (error instanceof SealTooLargeError) return refuse('cookie_too_large', 500, 'internal');
      throw error;
    }
    setSessionCookie(event, sealed);
    logAuth({
      route,
      status: 200,
      event: cnf ? 'signed_in_bound' : 'signed_in',
      kid: config.current.kid
    });
    return reply(200, { access_token: outcome.accessToken, expires_in: outcome.expiresIn });
  });
}

export function handleRefresh(event: AuthEvent, deps: AuthDeps): Promise<Response> {
  const route: RouteName = 'refresh';
  return guarded(route, async () => {
    const validated = await validateRequest(event);
    if (!validated.ok) {
      logAuth({ route, status: validated.response.status, event: validated.event });
      return validated.response;
    }
    const config = readAuthConfig(deps.env);
    if (!config) {
      logAuth({ route, status: 501, event: 'not_configured' });
      return fail(501, 'not_configured');
    }

    const value = readSessionCookie(event);
    if (!value) {
      logAuth({ route, status: 401, event: 'no_cookie' });
      return fail(401, 'no_session');
    }

    const now = (deps.now ?? Date.now)();
    const opened = unseal(value, config, sealContext(event, config));
    if (!opened.ok) {
      // A key id this deployment does not hold says nothing against the
      // cookie: it is THIS deployment that lacks the key (an Instant Rollback
      // past a rotation, a deployment with the wrong key). Deleting it would
      // sign the user out for good; kept, it opens again once a deployment
      // with the key serves. A cookie under a dropped key stays unopenable
      // either way, and a sign-in overwrites it. Every other failure is the
      // cookie's own (garbage, tampered, replayed elsewhere): cleared.
      if (opened.reason !== 'unknown_kid') clearSessionCookie(event);
      logAuth({ route, status: 401, event: `cookie_${opened.reason}` });
      return fail(401, 'reauth');
    }
    const kid = opened.sealedWith === 'current' ? config.current.kid : config.previous?.kid;
    const session = opened.payload;
    if (sessionExpired(session, now)) {
      clearSessionCookie(event);
      logAuth({ route, status: 401, event: 'expired', kid });
      return fail(401, 'reauth');
    }

    // A bound session refreshes only for the device holding its key. A failed
    // proof leaves the cookie in place: it is worthless without the key, and
    // clearing it would turn a passing storage glitch on the client (its key
    // database unreadable for one page load) into a sign-out.
    if (session.cnf && config.popRequired) {
      const pop = validated.body.pop;
      if (pop === undefined || pop === null) {
        logAuth({ route, status: 401, event: 'pop_missing', kid });
        return fail(401, 'reauth');
      }
      const proof = parseProof(pop);
      if (!proof) {
        logAuth({ route, status: 400, event: 'pop_malformed', kid });
        return fail(400, 'bad_request');
      }
      const check = checkProof(proof, event.url.origin, REFRESH_PATH, now);
      if (!check.ok && check.reason === 'clock') {
        logAuth({ route, status: 401, event: 'pop_clock', kid });
        return fail(401, 'pop_clock', { serverTime: now });
      }
      if (!check.ok || check.thumbprint !== session.cnf) {
        logAuth({
          route,
          status: 401,
          event: check.ok ? 'pop_mismatch' : `pop_${check.reason}`,
          kid
        });
        return fail(401, 'reauth');
      }
    }

    const outcome = await refreshAccessToken(
      deps.fetch ?? defaultFetch,
      googleEndpoints(deps.env),
      config,
      session.rt
    );
    if (outcome.kind === 'invalid_grant') {
      clearSessionCookie(event);
      logAuth({
        route,
        status: 401,
        event: 'grant_revoked',
        googleError: outcome.googleError,
        kid
      });
      return fail(401, 'reauth');
    }
    if (outcome.kind === 'server_config') {
      // Keep the cookie: a rotated or mistyped secret must not sign out every user.
      logAuth({
        route,
        status: 503,
        event: 'server_config',
        googleError: outcome.googleError,
        kid
      });
      return fail(503, 'server_config');
    }
    if (outcome.kind === 'transient') {
      logAuth({ route, status: 503, event: 'transient', googleError: outcome.googleError, kid });
      return fail(503, 'transient');
    }

    // Google rarely rotates a refresh token; when it does, the new one is the
    // one to keep. Otherwise re-seal only to rotate keys or slide the window.
    const rotated = !!outcome.refreshToken && outcome.refreshToken !== session.rt;
    let logEvent = 'refreshed';
    if (rotated || needsReseal(opened, now)) {
      try {
        setSessionCookie(
          event,
          seal(
            { ...session, rt: outcome.refreshToken ?? session.rt, ts: now },
            config.current,
            sealContext(event, config)
          )
        );
        logEvent = 'refreshed_resealed';
      } catch (error) {
        if (!(error instanceof SealTooLargeError)) throw error;
        // The old cookie stays: it still works until its own expiry.
        logEvent = 'refreshed_reseal_too_large';
      }
    }
    logAuth({ route, status: 200, event: logEvent, kid: config.current.kid });
    return reply(200, { access_token: outcome.accessToken, expires_in: outcome.expiresIn });
  });
}

/**
 * Sign out. The body is optional: `{ everywhere?: boolean }`.
 *
 * - **This device** (absent, `{}`, `everywhere: false`): the cookie is cleared
 *   and Google is NOT asked. Google revokes per Cloud project, not per client,
 *   so a revoke would also sign out every other device and any mokuro-bunko
 *   server holding a grant from the same project. The client deletes its
 *   device key alongside, so a copy of a BOUND cookie can never refresh again
 *   (no proof is possible) — but only while proofs are required. An unbound
 *   session's copy, or any copy while `GDRIVE_POP=off`, stays usable until it
 *   expires; nothing here can end it short of a revoke (no database by
 *   design), so the answer says so and the client tells the user.
 * - **Everywhere** (`everywhere: true`): the refresh token is revoked at
 *   Google, which ends the whole grant, then the cookie is cleared.
 *
 * Both answer `{ ok: true, revoked, invalidated }`. A device sign-out always
 * says `revoked: false` (the client must not take that as a cue to revoke
 * itself); `invalidated` is whether copies of the cookie are now useless —
 * for a device sign-out, anything but a live unbound session (or any live
 * session while `GDRIVE_POP=off`); for everywhere, the revoke itself.
 */
export function handleLogout(event: AuthEvent, deps: AuthDeps): Promise<Response> {
  const route: RouteName = 'logout';
  return guarded(route, async () => {
    const validated = await validateRequest(event, { allowEmptyBody: true });
    if (!validated.ok) {
      logAuth({ route, status: validated.response.status, event: validated.event });
      return validated.response;
    }
    // Checked before anything is cleared: a malformed request changes nothing.
    const scope = validated.body.everywhere;
    if (scope !== undefined && typeof scope !== 'boolean') {
      logAuth({ route, status: 400, event: 'bad_scope' });
      return fail(400, 'bad_request');
    }
    const everywhere = scope === true;
    const config = readAuthConfig(deps.env);
    if (!config) {
      // Nothing to revoke with, but the cookie still goes.
      clearSessionCookie(event);
      logAuth({ route, status: 501, event: 'not_configured' });
      return fail(501, 'not_configured');
    }

    // No proof needed: signing out must work from a device that lost its key.
    const value = readSessionCookie(event);
    let outcome = 'no_cookie';
    let googleError: string | undefined;
    let kid: string | undefined;
    // A device sign-out leaves a usable copy only when a live session opens
    // below and is not bound under required proofs. No cookie, or one this
    // server cannot open, leaves nothing a copy could use (the server could
    // not open the copy either). An everywhere sign-out counts only a revoke.
    let invalidated = !everywhere;
    if (value) {
      const opened = unseal(value, config, sealContext(event, config));
      if (!opened.ok) {
        outcome = `cookie_${opened.reason}`;
      } else {
        kid = opened.sealedWith === 'current' ? config.current.kid : config.previous?.kid;
        if (!everywhere) {
          // An expired session is refused by /refresh whatever it carries.
          const expired = sessionExpired(opened.payload, (deps.now ?? Date.now)());
          invalidated = expired || (config.popRequired && !!opened.payload.cnf);
          outcome = invalidated
            ? 'device_cleared'
            : !opened.payload.cnf
              ? 'device_cleared_unbound'
              : 'device_cleared_pop_off';
        } else {
          // Even an expired session's token is revoked: it may still be live at Google.
          const revoked = await revokeToken(
            deps.fetch ?? defaultFetch,
            googleEndpoints(deps.env),
            opened.payload.rt
          );
          outcome = revoked.revoked ? 'revoked' : 'revoke_failed';
          invalidated = revoked.revoked;
          googleError = revoked.googleError;
        }
      }
    }
    clearSessionCookie(event);
    logAuth({ route, status: 200, event: outcome, googleError, kid });
    // `revoked` says whether THIS server ended the grant at Google. On an
    // everywhere sign-out, anything short of that (Google down, a cookie
    // sealed under a retired key, no cookie at all) leaves the client to
    // revoke the access token it holds: revoking either token of a grant ends
    // the whole grant.
    return reply(200, { ok: true, revoked: outcome === 'revoked', invalidated });
  });
}
