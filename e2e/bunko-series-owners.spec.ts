/**
 * mokuro-bunko 0.8 series owners, end to end: a REAL server, the reader in a
 * real browser for the parts a user does, and raw HTTP for the rules no reader
 * button reaches.
 *
 *   1. Uploader A backs a volume of `Owned Series` up through the reader; the
 *      MKCOL makes A the folder's owner (`/me` -> `metadata.ownedSeries`).
 *   2. Uploader B, in its own browser, sees `Owned Series` closed
 *      (`addFiles.closedSeries`); its backup of another volume of that series is
 *      skipped with ONE notice and nothing reaches the folder, and B stays signed
 *      in and writable: a backup of a series of its own still goes up.
 *   3. Volume control in a folder nobody owns (raw HTTP): an archive hiding a
 *      layer of A's volume is refused; B's `X.curated.cbz` that came first passes
 *      to A once A's `X.cbz` lands; B's personal correction stays B's.
 *   4. An editor may add to A's series, and A (the owner) may delete it.
 *   5. No ownership refusal reads as a sign-in failure.
 *
 * Needs a FRESH, THROWAWAY bunko >= 0.8 (the test creates `Owned Series` and
 * `B Own Series` and expects neither to exist), run with OCR off, whose CORS
 * allows the reader's origin. The driver script that sets one up, runs this and
 * stops it is `~/.cache/bunko-xplay-targets/p9e2e/run-owners-e2e.sh`.
 *
 *   E2E_BUNKO_URL                 e.g. http://127.0.0.1:5195
 *   E2E_BUNKO_UPLOADER_A          an account of role `uploader`
 *   E2E_BUNKO_UPLOADER_A_PW_FILE  file holding its password (never on a command line)
 *   E2E_BUNKO_UPLOADER_B          a second `uploader` account
 *   E2E_BUNKO_UPLOADER_B_PW_FILE  file holding its password
 *   E2E_BUNKO_EDITOR              an account of role `editor`
 *   E2E_BUNKO_EDITOR_PW_FILE      file holding its password
 *   E2E_BUNKO_UNOWNED_FOLDER      a library folder that existed before the server's
 *                                 FIRST start (so it has no owner), e.g. `Shared Series`
 *
 * Without them every test here is skipped.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  test,
  expect,
  type APIRequestContext,
  type BrowserContext,
  type Page,
  type TestInfo
} from '@playwright/test';
import { gotoApp } from './helpers/app';

const BUNKO = (process.env.E2E_BUNKO_URL ?? '').replace(/\/$/, '');
const A_USER = process.env.E2E_BUNKO_UPLOADER_A ?? '';
const A_PW_FILE = process.env.E2E_BUNKO_UPLOADER_A_PW_FILE ?? '';
const B_USER = process.env.E2E_BUNKO_UPLOADER_B ?? '';
const B_PW_FILE = process.env.E2E_BUNKO_UPLOADER_B_PW_FILE ?? '';
const ED_USER = process.env.E2E_BUNKO_EDITOR ?? '';
const ED_PW_FILE = process.env.E2E_BUNKO_EDITOR_PW_FILE ?? '';
const UNOWNED = process.env.E2E_BUNKO_UNOWNED_FOLDER ?? '';
const ENABLED = !!(
  BUNKO &&
  A_USER &&
  A_PW_FILE &&
  B_USER &&
  B_PW_FILE &&
  ED_USER &&
  ED_PW_FILE &&
  UNOWNED
);

const OWNED = 'Owned Series';
const B_SERIES = 'B Own Series';
/** The ONE notice a series backup gives for a volume of a closed series (`closedSeriesNotice`). */
const SKIP_NOTICE = 'Skipped 1 volume: its series belongs to another account on this server';
const PAGES = ['001.png', '002.png'];

interface Account {
  user: string;
  password: string;
}

function account(user: string, pwFile: string): Account {
  return { user, password: readFileSync(pwFile, 'utf8').trim() };
}

// ------------------------------------------------------------------ content

