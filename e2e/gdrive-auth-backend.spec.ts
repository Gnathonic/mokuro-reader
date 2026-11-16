/**
 * The Drive auth backend end to end, in a real browser: one sign-in (PKCE,
 * full-page redirect, the static callback page), a refresh cookie that is
 * HttpOnly and bound to this browser's device key, a silent renewal at the
 * next start, a sign-out on this device only (nothing revoked, the cookie and
 * the device key gone, an old copy of the cookie refused), and a confirmed
 * "sign out everywhere" that revokes at "Google" and clears the cookie.
 *
 * Nothing here talks to Google. The browser's side of Google (its scripts and
 * the consent screen) is answered by `page.route`. The SERVER's side — the
 * dev server's /api/gdrive/* routes calling the token and revoke endpoints —
 * goes to a fake Google run by this spec, through the one server-side test
 * hook, `GDRIVE_TEST_GOOGLE_ORIGIN`. That hook is read only in the `test` and
 * `interop` modes, a compile-time constant a production build folds away
 * (`scripts/check-no-test-hooks.mjs` proves it), so this spec starts its own
 * dev server in the interop mode with the backend switched on, and leaves the
 * suite's shared server alone — down to its generated files and dependency
 * cache (`gdrive-auth-backend.vite.config.ts`, `MOKURO_E2E_KIT_OUT_DIR`).
 */
