/**
 * The three routes end to end: request in, a scripted Google behind, cookie and
 * JSON out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleLogout, handleRefresh, handleSession, type AuthDeps } from '../handlers';
import { readAuthConfig } from '../config';
import { jwkThumbprint } from '../pop';
import { seal, unseal, type SessionPayload } from '../seal';
import {
  authEvent,
  bodyOf,
  CookieJar,
  deviceKey,
  fakeGoogle,
  ORIGIN,
  testEnv,
  throwawayKey,
  tokenAnswer,
  type GoogleAnswer
} from './helpers';

const NOW = Date.UTC(2026, 10, 3, 12);
const DAY = 24 * 60 * 60 * 1000;
const COOKIE = '__Host-gdrive_rt';
const VERIFIER = 'a'.repeat(43);
const CODE = '4/0Atest-code';

let logs: string[];
beforeEach(() => {
  logs = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
  }
});
afterEach(() => vi.restoreAllMocks());

function setup(envOverrides: Record<string, string | undefined> = {}) {
  const env = testEnv(envOverrides);
  const config = readAuthConfig(env)!;
  const jar = new CookieJar();
  const context = (name = COOKIE, origin = ORIGIN) => ({
    clientId: config.clientId,
    origin,
    cookieName: name
  });
  return {
    env,
    config,
    jar,
    /** Put a sealed session in the jar, as an earlier sign-in would have. */
    plant(payload: Partial<SessionPayload> = {}) {
      const value = seal(
        { rt: '1//planted', iat0: NOW - DAY, ts: NOW - DAY, ...payload },
        config.current,
        context()
      );
      jar.values.set(COOKIE, value);
      return value;
    },
    /** The session the jar now holds. */
    session() {
      const value = jar.values.get(COOKIE);
      if (!value) return null;
      const opened = unseal(value, config, context());
      return opened.ok ? opened.payload : 'unreadable';
    },
    deps(answer: (call: { url: string; form: Record<string, string> }) => GoogleAnswer) {
      const google = fakeGoogle(answer);
      const deps: AuthDeps = { env, fetch: google.fetch, now: () => NOW };
      return { deps, calls: google.calls };
    }
  };
}

/** Nothing secret ever reaches a log line. */
function expectCleanLogs(...secrets: string[]) {
  for (const line of logs) {
    for (const secret of secrets) expect(line).not.toContain(secret);
  }
}