function mokuroJson(series: string, volume: string, volumeUuid: string, text: string): string {
  return JSON.stringify({
    version: '0.2.1',
    title: series,
    title_uuid: `${series}-uuid`,
    volume,
    volume_uuid: volumeUuid,
    pages: PAGES.map((img_path) => ({
      version: '0.2.1',
      img_width: 200,
      img_height: 300,
      img_path,
      blocks: [{ box: [120, 30, 160, 130], vertical: true, font_size: 20, lines: [text] }]
    })),
    chars: text.length * PAGES.length
  });
}

/** A `.cbz` of solid-colour PNG pages, written by the stdlib alone (no PIL). */
function writeCbz(path: string, shade: number): void {
  execFileSync(
    'python3',
    [
      '-c',
      `import struct, sys, zipfile, zlib
def png(w, h, v):
    raw = b''.join(b'\\x00' + bytes([v, v, v]) * w for _ in range(h))
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return (b'\\x89PNG\\r\\n\\x1a\\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))
out, shade, names = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
with zipfile.ZipFile(out, 'w') as z:
    for i, name in enumerate(names):
        z.writestr(name, png(200, 300, (shade + 30 * i) % 256))`,
      path,
      String(shade),
      ...PAGES
    ],
    { encoding: 'utf8' }
  );
}

/** A `.mokuro` + `.cbz` pair with the same basename, as the import modal takes it. */
function volumeFiles(
  testInfo: TestInfo,
  series: string,
  volume: string,
  shade: number
): { mokuro: string; cbz: string } {
  const dir = testInfo.outputPath('fixtures');
  const mokuro = join(dir, `${volume}.mokuro`);
  const cbz = join(dir, `${volume}.cbz`);
  execFileSync('mkdir', ['-p', dir]);
  execFileSync('python3', [
    '-c',
    'import sys; open(sys.argv[1], "w").write(sys.argv[2])',
    mokuro,
    mokuroJson(series, volume, `owners-${volume.replace(/\W+/g, '-')}-${Date.now()}`, '所有者')
  ]);
  writeCbz(cbz, shade);
  return { mokuro, cbz };
}

// ------------------------------------------------------------------ raw HTTP

interface Exchange {
  who: string;
  method: string;
  path: string;
  status: number;
  statusText: string;
  body: string;
}

/** Every raw request this file made, for the "never a sign-in failure" check (test 5). */
const exchanges: Exchange[] = [];

function davUrl(path: string): string {
  return `${BUNKO}/mokuro-reader/${path.split('/').map(encodeURIComponent).join('/')}`;
}

function basic(who: Account): string {
  return 'Basic ' + Buffer.from(`${who.user}:${who.password}`).toString('base64');
}

async function dav(
  api: APIRequestContext,
  who: Account,
  method: string,
  path: string,
  options: { data?: Buffer | string; headers?: Record<string, string> } = {}
): Promise<Exchange> {
  const response = await api.fetch(davUrl(path), {
    method,
    data: options.data,
    headers: { Authorization: basic(who), ...options.headers },
    failOnStatusCode: false
  });
  const exchange: Exchange = {
    who: who.user,
    method,
    path,
    status: response.status(),
    statusText: response.statusText(),
    body: method === 'GET' && response.ok() ? '' : await response.text()
  };
  if (method === 'GET' && response.ok()) exchange.body = (await response.body()).toString('utf8');
  exchanges.push(exchange);
  console.log(
    `[evidence] ${who.user} ${method} ${path} -> ${exchange.status} ${exchange.statusText}` +
      (exchange.status >= 400 ? ` ${exchange.body}` : '')
  );
  return exchange;
}

function put(api: APIRequestContext, who: Account, path: string, data: Buffer | string) {
  return dav(api, who, 'PUT', path, { data });
}

/** The names a PROPFIND (Depth 1) of `folder` lists, the folder itself excluded. */
/** The names a client put there: bunko compiles `series.json` on its own schedule,
 * so it can appear between two listings without anyone writing. */
function withoutCompiled(names: string[]): string[] {
  return names.filter((name) => name !== 'series.json');
}

async function listFolder(api: APIRequestContext, who: Account, folder: string) {
  const response = await api.fetch(davUrl(`${folder}/`), {
    method: 'PROPFIND',
    headers: { Authorization: basic(who), Depth: '1' },
    failOnStatusCode: false
  });
  expect(response.status()).toBe(207);
  const xml = await response.text();
  const names = [...xml.matchAll(/<(?:\w+:)?href>([^<]*)<\/(?:\w+:)?href>/gi)]
    .map((m) => decodeURIComponent(m[1]).replace(/\/$/, ''))
    .map((href) => href.slice(href.lastIndexOf('/') + 1))
    .filter((name) => name && name !== folder);
  return names.sort();
}