import { expect, request, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { readAuthConfig } from '../src/lib/server/gdrive-auth/config';
import { unseal } from '../src/lib/server/gdrive-auth/seal';
import { signProof } from '../src/lib/util/sync/providers/google-drive/device-key';

const CLIENT_ID = 'e2e-client.apps.example';
const CLIENT_SECRET = 'e2e-secret-not-real';
const SESSION_KEY = randomBytes(32).toString('base64');
const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';
const REFRESH_TOKEN = '1//e2e-refresh-token';

test.describe.configure({ mode: 'serial' });

// ------------------------------------------------------------- a fake Google

interface GoogleRequest {
  path: string;
  form: Record<string, string>;
}

/** Google's token and revoke endpoints, as the server side sees them. */
class FakeGoogle {
  requests: GoogleRequest[] = [];
  /** code -> the PKCE challenge and redirect it was issued for (by the consent route). */
  codes = new Map<string, { challenge: string; redirectUri: string }>();
  revoked = new Set<string>();
  pkceVerified = 0;
  private minted = 0;
  private server: Server | null = null;

  async start(): Promise<string> {
    this.server = createServer(async (req, res) => {
      const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
      const path = req.url ?? '';
      this.requests.push({ path, form });
      const answer = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (path === '/revoke') {
        this.revoked.add(form.token);
        return answer(200, {});
      }
      if (path !== '/token') return answer(404, { error: 'not_found' });
      if (form.client_id !== CLIENT_ID || form.client_secret !== CLIENT_SECRET) {
        return answer(401, { error: 'invalid_client' });
      }
      if (form.grant_type === 'authorization_code') {
        const issued = this.codes.get(form.code);
        this.codes.delete(form.code); // one use
        const s256 = createHash('sha256')
          .update(form.code_verifier ?? '')
          .digest('base64url');
        if (!issued || issued.redirectUri !== form.redirect_uri || issued.challenge !== s256) {
          return answer(400, { error: 'invalid_grant', error_description: 'Bad Request' });
        }
        this.pkceVerified++;
        return answer(200, {
          access_token: `ya29.e2e-${++this.minted}`,
          expires_in: 3599,
          refresh_token: REFRESH_TOKEN,
          scope: DRIVE_FILE,
          token_type: 'Bearer'
        });
      }
      if (form.grant_type === 'refresh_token') {
        if (form.refresh_token !== REFRESH_TOKEN || this.revoked.has(REFRESH_TOKEN)) {
          return answer(400, { error: 'invalid_grant' });
        }
        return answer(200, {
          access_token: `ya29.e2e-${++this.minted}`,
          expires_in: 3599,
          scope: DRIVE_FILE,
          token_type: 'Bearer'
        });
      }
      return answer(400, { error: 'unsupported_grant_type' });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// ------------------------------------------------- the browser's side of Google

/** gapi and Google Identity Services, as inert stand-ins. */
const GAPI_STUB = `
window.gapi = {
  load: function (_name, cb) { setTimeout(cb, 0); },
  client: {
    init: function () { return Promise.resolve(); },
    setToken: function (t) { window.__e2eGapiToken = t; },
    getToken: function () { return window.__e2eGapiToken; },
    drive: {
      files: {
        list: function () { return Promise.resolve({ result: { files: [] } }); },
        create: function () { return Promise.resolve({ result: { id: 'e2e-folder' } }); },
        get: function () { return Promise.resolve({ result: {} }); },
        update: function () { return Promise.resolve({ result: {} }); },
        delete: function () { return Promise.resolve({ result: {} }); }
      },
      changes: {
        getStartPageToken: function () { return Promise.resolve({ result: { startPageToken: '1' } }); },
        list: function () { return Promise.resolve({ result: { changes: [], newStartPageToken: '1' } }); }
      }
    }
  }
};`;
const GIS_STUB = `
window.google = { accounts: { oauth2: {
  initTokenClient: function () { return { requestAccessToken: function () { window.__e2ePopupOpened = true; } }; }
} } };`;

async function routeGoogle(page: Page, google: FakeGoogle, consent: { url?: URL }) {
  await page.route('https://apis.google.com/**', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: GAPI_STUB })
  );
  await page.route('https://accounts.google.com/gsi/**', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: GIS_STUB })
  );
  // Drive's REST endpoints (uploads of the sync files): accepted, nothing kept.
  await page.route('https://www.googleapis.com/**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: 'e2e-file' }) })
  );
  // The consent screen: "the user agrees" — a code bound to the PKCE challenge.
  await page.route('https://accounts.google.com/o/oauth2/v2/auth**', (route) => {
    const url = new URL(route.request().url());
    consent.url = url;
    const code = `4/e2e-${randomBytes(6).toString('hex')}`;
    google.codes.set(code, {
      challenge: url.searchParams.get('code_challenge') ?? '',
      redirectUri: url.searchParams.get('redirect_uri') ?? ''
    });
    const back = new URL(url.searchParams.get('redirect_uri')!);
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state') ?? '');
    back.searchParams.set('scope', DRIVE_FILE);
    return route.fulfill({ status: 302, headers: { location: back.toString() } });
  });
}

// ------------------------------------------------------- the dev server

let google: FakeGoogle;
let devServer: ChildProcess | null = null;
let origin = '';

test.beforeAll(async () => {
  test.setTimeout(240_000);
  google = new FakeGoogle();
  const googleOrigin = await google.start();
  const port = await freePort();
  origin = `http://localhost:${port}`;
  devServer = spawn(
    process.execPath,
    [
      join('node_modules', 'vite', 'bin', 'vite.js'),
      'dev',
      // Its own dependency cache and SvelteKit output: a second server writing
      // the first one's generated entry modules full-reloads every page the
      // rest of the suite has open there (measured, not assumed).
      '--config',
      join('e2e', 'gdrive-auth-backend.vite.config.ts'),
      '--mode',
      'interop',
      '--port',
      String(port),
      '--strictPort'
    ],
    {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        MOKURO_E2E_KIT_OUT_DIR: join('.svelte-kit', 'e2e-gdrive-auth'),
        VITE_GDRIVE_AUTH_BACKEND: 'true',
        VITE_GDRIVE_CLIENT_ID: CLIENT_ID,
        GDRIVE_CLIENT_ID: CLIENT_ID,
        GDRIVE_CLIENT_SECRET: CLIENT_SECRET,
        GDRIVE_SESSION_KEY: SESSION_KEY,
        GDRIVE_TEST_GOOGLE_ORIGIN: googleOrigin
      }
    }
  );
  const deadline = Date.now() + 180_000;
  for (;;) {
    try {
      const response = await fetch(`${origin}/`);
      if (response.status < 500) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('the backend dev server never came up');
    await new Promise((r) => setTimeout(r, 500));
  }
});

test.afterAll(async () => {
  if (devServer?.pid) {
    try {
      process.kill(-devServer.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  await google?.stop();
});

/** The session the browser's cookie holds, opened with the server's key. */
function openSession(value: string) {
  const config = readAuthConfig({
    GDRIVE_CLIENT_ID: CLIENT_ID,
    GDRIVE_CLIENT_SECRET: CLIENT_SECRET,
    GDRIVE_SESSION_KEY: SESSION_KEY
  })!;
  return unseal(value, config, { clientId: CLIENT_ID, origin, cookieName: 'gdrive_rt' });
}

/** Whether this browser's device key is in its IndexedDB database (`device-key.ts`). */
const hasDeviceKey = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const open = indexedDB.open('mokuro-device-key');
        open.onerror = () => resolve(false);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('keys')) {
            db.close();
            return resolve(false);
          }
          const get = db.transaction('keys', 'readonly').objectStore('keys').get('gdrive-pop');
          get.onsuccess = () => {
            db.close();
            resolve(!!get.result);
          };
          get.onerror = () => {
            db.close();
            resolve(false);
          };
        };
      })
  );

