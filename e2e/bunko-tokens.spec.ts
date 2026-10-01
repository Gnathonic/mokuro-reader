/**
 * Bearer-token sessions against a REAL mokuro-bunko >= 0.5.1, plus the Basic
 * path a plain WebDAV server and a pre-token bunko keep.
 *
 * The real-server test needs a THROWAWAY bunko (never a shared or production
 * one: it revokes tokens and changes the account's password):
 *
 *   E2E_BUNKO_URL      e.g. http://127.0.0.1:5197 (CORS must allow the reader's origin)
 *   E2E_BUNKO_USER     an account that may upload (role uploader or above)
 *   E2E_BUNKO_PW_FILE  file holding that account's password (never on a command line)
 *   E2E_BUNKO_DB       optional: the server's mokuro.db, to assert `auth_tokens` rows
 *
 * Without them that test is skipped; the stubbed Basic tests always run.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test, expect, type BrowserContext, type Page, type Route } from '@playwright/test';

const BUNKO = (process.env.E2E_BUNKO_URL ?? '').replace(/\/$/, '');
const USER = process.env.E2E_BUNKO_USER ?? '';
const PW_FILE = process.env.E2E_BUNKO_PW_FILE ?? '';
const DB = process.env.E2E_BUNKO_DB ?? '';

interface Seen {
  method: string;
  path: string;
  /** `Bearer` / `Basic` / `none` — the scheme only. */
  scheme: string;
  /** The bearer token, kept to compare tokens (never printed). */
  token: string | null;
  status: number;
}

/** Record every request to `origin` with the scheme of its Authorization header. */
function recordRequests(context: BrowserContext, origin: string): Seen[] {
  const seen: Seen[] = [];
  context.on('response', async (response) => {
    const request = response.request();
    if (!request.url().startsWith(origin)) return;
    const auth = (await request.allHeaders())['authorization'] ?? '';
    seen.push({
      method: request.method(),
      path: decodeURIComponent(new URL(request.url()).pathname),
      scheme: auth ? auth.split(' ')[0] : 'none',
      token: auth.startsWith('Bearer ') ? auth.slice(7) : null,
      status: response.status()
    });
  });
  return seen;
}

function tokenRows(): Array<{ username: string; kind: string; label: string; days: number }> {
  if (!DB) return [];
  const out = execFileSync(
    'python3',
    [
      '-c',
      `import json, sqlite3, sys
c = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True)
rows = c.execute("SELECT username, kind, label, (expires_at - created_at) / 86400.0 FROM auth_tokens ORDER BY created_at").fetchall()
print(json.dumps([dict(username=r[0], kind=r[1], label=r[2], days=r[3]) for r in rows]))`,
      DB
    ],
    { encoding: 'utf8' }
  );
  return JSON.parse(out);
}

async function storage(page: Page, key: string): Promise<string | null> {
  return page.evaluate((k) => window.localStorage.getItem(k), key);
}

async function listCloud(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { unifiedCloudManager } = await import('/src/lib/util/sync/unified-cloud-manager.ts');
    await unifiedCloudManager.fetchAllCloudVolumes();
  });
}

async function seedLocalVolume(page: Page, uuid: string, series: string): Promise<void> {
  await page.evaluate(
    async ({ uuid, series }) => {
      const { db } = await import('/src/lib/catalog/db.ts');
      await db.open();
      const canvas = document.createElement('canvas');
      canvas.width = 40;
      canvas.height = 60;
      canvas.getContext('2d')!.fillRect(0, 0, 40, 60);
      const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), 'image/png'));
      await db.volumes.put({
        volume_uuid: uuid,
        series_uuid: `${uuid}-series`,
        series_title: series,
        volume_title: 'Vol 1',
        mokuro_version: '',
        page_count: 1,
        character_count: 0,
        page_char_counts: [0]
      });
      await db.volume_ocr.put({
        volume_uuid: uuid,
        pages: [{ version: '0.2.1', img_width: 40, img_height: 60, blocks: [], img_path: 'p1.png' }]
      });
      await db.volume_files.put({
        volume_uuid: uuid,
        files: { 'p1.png': new File([blob], 'p1.png', { type: 'image/png' }) }
      });
    },
    { uuid, series }
  );
}