interface Me {
  username: string;
  role: string;
  permissions: {
    canAddFiles?: boolean;
    canModifyDelete?: boolean;
    metadata?: { scope: string; ownedSeries?: string[] };
    addFiles?: { scope: string; closedSeries?: string[] };
  };
}

async function me(api: APIRequestContext, who: Account): Promise<Me> {
  const response = await api.get(`${BUNKO}/login/api/me`, {
    headers: { Authorization: basic(who) }
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as Me;
  console.log(`[evidence] /me ${who.user}: ${JSON.stringify(body.permissions)}`);
  return body;
}

function cbzBytes(testInfo: TestInfo, name: string, shade: number): Buffer {
  const path = testInfo.outputPath(`raw-${name.replace(/\W+/g, '-')}.cbz`);
  execFileSync('mkdir', ['-p', testInfo.outputPath()]);
  writeCbz(path, shade);
  return readFileSync(path);
}

// ------------------------------------------------------------------ reader side

interface Seen {
  method: string;
  path: string;
  status: number;
}

/** Every request the page (or one of its workers) made to the server. */
function recordRequests(context: BrowserContext): Seen[] {
  const seen: Seen[] = [];
  context.on('response', (response) => {
    const request = response.request();
    if (!request.url().startsWith(BUNKO)) return;
    seen.push({
      method: request.method(),
      path: decodeURIComponent(new URL(request.url()).pathname),
      status: response.status()
    });
  });
  return seen;
}

/** Connect through the real WebDAV login form, as a user does. */
async function connectThroughUi(page: Page, who: Account): Promise<void> {
  await page.getByRole('button', { name: /Not connected/ }).click();
  await page.getByText('WebDAV', { exact: true }).click();
  await page.getByPlaceholder(/Server URL/).fill(BUNKO);
  await page.getByPlaceholder(/Username/).fill(who.user);
  await page.getByPlaceholder('Password or App Token').fill(who.password);
  await page.getByRole('button', { name: 'Connect to WebDAV' }).click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('webdav_token')), { timeout: 20_000 })
    .not.toBeNull();
}

async function providerStatus(page: Page) {
  return page.evaluate(async () => {
    const { providerManager } = await import('/src/lib/util/sync/provider-manager.ts');
    const status = providerManager.getActiveProvider()?.getStatus();
    return status
      ? {
          isAuthenticated: status.isAuthenticated,
          isReadOnly: status.isReadOnly,
          needsAttention: status.needsAttention,
          canAddFiles: status.canAddFiles,
          addFiles: status.addFilesPermissions ?? null,
          metadata: status.metadataPermissions ?? null
        }
      : null;
  });
}

/** Import a `.mokuro` + `.cbz` pair through the navbar's upload modal. */
async function importThroughUi(page: Page, files: { mokuro: string; cbz: string }, series: string) {
  await page.evaluate(() => (window.location.hash = '#/catalog'));
  await page.locator('nav div.md\\:order-2 > button').nth(3).click();
  const chooser = page.waitForEvent('filechooser');
  await page.locator('dialog button', { hasText: 'choose files' }).click();
  await (await chooser).setFiles([files.mokuro, files.cbz]);
  await page.locator('dialog button', { hasText: /^\s*Import\s*$/ }).click();
  await expect
    .poll(
      () =>
        page.evaluate(async (series) => {
          const { db } = await import('/src/lib/catalog/db.ts');
          const rows = await db.volumes.where('series_title').equals(series).toArray();
          const installed = await db.volume_files.bulkGet(rows.map((r) => r.volume_uuid));
          return installed.filter(Boolean).length;
        }, series),
      { timeout: 30_000, message: `the import of ${series} never saved` }
    )
    .toBeGreaterThan(0);
}