const hasCookie = async (context: import('@playwright/test').BrowserContext) =>
  (await context.cookies(origin)).some((c) => c.name === 'gdrive_rt');

/** The stored access token; undefined while the page is between documents (the sign-in navigates). */
const storedToken = (page: Page) =>
  page.evaluate(() => localStorage.getItem('gdrive_token')).catch(() => undefined);

test('one sign-in, a bound HttpOnly cookie, silent renewal, a device sign-out, and a sign-out everywhere', async ({
  page,
  context
}) => {
  test.setTimeout(180_000);
  const consent: { url?: URL } = {};
  await routeGoogle(page, google, consent);
  const backendCalls: { path: string; body: Record<string, unknown> }[] = [];
  const logoutAnswers: unknown[] = [];
  page.on('response', async (response) => {
    if (new URL(response.url()).pathname === '/api/gdrive/logout') {
      logoutAnswers.push(await response.json().catch(() => null));
    }
  });
  // The browser's own revoke (the fallback when the server could not): it
  // must not be needed when the server confirms it revoked.
  const browserRevokes: string[] = [];
  await page.route('https://oauth2.googleapis.com/**', (route) => {
    browserRevokes.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === origin && url.pathname.startsWith('/api/gdrive/')) {
      backendCalls.push({ path: url.pathname, body: JSON.parse(request.postData() || '{}') });
    }
  });

  await test.step('sign in: a full-page round trip through the callback page', async () => {
    await page.goto(`${origin}/#/cloud`);
    const connect = page.getByRole('button', { name: /Google Drive.*15GB free/ });
    await expect(connect).toBeVisible({ timeout: 60_000 });
    await connect.click();

    await expect.poll(() => storedToken(page), { timeout: 60_000 }).toBe('ya29.e2e-1');

    const params = Object.fromEntries(consent.url!.searchParams);
    expect(params).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uri: `${origin}/oauth/google-callback.html`,
      response_type: 'code',
      scope: DRIVE_FILE,
      access_type: 'offline',
      prompt: 'consent',
      code_challenge_method: 'S256'
    });
    // The code was redeemed once, by the server, with the verifier the
    // browser kept: the fake Google checked S256(verifier) === challenge.
    expect(google.pkceVerified).toBe(1);
    const exchange = google.requests.find((r) => r.form.grant_type === 'authorization_code')!;
    expect(exchange.form.client_secret).toBe(CLIENT_SECRET);
    expect(exchange.form.redirect_uri).toBe(`${origin}/oauth/google-callback.html`);

    // Back where the sign-in started, with no code anywhere in the URL.
    expect(page.url()).toBe(`${origin}/#/cloud`);
    expect(backendCalls.map((c) => c.path)).toContain('/api/gdrive/session');
  });

  await test.step('the refresh token lives only in an HttpOnly, Strict cookie bound to the device key', async () => {
    const cookies = await context.cookies(origin);
    const cookie = cookies.find((c) => c.name === 'gdrive_rt');
    expect(cookie).toBeDefined();
    expect(cookie!.httpOnly).toBe(true);
    expect(cookie!.sameSite).toBe('Strict');
    expect(cookie!.path).toBe('/');
    // Script on the page cannot read it.
    expect(await page.evaluate(() => document.cookie)).not.toContain('gdrive_rt');
    // Nor is the refresh token anywhere the page can reach.
    const storage = await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage })
    );
    expect(storage).not.toContain(REFRESH_TOKEN);

    const opened = openSession(cookie!.value);
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.payload.rt).toBe(REFRESH_TOKEN);
      // Signed in with a proof: the session is bound to this browser's key.
      expect(opened.payload.cnf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    const session = backendCalls.find((c) => c.path === '/api/gdrive/session')!;
    expect(session.body).toMatchObject({ pop: { jwk: { kty: 'EC', crv: 'P-256' } } });
    expect(session.body.pop).not.toHaveProperty('jwk.d');
  });

  await test.step('the next start renews an expired token silently, with a proof', async () => {
    await page.evaluate(() => localStorage.setItem('gdrive_token_expires', String(Date.now() - 1)));
    await page.reload();
    await expect.poll(() => storedToken(page), { timeout: 60_000 }).toBe('ya29.e2e-2');
    const refresh = backendCalls.filter((c) => c.path === '/api/gdrive/refresh').at(-1)!;
    expect(refresh.body).toMatchObject({ pop: { jwk: { kty: 'EC' }, sig: expect.any(String) } });
    expect(google.requests.at(-1)!.form).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: REFRESH_TOKEN
    });
    // No popup was ever asked for.
    expect(
      await page.evaluate(() => (window as { __e2ePopupOpened?: boolean }).__e2ePopupOpened)
    ).toBeFalsy();
  });

  await test.step('the cookie alone is worth nothing: without the key, no token', async () => {
    // Same cookie jar, no device key to sign with — as a copied cookie would be.
    const response = await page.request.post(`${origin}/api/gdrive/refresh`, {
      headers: { origin, 'x-requested-with': 'XMLHttpRequest', 'content-type': 'application/json' },
      data: {}
    });
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: 'reauth' });
    expect(response.headers()['cache-control']).toBe('no-store');
  });

  await test.step('a cross-site request is refused before anything happens', async () => {
    const response = await page.request.post(`${origin}/api/gdrive/logout`, {
      headers: {
        origin: 'https://evil.example',
        'x-requested-with': 'XMLHttpRequest',
        'content-type': 'application/json'
      },
      data: {}
    });
    expect(response.status()).toBe(403);
    expect((await context.cookies(origin)).some((c) => c.name === 'gdrive_rt')).toBe(true);
  });

  let firstCnf: string | undefined;

  await test.step('sign out on this device: nothing revoked, the cookie and the key gone', async () => {
    const cookie = (await context.cookies(origin)).find((c) => c.name === 'gdrive_rt')!;
    const opened = openSession(cookie.value);
    firstCnf = opened.ok ? opened.payload.cnf : undefined;
    expect(firstCnf).toBeTruthy();
    await page.goto(`${origin}/#/cloud`);
    expect(await hasDeviceKey(page)).toBe(true);
    const googleCallsBefore = google.requests.length;

    await page.getByRole('button', { name: 'Log out' }).click();
    await expect.poll(() => storedToken(page), { timeout: 30_000 }).toBeNull();
    await expect.poll(() => hasCookie(context)).toBe(false);
    // The plain message: the session was bound, so no copy can work (no warning).
    await expect(
      page.getByText('Logged out of Google Drive on this device', { exact: true })
    ).toBeVisible();

    const logout = backendCalls.filter((c) => c.path === '/api/gdrive/logout').at(-1)!;
    expect(logout.body).toEqual({ everywhere: false });
    expect(logoutAnswers.at(-1)).toEqual({ ok: true, revoked: false, invalidated: true });
    // Google never heard of it: the grant other devices (and a bunko server) use stays live.
    expect(google.requests.slice(googleCallsBefore)).toEqual([]);
    expect(google.revoked.size).toBe(0);
    expect(browserRevokes).toEqual([]);
    expect(await hasDeviceKey(page)).toBe(false);
    expect(await page.evaluate(() => localStorage.getItem('gdrive_logout_pending'))).toBeNull();

    // A copy of the old cookie, replayed from elsewhere, can no longer refresh:
    // its session is bound to a key that no longer exists anywhere.
    const elsewhere = await request.newContext();
    try {
      const headers = {
        origin,
        'x-requested-with': 'XMLHttpRequest',
        'content-type': 'application/json',
        cookie: `gdrive_rt=${cookie.value}`
      };
      const bare = await elsewhere.post(`${origin}/api/gdrive/refresh`, { headers, data: {} });
      expect(bare.status()).toBe(401);
      expect(await bare.json()).toEqual({ error: 'reauth' });
      // Nor with a proof from any other key.
      const other = (await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign', 'verify']
      )) as CryptoKeyPair;
      const pop = await signProof(other, origin, '/api/gdrive/refresh', Date.now());
      const signed = await elsewhere.post(`${origin}/api/gdrive/refresh`, {
        headers,
        data: { pop }
      });
      expect(signed.status()).toBe(401);
      expect(await signed.json()).toEqual({ error: 'reauth' });
    } finally {
      await elsewhere.dispose();
    }
    // Refused before Google was asked for a token.
    expect(google.requests.slice(googleCallsBefore)).toEqual([]);
  });

  await test.step('signing in again binds the new session to a NEW device key', async () => {
    const connect = page.getByRole('button', { name: /Google Drive.*15GB free/ });
    await expect(connect).toBeVisible({ timeout: 60_000 });
    await connect.click();
    await expect.poll(() => storedToken(page), { timeout: 60_000 }).toMatch(/^ya29\.e2e-\d+$/);
    expect(google.pkceVerified).toBe(2);
    const cookie = (await context.cookies(origin)).find((c) => c.name === 'gdrive_rt')!;
    const opened = openSession(cookie.value);
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.payload.cnf).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(opened.payload.cnf).not.toBe(firstCnf);
    }
    expect(await hasDeviceKey(page)).toBe(true);
  });

  await test.step('sign out everywhere: confirmed, revoked at Google, cookie and key gone', async () => {
    await page.goto(`${origin}/#/cloud`);
    await page.getByRole('button', { name: 'Sign out everywhere…' }).click();
    const confirm = page.getByRole('button', { name: 'Sign out everywhere', exact: true });
    await expect(confirm).toBeVisible();
    await expect(page.getByText('on every device and browser where you use it')).toBeVisible();
    await confirm.click();

    await expect.poll(() => storedToken(page), { timeout: 30_000 }).toBeNull();
    await expect.poll(() => google.revoked.has(REFRESH_TOKEN)).toBe(true);
    await expect.poll(() => hasCookie(context)).toBe(false);
    await expect(page.getByText('Signed out of Google Drive everywhere')).toBeVisible();
    const logout = backendCalls.filter((c) => c.path === '/api/gdrive/logout').at(-1)!;
    expect(logout.body).toEqual({ everywhere: true });
    // The server says it revoked, so the browser had nothing left to revoke.
    expect(logoutAnswers.at(-1)).toEqual({ ok: true, revoked: true, invalidated: true });
    expect(browserRevokes).toEqual([]);
    expect(await hasDeviceKey(page)).toBe(false);
    expect(await page.evaluate(() => localStorage.getItem('gdrive_logout_pending'))).toBeNull();
  });
});