describe('POST /api/gdrive/session', () => {
  const sessionEvent = (jar: CookieJar, body: Record<string, unknown>) =>
    authEvent({ path: '/api/gdrive/session', jar, body });

  it('redeems the code, seals the refresh token into the cookie and returns only the access token', async () => {
    const s = setup();
    const { deps, calls } = s.deps(() => tokenAnswer({ refresh_token: '1//fresh-rt' }));
    const response = await handleSession(
      sessionEvent(s.jar, { code: CODE, code_verifier: VERIFIER }),
      deps
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await bodyOf(response)).toEqual({ access_token: 'ya29.test-access', expires_in: 3599 });

    expect(calls).toHaveLength(1);
    expect(calls[0].form).toMatchObject({
      grant_type: 'authorization_code',
      code: CODE,
      code_verifier: VERIFIER,
      // Built from the request's own origin, never configuration or a header.
      redirect_uri: `${ORIGIN}/oauth/google-callback.html`,
      client_secret: 'test-secret-not-real'
    });

    expect(s.jar.sets).toHaveLength(1);
    expect(s.jar.sets[0].name).toBe(COOKIE);
    expect(s.session()).toEqual({ rt: '1//fresh-rt', iat0: NOW, ts: NOW });
    expectCleanLogs('1//fresh-rt', 'ya29.test-access', CODE, VERIFIER, s.jar.sets[0].value);
  });

  it('binds the session to the device key that signed a valid proof', async () => {
    const s = setup();
    const key = await deviceKey();
    const { deps } = s.deps(() => tokenAnswer({ refresh_token: '1//rt' }));
    const pop = await key.prove('/api/gdrive/session', NOW);
    const response = await handleSession(
      sessionEvent(s.jar, { code: CODE, code_verifier: VERIFIER, pop }),
      deps
    );
    expect(response.status).toBe(200);
    expect(s.session()).toMatchObject({ cnf: jwkThumbprint(key.jwk) });
  });

  it('a proof off by more than ten minutes: pop_clock with the server time, and the code is NOT spent', async () => {
    const s = setup();
    const key = await deviceKey();
    const { deps, calls } = s.deps(() => tokenAnswer({ refresh_token: '1//rt' }));
    const pop = await key.prove('/api/gdrive/session', NOW - 20 * 60 * 1000);
    const response = await handleSession(
      sessionEvent(s.jar, { code: CODE, code_verifier: VERIFIER, pop }),
      deps
    );
    expect(response.status).toBe(401);
    expect(await bodyOf(response)).toEqual({ error: 'pop_clock', serverTime: NOW });
    expect(calls).toHaveLength(0);
    expect(s.jar.sets).toHaveLength(0);
  });

  it('a proof signed for another route is refused before Google is asked', async () => {
    const s = setup();
    const key = await deviceKey();
    const { deps, calls } = s.deps(() => tokenAnswer({ refresh_token: '1//rt' }));
    const pop = await key.prove('/api/gdrive/refresh', NOW);
    const response = await handleSession(
      sessionEvent(s.jar, { code: CODE, code_verifier: VERIFIER, pop }),
      deps
    );
    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toEqual({ error: 'bad_request' });
    expect(calls).toHaveLength(0);
  });

  it('with GDRIVE_POP=off a bad proof only leaves the session unbound', async () => {
    const s = setup({ GDRIVE_POP: 'off' });
    const key = await deviceKey();
    const { deps } = s.deps(() => tokenAnswer({ refresh_token: '1//rt' }));
    const pop = await key.prove('/api/gdrive/refresh', NOW);
    const response = await handleSession(
      sessionEvent(s.jar, { code: CODE, code_verifier: VERIFIER, pop }),
      deps
    );
    expect(response.status).toBe(200);
    expect(s.session()).toEqual({ rt: '1//rt', iat0: NOW, ts: NOW });
  });

  it.each([
    ['no code', { code_verifier: VERIFIER }],
    ['a code with a space', { code: '4/a b', code_verifier: VERIFIER }],
    ['an over-long code', { code: 'c'.repeat(513), code_verifier: VERIFIER }],
    ['a short verifier', { code: CODE, code_verifier: 'a'.repeat(42) }],
    ['a long verifier', { code: CODE, code_verifier: 'a'.repeat(129) }],
    ['a verifier outside RFC 7636', { code: CODE, code_verifier: 'a'.repeat(42) + '+' }],
    ['a number for a code', { code: 7, code_verifier: VERIFIER }]
  ])('refuses %s without calling Google', async (_label, body) => {
    const s = setup();
    const { deps, calls } = s.deps(() => tokenAnswer({ refresh_token: '1//rt' }));
    const response = await handleSession(sessionEvent(s.jar, body), deps);
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('a used or expired code: reauth, and an existing cookie is left alone', async () => {
    const s = setup();
    s.plant();
    const { deps } = s.deps(() => ({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'Bad Request' }
    }));
    const response = await handleSession(
      sessionEvent(s.jar, { code: CODE, code_verifier: VERIFIER }),
      deps
    );
    expect(response.status).toBe(401);
    expect(await bodyOf(response)).toEqual({ error: 'reauth' });
    expect(s.jar.sets).toHaveLength(0);
    expect(s.jar.deletes).toHaveLength(0);
  });

  it.each([
    ['no refresh token', tokenAnswer()],
    ['no Drive scope', tokenAnswer({ refresh_token: '1//rt', scope: 'openid' })]
  ])('%s: consent_incomplete, no cookie, and the grant is revoked', async (_label, answer) => {
    const s = setup();
    const { deps, calls } = s.deps((call) =>
      call.url.endsWith('/revoke') ? { status: 200, body: {} } : answer
    );
    const response = await handleSession(
      sessionEvent(s.jar, { code: CODE, code_verifier: VERIFIER }),
      deps
    );
    expect(response.status).toBe(403);
    expect(await bodyOf(response)).toEqual({ error: 'consent_incomplete' });
    expect(s.jar.sets).toHaveLength(0);
    expect(calls.map((c) => c.url)).toEqual([
      'https://oauth2.googleapis.com/token',
      'https://oauth2.googleapis.com/revoke'
    ]);
  });

  it('a refused grant’s revoke gets only what the code exchange left of the time budget', async () => {
    const s = setup();
    let clock = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const timeouts: number[] = [];
    const real = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      timeouts.push(ms);
      return real(ms);
    });
    const { deps } = s.deps((call) => {
      if (call.url.endsWith('/revoke')) return { status: 200, body: {} };
      clock += 6000; // a slow exchange
      return tokenAnswer();
    });
    const response = await handleSession(
      sessionEvent(s.jar, { code: CODE, code_verifier: VERIFIER }),
      deps
    );
    expect(response.status).toBe(403);
    // 5 s for the exchange; the revoke gets 8 − 6 = 2 s, so both fit maxDuration.
    expect(timeouts).toEqual([5000, 2000]);
  });

  it.each([
    ['invalid_client', 401, 503, 'server_config'],
    ['redirect_uri_mismatch', 400, 503, 'server_config'],
    ['backend_error', 500, 503, 'transient']
  ])('Google %s → %i… → %i %s, no cookie', async (googleError, googleStatus, status, error) => {
    const s = setup();
    const { deps } = s.deps(() => ({
      status: googleStatus,
      body: { error: googleError, error_description: 'do not forward me' }
    }));
    const response = await handleSession(
      sessionEvent(s.jar, { code: CODE, code_verifier: VERIFIER }),
      deps
    );
    expect(response.status).toBe(status);
    const body = await bodyOf(response);
    expect(body).toEqual({ error });
    expect(JSON.stringify(body)).not.toContain('do not forward me');
    expect(s.jar.sets).toHaveLength(0);
  });

  it('not configured: 501 before anything else happens', async () => {
    const s = setup({ GDRIVE_SESSION_KEY: 'too-short' });
    const { deps, calls } = s.deps(() => tokenAnswer({ refresh_token: '1//rt' }));
    const response = await handleSession(
      sessionEvent(s.jar, { code: CODE, code_verifier: VERIFIER }),
      deps
    );
    expect(response.status).toBe(501);
    expect(await bodyOf(response)).toEqual({ error: 'not_configured' });
    expect(calls).toHaveLength(0);
  });

  it('a failing request check never reaches Google', async () => {
    const s = setup();
    const { deps, calls } = s.deps(() => tokenAnswer({ refresh_token: '1//rt' }));
    const event = authEvent({
      path: '/api/gdrive/session',
      jar: s.jar,
      body: { code: CODE, code_verifier: VERIFIER },
      headers: { origin: 'https://evil.example' }
    });
    expect((await handleSession(event, deps)).status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe('POST /api/gdrive/refresh', () => {
  const refreshEvent = (jar: CookieJar, body: Record<string, unknown> = {}) =>
    authEvent({ path: '/api/gdrive/refresh', jar, body });

  it('no cookie: no_session, and Google is never asked', async () => {
    const s = setup();
    const { deps, calls } = s.deps(() => tokenAnswer());
    const response = await handleRefresh(refreshEvent(s.jar), deps);
    expect(response.status).toBe(401);
    expect(await bodyOf(response)).toEqual({ error: 'no_session' });
    expect(calls).toHaveLength(0);
  });

  it('a fresh access token from the cookie; no Set-Cookie while ts is under a week old', async () => {
    const s = setup();
    s.plant({ ts: NOW - 6 * DAY });
    const { deps, calls } = s.deps(() => tokenAnswer());
    const response = await handleRefresh(refreshEvent(s.jar), deps);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await bodyOf(response)).toEqual({ access_token: 'ya29.test-access', expires_in: 3599 });
    expect(calls[0].form).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: '1//planted'
    });
    expect(s.jar.sets).toHaveLength(0);
    expectCleanLogs('1//planted', 'ya29.test-access');
  });

  it('slides: a ts over a week old is re-sealed with a new ts and the SAME iat0 and binding', async () => {
    const s = setup();
    s.plant({ iat0: NOW - 100 * DAY, ts: NOW - 8 * DAY, cnf: 'C'.repeat(43) });
    const { deps } = s.deps(() => tokenAnswer());
    // POP off here only to keep this test about sliding, not proofs.
    const response = await handleRefresh(refreshEvent(s.jar), {
      ...deps,
      env: { ...s.env, GDRIVE_POP: 'off' }
    });
    expect(response.status).toBe(200);
    expect(s.jar.sets).toHaveLength(1);
    expect(s.session()).toEqual({
      rt: '1//planted',
      iat0: NOW - 100 * DAY,
      ts: NOW,
      cnf: 'C'.repeat(43)
    });
  });

  it('a rotated refresh token from Google is the one kept', async () => {
    const s = setup();
    s.plant();
    const { deps } = s.deps(() => tokenAnswer({ refresh_token: '1//rotated' }));
    await handleRefresh(refreshEvent(s.jar), deps);
    expect(s.session()).toMatchObject({ rt: '1//rotated', ts: NOW });
  });

  it('key rotation: a cookie sealed with the previous key works and is re-sealed with the current one', async () => {
    const oldKey = throwawayKey();
    const before = setup({ GDRIVE_SESSION_KEY: oldKey });
    const oldValue = before.plant();

    const s = setup({ GDRIVE_SESSION_KEY: throwawayKey(), GDRIVE_SESSION_KEY_PREV: oldKey });
    s.jar.values.set(COOKIE, oldValue);
    const { deps } = s.deps(() => tokenAnswer());
    const response = await handleRefresh(refreshEvent(s.jar), deps);
    expect(response.status).toBe(200);
    expect(s.jar.sets).toHaveLength(1);
    expect(s.jar.sets[0].value.split('.')[1]).toBe(s.config.current.kid);
    expect(s.session()).toMatchObject({ rt: '1//planted', ts: NOW });
  });

  it('an undecryptable cookie (garbage): reauth, the cookie is cleared, Google never asked', async () => {
    const s = setup();
    s.jar.values.set(COOKIE, 'not-a-sealed-value');
    const { deps, calls } = s.deps(() => tokenAnswer());
    const response = await handleRefresh(refreshEvent(s.jar), deps);
    expect(response.status).toBe(401);
    expect(await bodyOf(response)).toEqual({ error: 'reauth' });
    expect(s.jar.deletes.map((d) => d.name)).toEqual([COOKIE]);
    expect(calls).toHaveLength(0);
  });

  it('a cookie under a known key that fails its tag (tampered): reauth and cleared', async () => {
    const s = setup();
    const [v, kid, iv, body] = s.plant().split('.');
    const flipped = body.slice(0, -2) + (body.endsWith('AA') ? 'BB' : 'AA');
    s.jar.values.set(COOKIE, [v, kid, iv, flipped].join('.'));
    const { deps, calls } = s.deps(() => tokenAnswer());
    const response = await handleRefresh(refreshEvent(s.jar), deps);
    expect(response.status).toBe(401);
    expect(await bodyOf(response)).toEqual({ error: 'reauth' });
    expect(s.jar.deletes.map((d) => d.name)).toEqual([COOKIE]);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ event: 'cookie_bad_tag' });
  });

  it('a cookie sealed under a key this deployment does not have: reauth, Google never asked, cookie KEPT', async () => {
    // A rollback past a key rotation, or a deployment with the wrong key:
    // the fault is this deployment's, not the cookie's. Deleting it would
    // sign the user out for good; kept, it opens again once the deployment
    // with the key is back.
    const s = setup();
    const withKey = setup();
    const value = withKey.plant();
    s.jar.values.set(COOKIE, value);
    const { deps, calls } = s.deps(() => tokenAnswer());
    const response = await handleRefresh(refreshEvent(s.jar), deps);
    expect(response.status).toBe(401);
    expect(await bodyOf(response)).toEqual({ error: 'reauth' });
    expect(s.jar.deletes).toHaveLength(0);
    expect(s.jar.sets).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ event: 'cookie_unknown_kid' });

    // Rolled forward: the deployment with the key refreshes the same cookie.
    withKey.jar.values.set(COOKIE, s.jar.values.get(COOKIE)!);
    const again = withKey.deps(() => tokenAnswer());
    expect((await handleRefresh(refreshEvent(withKey.jar), again.deps)).status).toBe(200);
  });

  it('a cookie replayed against another origin does not open (the AAD names the origin)', async () => {
    const s = setup();
    s.plant();
    const { deps, calls } = s.deps(() => tokenAnswer());
    const event = authEvent({
      origin: 'https://other.example',
      path: '/api/gdrive/refresh',
      jar: s.jar
    });
    const response = await handleRefresh(event, deps);
    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['idle for 181 days', { ts: NOW - 181 * DAY, iat0: NOW - 181 * DAY }],
    ['366 days since consent', { ts: NOW - DAY, iat0: NOW - 366 * DAY }]
  ])('expired server-side (%s): reauth and cleared, whatever the Max-Age', async (_l, stamps) => {
    const s = setup();
    s.plant(stamps);
    const { deps, calls } = s.deps(() => tokenAnswer());
    const response = await handleRefresh(refreshEvent(s.jar), deps);
    expect(response.status).toBe(401);
    expect(await bodyOf(response)).toEqual({ error: 'reauth' });
    expect(s.jar.deletes).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  it('Google invalid_grant: reauth and the cookie is cleared', async () => {
    const s = setup();
    s.plant();
    const { deps } = s.deps(() => ({ status: 400, body: { error: 'invalid_grant' } }));
    const response = await handleRefresh(refreshEvent(s.jar), deps);
    expect(response.status).toBe(401);
    expect(await bodyOf(response)).toEqual({ error: 'reauth' });
    expect(s.jar.deletes).toHaveLength(1);
  });

  it.each([
    ['invalid_client', 401, 'server_config'],
    ['deleted_client', 401, 'server_config'],
    ['unauthorized_client', 400, 'server_config'],
    ['invalid_request', 400, 'server_config'],
    ['backend_error', 500, 'transient'],
    ['rate_limit_exceeded', 429, 'transient']
  ])('Google %s: 503 %s and the cookie is KEPT', async (googleError, status, error) => {
    const s = setup();
    s.plant();
    const { deps } = s.deps(() => ({ status, body: { error: googleError } }));
    const response = await handleRefresh(refreshEvent(s.jar), deps);
    expect(response.status).toBe(503);
    expect(await bodyOf(response)).toEqual({ error });
    expect(s.jar.deletes).toHaveLength(0);
    expect(s.jar.sets).toHaveLength(0);
  });

  it('Google unreachable or slow: 503 transient, cookie kept', async () => {
    const s = setup();
    s.plant();
    const { deps } = s.deps(() => 'network');
    const response = await handleRefresh(refreshEvent(s.jar), deps);
    expect(response.status).toBe(503);
    expect(await bodyOf(response)).toEqual({ error: 'transient' });
    expect(s.jar.deletes).toHaveLength(0);
  });

  describe('a bound session', () => {
    async function bound() {
      const s = setup();
      const key = await deviceKey();
      s.plant({ cnf: jwkThumbprint(key.jwk) });
      return { s, key };
    }

    it('refreshes with a proof from its key', async () => {
      const { s, key } = await bound();
      const { deps } = s.deps(() => tokenAnswer());
      const pop = await key.prove('/api/gdrive/refresh', NOW);
      const response = await handleRefresh(refreshEvent(s.jar, { pop }), deps);
      expect(response.status).toBe(200);
    });

    it('without a proof: reauth, Google never asked, and the cookie stays (it is useless without the key)', async () => {
      const { s } = await bound();
      const { deps, calls } = s.deps(() => tokenAnswer());
      const response = await handleRefresh(refreshEvent(s.jar), deps);
      expect(response.status).toBe(401);
      expect(await bodyOf(response)).toEqual({ error: 'reauth' });
      expect(calls).toHaveLength(0);
      expect(s.jar.deletes).toHaveLength(0);
    });

    it('a proof from another key (a copied cookie on another machine): reauth', async () => {
      const { s } = await bound();
      const thief = await deviceKey();
      const { deps, calls } = s.deps(() => tokenAnswer());
      const pop = await thief.prove('/api/gdrive/refresh', NOW);
      const response = await handleRefresh(refreshEvent(s.jar, { pop }), deps);
      expect(response.status).toBe(401);
      expect(calls).toHaveLength(0);
    });

    it('a session proof replayed at /refresh is refused (the path is signed)', async () => {
      const { s, key } = await bound();
      const { deps, calls } = s.deps(() => tokenAnswer());
      const pop = await key.prove('/api/gdrive/session', NOW);
      const response = await handleRefresh(refreshEvent(s.jar, { pop }), deps);
      expect(response.status).toBe(401);
      expect(calls).toHaveLength(0);
    });

    it('a skewed clock: pop_clock with the server time, cookie untouched', async () => {
      const { s, key } = await bound();
      const { deps, calls } = s.deps(() => tokenAnswer());
      const pop = await key.prove('/api/gdrive/refresh', NOW + 11 * 60 * 1000);
      const response = await handleRefresh(refreshEvent(s.jar, { pop }), deps);
      expect(response.status).toBe(401);
      expect(await bodyOf(response)).toEqual({ error: 'pop_clock', serverTime: NOW });
      expect(calls).toHaveLength(0);
      expect(s.jar.deletes).toHaveLength(0);
    });

    it('a malformed proof: bad_request', async () => {
      const { s } = await bound();
      const { deps } = s.deps(() => tokenAnswer());
      const response = await handleRefresh(refreshEvent(s.jar, { pop: { ts: NOW } }), deps);
      expect(response.status).toBe(400);
    });

    it('GDRIVE_POP=off: the escape hatch refreshes without a proof', async () => {
      const { s } = await bound();
      const { deps } = s.deps(() => tokenAnswer());
      const response = await handleRefresh(refreshEvent(s.jar), {
        ...deps,
        env: { ...s.env, GDRIVE_POP: 'off' }
      });
      expect(response.status).toBe(200);
    });
  });

  it('never binds an existing cookie: an unbound session stays unbound whatever proof comes along', async () => {
    const s = setup();
    s.plant({ ts: NOW - 8 * DAY }); // old enough to be re-sealed
    const key = await deviceKey();
    const { deps } = s.deps(() => tokenAnswer());
    const pop = await key.prove('/api/gdrive/refresh', NOW);
    const response = await handleRefresh(refreshEvent(s.jar, { pop }), deps);
    expect(response.status).toBe(200);
    expect(s.jar.sets).toHaveLength(1);
    expect(s.session()).not.toHaveProperty('cnf');
  });

  it('a rebind attempt on a bound session (another key, re-sealed) is refused and the binding kept', async () => {
    const s = setup();
    const owner = await deviceKey();
    s.plant({ ts: NOW - 8 * DAY, cnf: jwkThumbprint(owner.jwk) });
    const other = await deviceKey();
    const { deps } = s.deps(() => tokenAnswer());
    const pop = await other.prove('/api/gdrive/refresh', NOW);
    expect((await handleRefresh(refreshEvent(s.jar, { pop }), deps)).status).toBe(401);
    expect(s.jar.sets).toHaveLength(0);
    // The owner still refreshes, and the re-seal keeps the owner's binding.
    const ownPop = await owner.prove('/api/gdrive/refresh', NOW);
    expect((await handleRefresh(refreshEvent(s.jar, { pop: ownPop }), deps)).status).toBe(200);
    expect(s.session()).toMatchObject({ cnf: jwkThumbprint(owner.jwk) });
  });
});

