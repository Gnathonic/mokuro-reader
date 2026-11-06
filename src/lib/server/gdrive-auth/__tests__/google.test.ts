import { describe, expect, it, vi } from 'vitest';
import {
  exchangeCode,
  googleEndpoints,
  grantsDriveFile,
  refreshAccessToken,
  remainingBudget,
  revokeToken,
  GOOGLE_BUDGET_MS,
  GOOGLE_TIMEOUT_MS,
  MIN_GOOGLE_TIMEOUT_MS
} from '../google';
import { fakeGoogle, tokenAnswer, type GoogleAnswer } from './helpers';

const endpoints = { token: 'https://google.test/token', revoke: 'https://google.test/revoke' };
const client = { clientId: 'cid', clientSecret: 'secret' };

async function refreshWith(answer: GoogleAnswer) {
  const google = fakeGoogle(() => answer);
  return refreshAccessToken(google.fetch, endpoints, client, 'rt');
}

describe('Google error mapping', () => {
  it('maps a token answer to the access token and its lifetime', async () => {
    expect(await refreshWith(tokenAnswer())).toEqual({
      kind: 'ok',
      accessToken: 'ya29.test-access',
      expiresIn: 3599,
      scope: 'https://www.googleapis.com/auth/drive.file'
    });
    expect(await refreshWith(tokenAnswer({ refresh_token: '1//rotated' }))).toMatchObject({
      refreshToken: '1//rotated'
    });
  });

  it('only invalid_grant means the session is dead', async () => {
    expect(
      await refreshWith({
        status: 400,
        body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }
      })
    ).toEqual({ kind: 'invalid_grant', googleError: 'invalid_grant' });
  });

  it.each([
    [401, 'invalid_client'],
    [401, 'deleted_client'],
    [400, 'unauthorized_client'],
    [400, 'invalid_request'],
    [400, 'redirect_uri_mismatch'],
    [400, 'something_new']
  ])('%i %s is our configuration, never the user’s session', async (status, error) => {
    const outcome = await refreshWith({ status, body: { error, error_description: 'detail' } });
    expect(outcome).toEqual({ kind: 'server_config', googleError: error });
  });

  it.each([
    ['a 500', { status: 500, body: { error: 'internal_failure' } }],
    ['a 503 page', { status: 503, text: '<html>down</html>' }],
    ['a 429', { status: 429, body: { error: 'rate_limit_exceeded' } }],
    ['a network failure', 'network' as const],
    ['a 200 without a token', { status: 200, body: { expires_in: 3600 } }],
    ['a 200 with a nonsense lifetime', tokenAnswer({ expires_in: -5 })],
    ['a 200 that is not JSON', { status: 200, text: 'ok' }]
  ])('%s is transient', async (_label, answer) => {
    const outcome = await refreshWith(answer as GoogleAnswer);
    expect(outcome.kind).toBe('transient');
  });

  it('a timeout is transient (every call carries an abort signal)', async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = (_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return Promise.reject(new DOMException('The operation was aborted.', 'TimeoutError'));
    };
    const outcome = await refreshAccessToken(fetchImpl, endpoints, client, 'rt');
    expect(outcome).toEqual({ kind: 'transient', googleError: 'network' });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(GOOGLE_TIMEOUT_MS).toBe(5000);
  });

  it('never passes Google’s error_description on, and never a non-code error string', async () => {
    const outcome = await refreshWith({
      status: 400,
      body: { error: 'Some <script> sentence', error_description: 'leak me' }
    });
    expect(outcome).toEqual({ kind: 'server_config', googleError: 'unknown' });
    expect(JSON.stringify(outcome)).not.toContain('leak me');
  });
});