/** Open the series page from the catalog and press its backup button. */
async function backUpSeriesThroughUi(page: Page, series: string): Promise<void> {
  await page.evaluate(() => (window.location.hash = '#/catalog'));
  await page.getByText(series, { exact: true }).first().click();
  await expect.poll(() => page.evaluate(() => window.location.hash)).toMatch(/^#\/series\//);
  const button = page.getByRole('button', { name: /^(Backup to |Backup remaining)/ });
  await expect(button).toBeVisible({ timeout: 20_000 });
  await button.click();
}

/** Every snackbar message from here on, in order (not the one already showing). */
async function recordNotices(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { snackbarStore } = await import('/src/lib/util/snackbar.ts');
    const w = window as unknown as { __notices: string[] };
    w.__notices = [];
    let armed = false; // a store hands its CURRENT value to a new subscriber first
    snackbarStore.subscribe((s) => {
      if (armed && s?.message) w.__notices.push(s.message);
    });
    armed = true;
  });
}

async function notices(page: Page): Promise<string[]> {
  return page.evaluate(() => [...(window as unknown as { __notices: string[] }).__notices]);
}

async function backupIdle(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const { isBackupRunActive } = await import('/src/lib/util/backup-queue.ts');
    return !isBackupRunActive();
  });
}

const writes = (seen: Seen[], folder: string) =>
  seen.filter(
    (s) =>
      ['PUT', 'MKCOL', 'DELETE', 'MOVE', 'COPY'].includes(s.method) &&
      s.path.startsWith(`/mokuro-reader/${folder}/`)
  );

// ------------------------------------------------------------------ the tests