describe('POST /api/gdrive/logout', () => {
  const logoutEvent = (jar: CookieJar, extra: Parameters<typeof authEvent>[0] = {}) =>
    authEvent({ path: '/api/gdrive/logout', jar, ...extra });
  const everywhereEvent = (jar: CookieJar, extra: Parameters<typeof authEvent>[0] = {}) =>
    logoutEvent(jar, { body: { everywhere: true }, ...extra });

  describe('this device only (the default)', () => {
    it.each([
      ['no body at all', { rawBody: null }],
      ['an empty body', { rawBody: '' }],
      ['{}', { body: {} }],
      ['{ everywhere: false }', { body: { everywhere: false } }]
    ] as const)(
      '%s: Google is never asked, the cookie is cleared, and a bound copy is now useless',
      async (_label, extra) => {
        const s = setup();
        const key = await deviceKey();
        s.plant({ cnf: jwkThumbprint(key.jwk) });
        const { deps, calls } = s.deps(() => ({ status: 200, body: {} }));
        const response = await handleLogout(logoutEvent(s.jar, { ...extra }), deps);
        expect(response.status).toBe(200);
        expect(await bodyOf(response)).toEqual({ ok: true, revoked: false, invalidated: true });
        expect(calls).toHaveLength(0);
        expect(s.jar.deletes.map((d) => d.name)).toEqual([COOKIE]);
        expect(JSON.parse(logs.at(-1)!)).toMatchObject({
          route: 'logout',
          status: 200,
          event: 'device_cleared',
          kid: s.config.current.kid
        });
        expectCleanLogs('1//planted');
      }
    );

    it('an unbound session is cleared the same way, but a copy is NOT made useless — and it says so', async () => {
      const s = setup();
      s.plant();
      const { deps, calls } = s.deps(() => ({ status: 200, body: {} }));
      const response = await handleLogout(logoutEvent(s.jar), deps);
      expect(await bodyOf(response)).toEqual({ ok: true, revoked: false, invalidated: false });
      expect(calls).toHaveLength(0);
      expect(s.jar.deletes).toHaveLength(1);
      expect(JSON.parse(logs.at(-1)!)).toMatchObject({ event: 'device_cleared_unbound' });
    });

    it('an expired unbound session: /refresh refuses any copy anyway, so invalidated: true', async () => {
      const s = setup();
      s.plant({ ts: NOW - 200 * DAY, iat0: NOW - 400 * DAY });
      const { deps, calls } = s.deps(() => ({ status: 200, body: {} }));
      const response = await handleLogout(logoutEvent(s.jar), deps);
      expect(await bodyOf(response)).toEqual({ ok: true, revoked: false, invalidated: true });
      expect(calls).toHaveLength(0);
      expect(s.jar.deletes).toHaveLength(1);
    });

    it('GDRIVE_POP=off: even a bound session’s copy stays usable, so invalidated: false', async () => {
      const s = setup({ GDRIVE_POP: 'off' });
      const key = await deviceKey();
      s.plant({ cnf: jwkThumbprint(key.jwk) });
      const { deps, calls } = s.deps(() => ({ status: 200, body: {} }));
      const response = await handleLogout(logoutEvent(s.jar), deps);
      expect(await bodyOf(response)).toEqual({ ok: true, revoked: false, invalidated: false });
      expect(calls).toHaveLength(0);
      expect(s.jar.deletes).toHaveLength(1);
      expect(JSON.parse(logs.at(-1)!)).toMatchObject({ event: 'device_cleared_pop_off' });
    });

    it.each([
      ['a bad cookie', () => 'garbage'],
      ['a cookie under a retired key', () => setup().plant()],
      ['no cookie', () => undefined]
    ])(
      '%s: no revoke, still cleared, still 200, and nothing a copy could use',
      async (_l, value) => {
        const s = setup();
        const planted = value();
        if (planted) s.jar.values.set(COOKIE, planted);
        const { deps, calls } = s.deps(() => ({ status: 200, body: {} }));
        const response = await handleLogout(logoutEvent(s.jar), deps);
        expect(response.status).toBe(200);
        // No cookie, or one this server cannot open: a copy could not be opened
        // either, so no warning is due.
        expect(await bodyOf(response)).toEqual({ ok: true, revoked: false, invalidated: true });
        expect(calls).toHaveLength(0);
        expect(s.jar.deletes).toHaveLength(1);
      }
    );
  });

  describe('a malformed request', () => {
    it.each([
      ['everywhere as a string', { body: { everywhere: 'true' } }],
      ['everywhere as a number', { body: { everywhere: 1 } }],
      ['everywhere: null', { body: { everywhere: null } }],
      ['bad JSON', { rawBody: '{"everywhere": tru' }],
      ['a JSON array', { rawBody: '[true]' }]
    ] as const)('%s: 400, Google never asked, the cookie left alone', async (_label, extra) => {
      const s = setup();
      s.plant();
      const { deps, calls } = s.deps(() => ({ status: 200, body: {} }));
      const response = await handleLogout(logoutEvent(s.jar, { ...extra }), deps);
      expect(response.status).toBe(400);
      expect(await bodyOf(response)).toEqual({ error: 'bad_request' });
      expect(calls).toHaveLength(0);
      expect(s.jar.deletes).toHaveLength(0);
    });

    it('an empty body still needs the JSON content type', async () => {
      const s = setup();
      s.plant();
      const { deps, calls } = s.deps(() => ({ status: 200, body: {} }));
      const response = await handleLogout(
        logoutEvent(s.jar, { rawBody: null, headers: { 'content-type': 'text/plain' } }),
        deps
      );
      expect(response.status).toBe(415);
      expect(calls).toHaveLength(0);
      expect(s.jar.deletes).toHaveLength(0);
    });

    it('an oversized body is 413, never revoked', async () => {
      const s = setup();
      s.plant();
      const { deps, calls } = s.deps(() => ({ status: 200, body: {} }));
      const response = await handleLogout(
        logoutEvent(s.jar, { body: { everywhere: true, pad: 'x'.repeat(5000) } }),
        deps
      );
      expect(response.status).toBe(413);
      expect(calls).toHaveLength(0);
      expect(s.jar.deletes).toHaveLength(0);
    });
  });

  describe('everywhere', () => {
    it('revokes the refresh token at Google (in the body) and clears the cookie', async () => {
      const s = setup();
      s.plant();
      const { deps, calls } = s.deps(() => ({ status: 200, body: {} }));
      const response = await handleLogout(everywhereEvent(s.jar), deps);
      expect(response.status).toBe(200);
      expect(await bodyOf(response)).toEqual({ ok: true, revoked: true, invalidated: true });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://oauth2.googleapis.com/revoke');
      expect(calls[0].form).toEqual({ token: '1//planted' });
      expect(s.jar.deletes.map((d) => d.name)).toEqual([COOKIE]);
      expectCleanLogs('1//planted');
    });

    it('needs no proof: a bound session signs out from a device that lost its key', async () => {
      const s = setup();
      const key = await deviceKey();
      s.plant({ cnf: jwkThumbprint(key.jwk) });
      const { deps, calls } = s.deps(() => ({ status: 200, body: {} }));
      expect((await handleLogout(everywhereEvent(s.jar), deps)).status).toBe(200);
      expect(calls).toHaveLength(1);
    });

    it('an expired session’s token is still revoked', async () => {
      const s = setup();
      s.plant({ ts: NOW - 200 * DAY, iat0: NOW - 400 * DAY });
      const { deps, calls } = s.deps(() => ({ status: 200, body: {} }));
      expect((await handleLogout(everywhereEvent(s.jar), deps)).status).toBe(200);
      expect(calls).toHaveLength(1);
    });

    it.each([
      ['a bad cookie', () => 'garbage'],
      // Sealed under a key this server no longer has (rotated out): unknown_kid.
      ['a cookie under a retired key', () => setup().plant()],
      ['no cookie', () => undefined]
    ])(
      '%s: no revoke, still cleared, still 200, and says it revoked nothing',
      async (_l, value) => {
        const s = setup();
        const planted = value();
        if (planted) s.jar.values.set(COOKIE, planted);
        const { deps, calls } = s.deps(() => ({ status: 200, body: {} }));
        const response = await handleLogout(everywhereEvent(s.jar), deps);
        expect(response.status).toBe(200);
        // The client must then revoke the access token it holds itself.
        expect(await bodyOf(response)).toEqual({ ok: true, revoked: false, invalidated: false });
        expect(calls).toHaveLength(0);
        expect(s.jar.deletes).toHaveLength(1);
      }
    );

    it('Google refusing or unreachable: still cleared, still 200, revoked: false', async () => {
      for (const answer of [
        'network',
        { status: 503, body: {} },
        { status: 400, body: { error: 'invalid_token' } }
      ] as const) {
        const s = setup();
        s.plant();
        const { deps } = s.deps(() => answer as GoogleAnswer);
        const response = await handleLogout(everywhereEvent(s.jar), deps);
        expect(response.status).toBe(200);
        expect(await bodyOf(response)).toEqual({ ok: true, revoked: false, invalidated: false });
        expect(s.jar.deletes).toHaveLength(1);
        expect(JSON.parse(logs.at(-1)!)).toMatchObject({ event: 'revoke_failed' });
      }
    });
  });

  it('a cross-site request is refused, and the cookie is NOT cleared (no logout CSRF)', async () => {
    for (const body of [{}, { everywhere: true }]) {
      const s = setup();
      s.plant();
      const { deps, calls } = s.deps(() => ({ status: 200, body: {} }));
      const response = await handleLogout(
        logoutEvent(s.jar, { body, headers: { 'sec-fetch-site': 'cross-site' } }),
        deps
      );
      expect(response.status).toBe(403);
      expect(calls).toHaveLength(0);
      expect(s.jar.deletes).toHaveLength(0);
    }
  });

  it('not configured: the cookie still goes, in either scope', async () => {
    for (const body of [{}, { everywhere: true }]) {
      const s = setup();
      s.plant();
      const { deps, calls } = s.deps(() => ({ status: 200, body: {} }));
      const response = await handleLogout(logoutEvent(s.jar, { body }), {
        ...deps,
        env: { ...s.env, GDRIVE_CLIENT_SECRET: '' }
      });
      expect(response.status).toBe(501);
      expect(calls).toHaveLength(0);
      expect(s.jar.deletes).toHaveLength(1);
    }
  });
});