async function downloadFromCloud(page: Page, path: string): Promise<void> {
  await page.evaluate(async (path) => {
    const { unifiedCloudManager } = await import('/src/lib/util/sync/unified-cloud-manager.ts');
    const { queueVolumesFromCloudFiles } = await import('/src/lib/util/download-queue.ts');
    const files = unifiedCloudManager.getAllCloudVolumes?.() ?? [];
    const file = (files as Array<{ path: string }>).find((f) => f.path === path);
    if (!file) throw new Error(`not listed: ${path}`);
    queueVolumesFromCloudFiles([file as never]);
  }, path);
}

async function installedTitles(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const { db } = await import('/src/lib/catalog/db.ts');
    const files = await db.volume_files.toArray();
    const rows = await db.volumes.bulkGet(files.map((f) => f.volume_uuid));
    return rows.filter(Boolean).map((r) => r!.series_title);
  });
}

test.describe('bunko bearer tokens (real server)', () => {
  test.skip(!BUNKO || !USER || !PW_FILE, 'needs E2E_BUNKO_URL/USER/PW_FILE (see header)');
  test.setTimeout(180_000);

  test('connect -> Bearer everywhere -> revoked token silently replaced -> password change = auth failed', async ({
    page,
    context,
    request
  }) => {
    const password = readFileSync(PW_FILE, 'utf8').trim();
    const seen = recordRequests(context, BUNKO);
    // Rows other runs left behind (a failed run never revokes): count from here.
    const baseRows = tokenRows().length;
    const since = (n: number) => seen.slice(n);

    await page.goto('/');
    await page.waitForTimeout(800);
    await seedLocalVolume(page, 'tok-local-1', 'LocalSeries');

    // ---- connect through the real login form
    await page.getByRole('button', { name: /Not connected/ }).click();
    await page.getByText('WebDAV', { exact: true }).click();
    await page.getByPlaceholder(/Server URL/).fill(BUNKO);
    await page.getByPlaceholder(/Username/).fill(USER);
    await page.getByPlaceholder('Password or App Token').fill(password);
    await page.getByRole('button', { name: 'Connect to WebDAV' }).click();
    await expect.poll(() => storage(page, 'webdav_token'), { timeout: 20_000 }).not.toBeNull();
    const tok1 = (await storage(page, 'webdav_token'))!;
    expect(await storage(page, 'webdav_password')).toBe(password); // kept (owner's choice)
    expect(await storage(page, 'webdav_token_endpoint')).toBe(`${BUNKO}/login/api/token`);

    const issue = seen.find((s) => s.method === 'POST' && s.path === '/login/api/token');
    expect(issue).toMatchObject({ status: 200, scheme: 'none' }); // the password rides in the JSON body
    if (DB) {
      const rows = tokenRows();
      expect(rows).toHaveLength(baseRows + 1);
      const row = rows[rows.length - 1];
      expect(row).toMatchObject({ username: USER, kind: 'reader' });
      expect(row.label).toMatch(/^mokuro-reader \(Chrome\)$/);
      expect(Math.round(row.days)).toBe(90);
      console.log('[evidence] auth_tokens row issued at connect:', JSON.stringify(row));
    }
    const issuedAt = seen.indexOf(issue!);
    const afterIssue = () => seen.slice(issuedAt + 1).filter((s) => s.path !== '/login/api/token');

    // ---- listing (main thread, webdav client)
    await listCloud(page);
    // ---- download (worker)
    await downloadFromCloud(page, 'TokenSeries/TokenSeries 01.cbz');
    await expect.poll(() => installedTitles(page), { timeout: 30_000 }).toContain('TokenSeries');
    // ---- uploads: progress file (main thread) and a volume backup (worker)
    await page.evaluate(async () => {
      const { unifiedSyncService } = await import('/src/lib/util/sync/unified-sync-service.ts');
      const { providerManager } = await import('/src/lib/util/sync/provider-manager.ts');
      await unifiedSyncService.syncProvider(providerManager.getActiveProvider()!);
      const { db } = await import('/src/lib/catalog/db.ts');
      const { queueVolumeForBackup } = await import('/src/lib/util/backup-queue.ts');
      queueVolumeForBackup((await db.volumes.get('tok-local-1'))!);
    });
    await expect
      .poll(
        () =>
          seen.find((s) => s.method === 'PUT' && s.path.endsWith('/LocalSeries/Vol 1.cbz'))
            ?.status ?? 0,
        { timeout: 30_000 }
      )
      .toBeGreaterThanOrEqual(200);

    const used = afterIssue();
    console.log(
      '[evidence] requests through the uploads:',
      JSON.stringify(seen.map((s) => `${s.method} ${s.path} ${s.scheme} ${s.status}`))
    );
    const by = (m: string, p: RegExp) => used.filter((s) => s.method === m && p.test(s.path));
    expect(by('PROPFIND', /^\/mokuro-reader/).length).toBeGreaterThan(0);
    expect(by('GET', /TokenSeries 01\.cbz$/).length).toBeGreaterThan(0);
    expect(by('PUT', /(volume-data|profiles)\.json$/).length).toBeGreaterThan(0);
    expect(by('PUT', /LocalSeries\/Vol 1\.cbz$/).length).toBeGreaterThan(0);
    // EVERY request after the token was issued carried it — none fell back to Basic.
    const schemes = [...new Set(used.filter((s) => s.method !== 'OPTIONS').map((s) => s.scheme))];
    expect(schemes).toEqual(['Bearer']);
    expect(new Set(used.filter((s) => s.token).map((s) => s.token))).toEqual(new Set([tok1]));
    console.log(
      '[evidence] after token issue:',
      JSON.stringify(
        Object.entries(
          used.reduce<Record<string, number>>((acc, s) => {
            const k = `${s.method} ${s.scheme} ${s.status}`;
            acc[k] = (acc[k] ?? 0) + 1;
            return acc;
          }, {})
        )
      )
    );

    // ---- revoke the token server-side; the next request is refused, re-issued, retried
    const revoked = await request.delete(`${BUNKO}/login/api/token`, {
      headers: { Authorization: `Bearer ${tok1}` }
    });
    expect(await revoked.json()).toEqual({ revoked: true });
    if (DB) expect(tokenRows()).toHaveLength(baseRows);
    let mark = seen.length;
    await listCloud(page);
    await expect.poll(async () => (await storage(page, 'webdav_token')) !== tok1).toBe(true);
    const tok2 = (await storage(page, 'webdav_token'))!;
    const replay = since(mark).filter((s) => s.method !== 'OPTIONS');
    const refused = replay.findIndex((s) => s.status === 401 && s.token === tok1);
    const reissue = replay.findIndex((s) => s.method === 'POST' && s.path === '/login/api/token');
    const retried = replay.findIndex(
      (s, i) => i > reissue && s.method === 'PROPFIND' && s.token === tok2 && s.status === 207
    );
    expect(refused).toBeGreaterThanOrEqual(0);
    expect(reissue).toBeGreaterThan(refused);
    expect(replay[reissue].status).toBe(200);
    expect(retried).toBeGreaterThan(reissue);
    expect(replay.filter((s) => s.path === '/login/api/token')).toHaveLength(1);
    console.log(
      '[evidence] revoked-token replay:',
      JSON.stringify(
        replay.map(
          (s) =>
            `${s.method} ${s.path} ${s.scheme}${s.token === tok1 ? '(old)' : s.token === tok2 ? '(new)' : ''} ${s.status}`
        )
      )
    );
    if (DB) expect(tokenRows()).toHaveLength(baseRows + 1);

    // ---- the same for a WORKER: revoke, then a worker download hits the 401.
    // A volume never fetched before (TokenSeries 02): an archive already
    // fetched can come back from the browser's HTTP cache without a request.
    const revoked2 = await request.delete(`${BUNKO}/login/api/token`, {
      headers: { Authorization: `Bearer ${tok2}` }
    });
    expect(await revoked2.json()).toEqual({ revoked: true });
    await page.evaluate(async () => {
      const { db } = await import('/src/lib/catalog/db.ts');
      const rows = await db.volumes.where('series_title').equals('TokenSeries').toArray();
      for (const r of rows) {
        await db.volume_files.delete(r.volume_uuid);
        await db.volume_ocr.delete(r.volume_uuid);
        await db.volumes.delete(r.volume_uuid);
      }
    });
    mark = seen.length;
    await downloadFromCloud(page, 'TokenSeries/TokenSeries 02.cbz');
    await expect.poll(() => installedTitles(page), { timeout: 30_000 }).toContain('TokenSeries');
    const workerReplay = since(mark).filter((s) => s.method !== 'OPTIONS');
    const tok3 = (await storage(page, 'webdav_token'))!;
    console.log(
      '[evidence] worker replay:',
      JSON.stringify(
        workerReplay.map(
          (s) =>
            `${s.method} ${s.path} ${s.scheme}${s.token === tok2 ? '(old)' : s.token === tok3 ? '(new)' : ''} ${s.status}`
        )
      )
    );
    expect(tok3 !== tok2).toBe(true);
    expect(
      workerReplay.some((s) => s.method === 'GET' && s.token === tok2 && s.status === 401)
    ).toBe(true);
    expect(
      workerReplay.filter((s) => s.method === 'POST' && s.path === '/login/api/token')
    ).toHaveLength(1);
    expect(
      workerReplay.some(
        (s) =>
          s.method === 'GET' &&
          /TokenSeries 02\.cbz$/.test(s.path) &&
          s.token === tok3 &&
          s.status === 200
      )
    ).toBe(true);

    // ---- the password changes server-side (all tokens revoked): re-issue refused -> auth failed
    const newPassword = `N-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    const changed = await request.post(`${BUNKO}/api/account/password`, {
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${USER}:${password}`).toString('base64')
      },
      data: { current_password: password, new_password: newPassword }
    });
    expect(changed.status()).toBe(200);
    try {
      if (DB) expect(tokenRows()).toHaveLength(0); // a password change revokes them all
      mark = seen.length;
      await listCloud(page).catch(() => {});
      await expect.poll(() => storage(page, 'webdav_password'), { timeout: 15_000 }).toBeNull();
      expect(await storage(page, 'webdav_token')).toBeNull();
      expect(await storage(page, 'webdav_server_url')).toBe(BUNKO); // the form pre-fills
      expect(await storage(page, 'webdav_username')).toBe(USER);
      await page.waitForTimeout(3000); // nothing keeps hammering the login limiter
      const failReplay = since(mark).filter((s) => s.method !== 'OPTIONS');
      const posts = failReplay.filter((s) => s.method === 'POST' && s.path === '/login/api/token');
      expect(posts.map((s) => s.status)).toEqual([401]);
      console.log(
        '[evidence] password-change replay:',
        JSON.stringify(failReplay.map((s) => `${s.method} ${s.path} ${s.scheme} ${s.status}`))
      );
      // The existing auth-failed UI: the cloud icon asks for a sign-in.
      await expect(page.locator('button[title*="Action Required"]')).toBeVisible({
        timeout: 10_000
      });
      await page.locator('button[title*="Action Required"]').click();
      await expect(page.getByText('Action Required', { exact: true })).toBeVisible({
        timeout: 10_000
      });
      await page.screenshot({ path: process.env.E2E_SHOT ?? 'test-results/bunko-auth-failed.png' });
    } finally {
      // Put the password back so the throwaway account stays usable for a re-run.
      await request.post(`${BUNKO}/api/account/password`, {
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${USER}:${newPassword}`).toString('base64')
        },
        data: { current_password: newPassword, new_password: password }
      });
    }
  });
});

test.describe('bunko bearer tokens: sign-out (real server)', () => {
  test.skip(!BUNKO || !USER || !PW_FILE, 'needs E2E_BUNKO_URL/USER/PW_FILE (see header)');

  test('logging out signs the token out on the server', async ({ page, context }) => {
    const password = readFileSync(PW_FILE, 'utf8').trim();
    const seen = recordRequests(context, BUNKO);
    const baseRows = tokenRows().length;
    await page.goto('/');
    await page.waitForTimeout(800);
    await page.evaluate(
      async ({ serverUrl, username, password }) => {
        const { providerManager } = await import('/src/lib/util/sync/provider-manager.ts');
        const provider = await providerManager.getOrLoadProvider('webdav');
        await provider.login({ serverUrl, username, password });
        await providerManager.setCurrentProvider(provider);
      },
      { serverUrl: BUNKO, username: USER, password }
    );
    expect(await storage(page, 'webdav_token')).not.toBeNull();
    if (DB) expect(tokenRows()).toHaveLength(baseRows + 1);

    await page.evaluate(async () => {
      const { providerManager } = await import('/src/lib/util/sync/provider-manager.ts');
      await providerManager.logout();
    });
    await expect
      .poll(() => seen.find((s) => s.method === 'DELETE' && s.path === '/login/api/token'))
      .toMatchObject({ scheme: 'Bearer', status: 200 });
    expect(await storage(page, 'webdav_token')).toBeNull();
    if (DB) expect(tokenRows()).toHaveLength(baseRows);
  });
});

// ------------------------------------------------------------------ Basic keeps working

const STUB = 'http://stub.test';

/** A minimal WebDAV server; `bunkoIdentity` makes it a pre-token bunko (identity yes, token no). */
function davStub(options: { bunkoIdentity: boolean }) {
  const seen: Array<{ method: string; path: string; auth: string }> = [];
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, PUT, POST, DELETE, OPTIONS, PROPFIND, MKCOL',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Depth, Accept, Content-Digest',
    'Access-Control-Expose-Headers': '*'
  };
  const multistatus = (href: string) =>
    `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
  const handle = async (route: Route) => {
    const request = route.request();
    const method = request.method();
    const path = decodeURIComponent(new URL(request.url()).pathname);
    const reply = (status: number, body = '', headers: Record<string, string> = {}) =>
      route.fulfill({ status, body, headers: { ...cors, ...headers } });
    if (method === 'OPTIONS') return reply(204);
    seen.push({ method, path, auth: (request.headers()['authorization'] ?? 'none').split(' ')[0] });
    if (path === '/login/api/me') {
      if (!options.bunkoIdentity) return reply(404, 'not here');
      return reply(
        200,
        JSON.stringify({
          authenticated: true,
          username: 'alice',
          role: 'uploader',
          permissions: { canWriteProgress: true, canAddFiles: true, canModifyDelete: false }
        }),
        { 'Content-Type': 'application/json' }
      );
    }
    // A pre-0.5.1 bunko: the POST falls through to its auth layer (text/plain).
    if (path === '/login/api/token') return reply(405, 'Method Not Allowed');
    if (method === 'PROPFIND') {
      return reply(207, multistatus(path.endsWith('/') ? path : `${path}/`), {
        'Content-Type': 'application/xml'
      });
    }
    if (method === 'PUT' || method === 'MKCOL') return reply(201);
    return reply(404);
  };
  return { seen, handle };
}

for (const kind of ['plain WebDAV', 'pre-token bunko'] as const) {
  test(`${kind}: Basic exactly as before`, async ({ page }) => {
    const stub = davStub({ bunkoIdentity: kind === 'pre-token bunko' });
    await page.route(`${STUB}/**`, stub.handle);
    await page.goto('/');
    await page.waitForTimeout(800);
    await page.evaluate(async (serverUrl) => {
      const { providerManager } = await import('/src/lib/util/sync/provider-manager.ts');
      const provider = await providerManager.getOrLoadProvider('webdav');
      await provider.login({ serverUrl, username: 'alice', password: 'pw' });
      await providerManager.setCurrentProvider(provider);
      await provider.uploadFile('volume-data.json', new Blob(['{}']));
    }, STUB);
    expect(await storage(page, 'webdav_token')).toBeNull();
    const tokenPosts = stub.seen.filter((s) => s.path === '/login/api/token');
    // Only a server that answered bunko's identity contract is ever asked, once.
    expect(tokenPosts).toHaveLength(kind === 'pre-token bunko' ? 1 : 0);
    const rest = stub.seen.filter((s) => s.path !== '/login/api/token');
    expect(rest.some((s) => s.method === 'PUT')).toBe(true);
    expect([...new Set(rest.map((s) => s.auth))]).toEqual(['Basic']);
  });
}