describe('what goes to Google', () => {
  it('a code exchange: a form POST with the PKCE verifier and the secret in the BODY', async () => {
    const google = fakeGoogle(() => tokenAnswer({ refresh_token: '1//rt' }));
    await exchangeCode(google.fetch, endpoints, client, {
      code: '4/code',
      codeVerifier: 'v'.repeat(43),
      redirectUri: 'https://reader.example/oauth/google-callback.html'
    });
    const [call] = google.calls;
    expect(call.url).toBe(endpoints.token);
    expect(call.init.method).toBe('POST');
    expect(new Headers(call.init.headers).get('content-type')).toBe(
      'application/x-www-form-urlencoded'
    );
    expect(call.form).toEqual({
      grant_type: 'authorization_code',
      code: '4/code',
      code_verifier: 'v'.repeat(43),
      redirect_uri: 'https://reader.example/oauth/google-callback.html',
      client_id: 'cid',
      client_secret: 'secret'
    });
    expect(call.url).not.toContain('secret');
  });

  it('a refresh: grant_type refresh_token', async () => {
    const google = fakeGoogle(() => tokenAnswer());
    await refreshAccessToken(google.fetch, endpoints, client, '1//rt');
    expect(google.calls[0].form).toEqual({
      grant_type: 'refresh_token',
      refresh_token: '1//rt',
      client_id: 'cid',
      client_secret: 'secret'
    });
  });

  it('a revoke: the token in the body, never the URL; never throws', async () => {
    const google = fakeGoogle(() => ({ status: 200, body: {} }));
    expect(await revokeToken(google.fetch, endpoints, '1//rt')).toEqual({ revoked: true });
    expect(google.calls[0].url).toBe(endpoints.revoke);
    expect(google.calls[0].form).toEqual({ token: '1//rt' });

    const down = fakeGoogle(() => 'network');
    expect(await revokeToken(down.fetch, endpoints, '1//rt')).toEqual({
      revoked: false,
      googleError: 'network'
    });
    const refused = fakeGoogle(() => ({ status: 400, body: { error: 'invalid_token' } }));
    expect(await revokeToken(refused.fetch, endpoints, '1//rt')).toEqual({
      revoked: false,
      googleError: 'invalid_token'
    });
  });
});

describe('the endpoints', () => {
  it('are Google’s own unless a test mode names a stand-in', () => {
    expect(googleEndpoints({})).toEqual({
      token: 'https://oauth2.googleapis.com/token',
      revoke: 'https://oauth2.googleapis.com/revoke'
    });
    // Vitest runs in the `test` mode, one of the two that read the hook.
    expect(googleEndpoints({ GDRIVE_TEST_GOOGLE_ORIGIN: 'http://127.0.0.1:9' })).toEqual({
      token: 'http://127.0.0.1:9/token',
      revoke: 'http://127.0.0.1:9/revoke'
    });
  });

  it('the Drive file scope must be among the granted ones', () => {
    expect(grantsDriveFile('https://www.googleapis.com/auth/drive.file')).toBe(true);
    expect(grantsDriveFile('openid https://www.googleapis.com/auth/drive.file email')).toBe(true);
    expect(grantsDriveFile('https://www.googleapis.com/auth/drive.file.extra')).toBe(false);
    expect(grantsDriveFile('')).toBe(false);
    expect(grantsDriveFile(undefined)).toBe(false);
  });
});

describe('the time budget', () => {
  it('a follow-up call gets what the first left of the budget, at least a second, never more than one call’s timeout', () => {
    expect(remainingBudget(0)).toBe(GOOGLE_TIMEOUT_MS);
    expect(remainingBudget(4500)).toBe(GOOGLE_BUDGET_MS - 4500);
    expect(remainingBudget(GOOGLE_TIMEOUT_MS)).toBe(GOOGLE_BUDGET_MS - GOOGLE_TIMEOUT_MS);
    expect(remainingBudget(60_000)).toBe(MIN_GOOGLE_TIMEOUT_MS);
    expect(remainingBudget(-5)).toBe(GOOGLE_TIMEOUT_MS);
    // A timed-out first call plus the longest follow-up still fit under the
    // routes' maxDuration (10 s) with room for the function.
    expect(GOOGLE_TIMEOUT_MS + remainingBudget(GOOGLE_TIMEOUT_MS)).toBeLessThanOrEqual(8000);
  });

  it('a revoke takes the timeout it is given', async () => {
    const timeouts: number[] = [];
    const real = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      timeouts.push(ms);
      return real(ms);
    });
    const google = fakeGoogle(() => ({ status: 200, body: {} }));
    await revokeToken(google.fetch, endpoints, 'rt', 1234);
    await revokeToken(google.fetch, endpoints, 'rt');
    spy.mockRestore();
    expect(timeouts).toEqual([1234, GOOGLE_TIMEOUT_MS]);
  });
});