describe('every route', () => {
  it('an unexpected exception is a logged 500 JSON, never a thrown error page', async () => {
    const s = setup();
    s.plant();
    const deps: AuthDeps = {
      env: s.env,
      now: () => NOW,
      fetch: () => {
        throw new Error('boom 1//planted');
      }
    };
    // A synchronous throw from fetch is caught as a network failure: transient.
    expect((await handleRefresh(authEvent({ jar: s.jar }), deps)).status).toBe(503);
    const exploding: AuthDeps = {
      env: s.env,
      now: () => {
        throw new Error('clock 1//planted');
      }
    };
    const response = await handleRefresh(authEvent({ jar: s.jar }), exploding);
    expect(response.status).toBe(500);
    expect(await bodyOf(response)).toEqual({ error: 'internal' });
    expectCleanLogs('1//planted');
  });

  it('log lines carry only route, status, event, Google’s code and the key id', async () => {
    const s = setup();
    s.plant();
    const { deps } = s.deps(() => ({ status: 401, body: { error: 'invalid_client' } }));
    await handleRefresh(authEvent({ jar: s.jar }), deps);
    const line = JSON.parse(logs.at(-1)!);
    expect(line).toEqual({
      scope: 'gdrive-auth',
      route: 'refresh',
      status: 503,
      event: 'server_config',
      googleError: 'invalid_client',
      kid: s.config.current.kid
    });
  });
});