test.describe('bunko 0.8 series owners (real server)', () => {
  test.skip(!ENABLED, 'needs E2E_BUNKO_URL and the account/folder variables (see header)');
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  test('1. uploader A backs a series up through the reader and owns it', async ({
    page,
    context,
    request
  }, testInfo) => {
    const a = account(A_USER, A_PW_FILE);
    const before = await me(request, a);
    expect(before.role).toBe('uploader');
    expect(before.permissions.metadata?.ownedSeries ?? []).not.toContain(OWNED);

    const seen = recordRequests(context);
    await gotoApp(page);
    await connectThroughUi(page, a);
    await importThroughUi(page, volumeFiles(testInfo, OWNED, `${OWNED} 01`, 90), OWNED);
    await backUpSeriesThroughUi(page, OWNED);

    const archive = `/mokuro-reader/${OWNED}/${OWNED} 01.cbz`;
    await expect
      .poll(() => seen.find((s) => s.method === 'PUT' && s.path === archive)?.status ?? 0, {
        timeout: 60_000
      })
      .toBe(201);
    await expect.poll(() => backupIdle(page), { timeout: 60_000 }).toBe(true);
    console.log(
      '[evidence] A backup requests:',
      JSON.stringify(
        seen
          .filter((s) => s.method !== 'OPTIONS' && s.method !== 'PROPFIND')
          .map((s) => `${s.method} ${s.path} ${s.status}`)
      )
    );
    // The reader made the folder (a PUT never makes one on bunko): A owns it now.
    expect(
      seen.find(
        (s) => s.method === 'MKCOL' && s.path.replace(/\/$/, '') === `/mokuro-reader/${OWNED}`
      )?.status
    ).toBe(201);
    expect(seen.filter((s) => s.status === 401)).toEqual([]);

    const after = await me(request, a);
    expect(after.permissions.metadata?.ownedSeries).toContain(OWNED);
    expect(after.permissions.addFiles?.closedSeries ?? []).not.toContain(OWNED);
    expect(await listFolder(request, a, OWNED)).toContain(`${OWNED} 01.cbz`);
  });

  test('2. uploader B: a closed series is skipped with one notice; B stays signed in and writable', async ({
    page,
    context,
    request
  }, testInfo) => {
    const a = account(A_USER, A_PW_FILE);
    const b = account(B_USER, B_PW_FILE);
    const bMe = await me(request, b);
    expect(bMe.role).toBe('uploader');
    expect(bMe.permissions.addFiles?.scope).toBe('open');
    expect(bMe.permissions.addFiles?.closedSeries).toContain(OWNED);
    expect(bMe.permissions.metadata?.ownedSeries ?? []).not.toContain(OWNED);
    const ownedBefore = withoutCompiled(await listFolder(request, a, OWNED));

    const seen = recordRequests(context);
    await gotoApp(page);
    await connectThroughUi(page, b);
    // The reader parsed the same answer.
    const status = await providerStatus(page);
    expect(status).toMatchObject({ isAuthenticated: true, isReadOnly: false, canAddFiles: true });
    expect(status!.addFiles).toMatchObject({ scope: 'open' });
    expect(status!.addFiles!.closedSeries).toContain(OWNED);

    // ---- a different volume of A's series: skipped before any request, one notice
    await importThroughUi(page, volumeFiles(testInfo, OWNED, `${OWNED} 02`, 150), OWNED);
    await recordNotices(page);
    const mark = seen.length;
    await backUpSeriesThroughUi(page, OWNED);
    const toast = page
      .locator('[role="alert"], .fixed.z-\\[60\\]')
      .filter({ hasText: SKIP_NOTICE });
    await expect(toast.first()).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(3000); // anything the click set off has had time to go out
    expect(await notices(page)).toEqual([SKIP_NOTICE]);
    await page.screenshot({ path: testInfo.outputPath('closed-series-notice.png') });
    console.log(
      '[evidence] B requests after the closed-series backup:',
      JSON.stringify(
        seen
          .slice(mark)
          .filter((s) => s.method !== 'OPTIONS')
          .map((s) => `${s.method} ${s.path} ${s.status}`)
      )
    );
    expect(writes(seen, OWNED)).toEqual([]);
    expect(withoutCompiled(await listFolder(request, a, OWNED))).toEqual(ownedBefore);
    expect((await listFolder(request, a, OWNED)).filter((n) => n.includes(`${OWNED} 02`))).toEqual(
      []
    );

    // ---- still signed in, not read-only, and nothing reads as a sign-in failure
    expect(await providerStatus(page)).toMatchObject({
      isAuthenticated: true,
      isReadOnly: false,
      needsAttention: false
    });
    expect(await page.evaluate(() => localStorage.getItem('webdav_token'))).not.toBeNull();
    await expect(page.locator('button[title*="Action Required"]')).toHaveCount(0);

    // ---- a series of B's own still backs up
    const bArchive = `/mokuro-reader/${B_SERIES}/${B_SERIES} 01.cbz`;
    await importThroughUi(page, volumeFiles(testInfo, B_SERIES, `${B_SERIES} 01`, 200), B_SERIES);
    await backUpSeriesThroughUi(page, B_SERIES);
    await expect
      .poll(() => seen.find((s) => s.method === 'PUT' && s.path === bArchive)?.status ?? 0, {
        timeout: 60_000
      })
      .toBe(201);
    await expect.poll(() => backupIdle(page), { timeout: 60_000 }).toBe(true);
    expect(await listFolder(request, a, B_SERIES)).toContain(`${B_SERIES} 01.cbz`);
    expect((await me(request, b)).permissions.metadata?.ownedSeries).toContain(B_SERIES);
    expect(seen.filter((s) => s.status === 401)).toEqual([]);
    expect(await providerStatus(page)).toMatchObject({ isAuthenticated: true, isReadOnly: false });
  });

  test('3. raw HTTP: who controls a volume in a folder nobody owns', async ({
    request
  }, testInfo) => {
    const a = account(A_USER, A_PW_FILE);
    const b = account(B_USER, B_PW_FILE);
    // The folder predates the server: nobody owns it, so it is closed to nobody.
    expect((await me(request, a)).permissions.metadata?.ownedSeries ?? []).not.toContain(UNOWNED);
    const bMe = await me(request, b);
    expect(bMe.permissions.metadata?.ownedSeries ?? []).not.toContain(UNOWNED);
    expect(bMe.permissions.addFiles?.closedSeries ?? []).not.toContain(UNOWNED);

    // ---- A's V.cbz; B's archive hiding V's curated layer is refused
    expect((await put(request, a, `${UNOWNED}/V.cbz`, cbzBytes(testInfo, 'V', 10))).status).toBe(
      201
    );
    const hiding = await put(request, b, `${UNOWNED}/V.curated.cbz`, cbzBytes(testInfo, 'Vc', 40));
    expect(hiding.status).toBe(403);
    expect(JSON.parse(hiding.body)).toMatchObject({ ok: false, reason: 'forbidden', retry: false });
    // Nor may V's own uploader: the name is kept for V's curated layer.
    const own = await put(request, a, `${UNOWNED}/V.curated.cbz`, cbzBytes(testInfo, 'Vc', 40));
    expect(own.status).toBe(403);
    expect(JSON.parse(own.body).detail).toMatch(/layer of the volume beside it/);
    expect(await listFolder(request, a, UNOWNED)).not.toContain('V.curated.cbz');

    // ---- reverse order: B's X.curated.cbz first is a new volume, anyone's to add
    expect(
      (await put(request, b, `${UNOWNED}/X.curated.cbz`, cbzBytes(testInfo, 'Xc', 70))).status
    ).toBe(201);
    // ... A's X.cbz beside it is allowed ...
    expect((await put(request, a, `${UNOWNED}/X.cbz`, cbzBytes(testInfo, 'X', 100))).status).toBe(
      201
    );
    // ... and from then on X controls X.curated.*: B lost them, A has them.
    const lost = await put(
      request,
      b,
      `${UNOWNED}/X.curated.mokuro`,
      mokuroJson(UNOWNED, 'X.curated', 'owners-x-curated', 'Bの')
    );
    expect(lost.status).toBe(403);
    expect(JSON.parse(lost.body)).toMatchObject({ ok: false, reason: 'forbidden', retry: false });
    expect((await dav(request, a, 'DELETE', `${UNOWNED}/X.curated.cbz`)).status).toBe(204);
    await expect
      .poll(() => listFolder(request, a, UNOWNED), { timeout: 15_000 })
      .not.toContain('X.curated.cbz');

    // ---- B's personal correction of A's volume: allowed, and B's alone
    const bEdit = mokuroJson(UNOWNED, 'V', 'owners-v', `B-correction-${Date.now()}`);
    expect((await put(request, b, `${UNOWNED}/V.edit.mokuro`, bEdit)).status).toBe(201);
    const bRead = await dav(request, b, 'GET', `${UNOWNED}/V.edit.mokuro`);
    expect(bRead.status).toBe(200);
    expect(bRead.body).toBe(bEdit); // stored, and B reads its own copy back
    const aRead = await dav(request, a, 'GET', `${UNOWNED}/V.edit.mokuro`);
    expect(aRead.body).not.toBe(bEdit);
    expect(aRead.body).not.toContain('B-correction-');
  });

  test('4. an editor adds to A’s series, and A, the owner, may delete it', async ({
    request
  }, testInfo) => {
    const a = account(A_USER, A_PW_FILE);
    const editor = account(ED_USER, ED_PW_FILE);
    const edMe = await me(request, editor);
    expect(edMe.role).toBe('editor');
    expect(edMe.permissions.canModifyDelete).toBe(true);
    const path = `${OWNED}/Editor Extra.cbz`;
    expect((await put(request, editor, path, cbzBytes(testInfo, 'ed', 220))).status).toBe(201);
    await expect
      .poll(() => listFolder(request, a, OWNED), { timeout: 15_000 })
      .toContain('Editor Extra.cbz');
    expect((await dav(request, a, 'DELETE', path)).status).toBe(204);
    await expect
      .poll(() => listFolder(request, a, OWNED), { timeout: 15_000 })
      .not.toContain('Editor Extra.cbz');
  });

  test('5. no ownership refusal reads as a sign-in failure', async () => {
    console.log(
      '[evidence] raw exchanges:',
      JSON.stringify(exchanges.map((e) => `${e.who} ${e.method} ${e.path} ${e.status}`))
    );
    expect(exchanges.length).toBeGreaterThan(10);
    expect(exchanges.filter((e) => e.status === 401)).toEqual([]);
    const refused = exchanges.filter((e) => e.status === 403);
    expect(refused.length).toBeGreaterThanOrEqual(2);
    for (const e of refused) {
      expect(e.statusText).toBe('Forbidden');
      expect(e.body).not.toMatch(/401|Unauthori[sz]ed|sign in/i);
      // Each names the ownership reason, not a generic "may not upload".
      const detail = (JSON.parse(e.body) as { detail: string }).detail;
      expect(detail).toMatch(/another account|did not upload|layer of the volume beside it/);
    }
  });
});
