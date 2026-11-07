import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { isAppViolation, type CspViolation } from '../src/lib/security/csp-violations';
import { vercelHeadersFor } from './helpers/vercel-headers';
import { writeSyntheticVolume, type SyntheticVolume } from './helpers/synthetic-volume';

/**
 * The shell's Content-Security-Policy, per CSP_MODE, in a PRODUCTION build
 * (`vite build` + `vite preview`): the dev server's policy is not the one that
 * ships (kit loosens style-src there for Vite's injected styles).
 *
 * Each mode gets its own build in its own `kit.outDir` (MOKURO_E2E_KIT_OUT_DIR,
 * under node_modules — see BUILDS), so the suite's dev server never sees its
 * generated files change. `vercel.json`'s
 * headers — the worker CSP, framing, COOP, Permissions-Policy — are not applied
 * by `vite preview`, so every app response is re-issued with them on the way
 * into the browser (`vercelHeadersFor`): the run sees what a deployment sends.
 *
 * Everything off the machine is answered here: the two Google scripts (and the
 * module and stylesheet each pulls in, at the exact paths the policy allows)
 * with stubs that record that they ran; every other host is refused. A refused
 * request is a network error, not a CSP violation, so it cannot hide one.
 *
 * What the browser cannot be made to show here, the owner checks by hand before
 * enforcing in production: Yomitan and Migaku (extensions are not loaded in
 * this run), real Google sign-in / Picker, OneDrive's MSAL frames.
 *
 * Two more blocks below the modes: the Drive sign-in callback page under its own
 * `vercel.json` policy (no build needed), and an enforce build with the Drive
 * auth backend on, signing in through it end to end.
 */

const MODES = ['off', 'report-only', 'enforce'] as const;

/**
 * Where each mode's build goes. Under node_modules on purpose: Vite's dev
 * watcher ignores it — a build anywhere else in the project writes a
 * tsconfig.json the suite's dev server sees, and Vite answers that with a full
 * reload of every page the other specs have open. And inside the project: the
 * built server resolves its packages from the project's node_modules.
 */
const BUILDS = join('node_modules', '.cache', 'csp-e2e');

test.use({
  // A controlling service worker would fetch cross-origin fonts itself, past the
  // routes below. Its registration is covered by its own test.
  serviceWorkers: 'block'
});

const GAPI = 'https://apis.google.com/js/api.js';
const GAPI_MODULE =
  'https://apis.google.com/_/scs/abc-static/_/js/k=gapi.lb.en.e2e/m=client/cb=gapi.loaded_0';
const GIS = 'https://accounts.google.com/gsi/client';
const GIS_STYLE = 'https://accounts.google.com/gsi/style';
/** Script URLs the policy must REFUSE: the bare hosts' JSONP/AngularJS gadgets. */
const GADGETS = [
  'https://accounts.google.com/o/e2e-gadget.js',
  'https://www.gstatic.com/e2e-gadget.js'
];

const js = (body: string) => ({ status: 200, contentType: 'application/javascript', body });
const mark = (key: string) =>
  `(window.__e2eGoogle = window.__e2eGoogle || {})[${JSON.stringify(key)}] = true;`;

/** What the stubbed Google hosts answer, by URL prefix. */
const STUBS: [string, { status: number; contentType: string; body: string }][] = [
  [
    GAPI,
    js(
      `${mark('gapi')}
       const s = document.createElement('script');
       s.src = ${JSON.stringify(GAPI_MODULE)};
       document.head.appendChild(s);`
    )
  ],
  ['https://apis.google.com/_/scs/', js(mark('gapiModule'))],
  [
    GIS,
    js(
      `${mark('gis')}
       const l = document.createElement('link');
       l.rel = 'stylesheet';
       l.href = ${JSON.stringify(GIS_STYLE)};
       l.onload = () => { ${mark('gisStyle')} };
       document.head.appendChild(l);`
    )
  ],
  [GIS_STYLE, { status: 200, contentType: 'text/css', body: '/* e2e */' }],
  ...GADGETS.map((url) => [url, js(mark(url))] as [string, ReturnType<typeof js>])
];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as import('node:net').AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} ${args.join(' ')} exited ${code}\n${output}`))
    );
  });
}

async function waitForServer(url: string, child: ChildProcess, deadline: number) {
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`preview exited ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.status > 0) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`preview at ${url} never answered`);
}

/** `vite build` into `outDir` with `extraEnv`, then `vite preview` of it on a free port. */
async function buildAndPreview(
  outDir: string,
  extraEnv: NodeJS.ProcessEnv
): Promise<{ origin: string; preview: ChildProcess }> {
  const env = { ...process.env, ...extraEnv, MOKURO_E2E_KIT_OUT_DIR: outDir };
  rmSync(outDir, { recursive: true, force: true });
  await run('npx', ['vite', 'build'], env);
  const port = await freePort();
  const origin = `http://localhost:${port}`;
  const preview = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], {
    env,
    stdio: 'ignore',
    detached: true
  });
  await waitForServer(`${origin}/`, preview, Date.now() + 60_000);
  return { origin, preview };
}

function stopPreview(preview: ChildProcess | null) {
  if (preview?.pid) {
    try {
      process.kill(-preview.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
}

/** Every CSP / Permissions-Policy complaint the browser writes to the console. */
function watchConsole(page: Page) {
  const csp: string[] = [];
  const permissions: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    // Chrome names the policy in every CSP message, report-only ones included.
    if (/Content Security Policy/i.test(text)) csp.push(text);
    if (/Permissions[- ]Policy|Unrecognized feature/i.test(text)) permissions.push(text);
  });
  return { csp, permissions };
}

/**
 * Re-issue every app response with `vercel.json`'s headers; answer the Google
 * stubs; refuse every other host.
 */
async function routeLikeVercel(context: BrowserContext, origin: string, stubs = STUBS) {
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(origin)) {
      const { pathname } = new URL(url);
      // Vercel serves its analytics script on a deployment; `vite preview`
      // answers the path with the HTML shell, which nosniff then refuses.
      if (pathname === '/_vercel/insights/script.js') return route.fulfill(js(''));
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: { ...response.headers(), ...vercelHeadersFor(pathname) }
      });
      return;
    }
    const stub = stubs.find(([prefix]) => url.startsWith(prefix));
    if (stub) return route.fulfill(stub[1]);
    return route.abort('blockedbyclient');
  });
}

async function violations(page: Page): Promise<CspViolation[]> {
  return page.evaluate(() => {
    const read = (window as unknown as { __mokuroCspViolations?: () => CspViolation[] })
      .__mokuroCspViolations;
    return read ? read() : [];
  });
}

async function boot(page: Page, origin: string) {
  await page.goto(`${origin}/`);
  await expect
    .poll(() => page.evaluate(() => window.location.hash), {
      timeout: 30000,
      message: 'the app never booted (the router never claimed the URL)'
    })
    .toBe('#/catalog');
}

async function importVolume(page: Page, volume: SyntheticVolume) {
  // The navbar's upload icon (stats, progress tracker, settings, upload, cloud).
  await page.locator('nav div.md\\:order-2 > button').nth(3).click();
  const chooser = page.waitForEvent('filechooser');
  await page.locator('dialog button', { hasText: 'choose files' }).click();
  await (await chooser).setFiles([volume.mokuro, volume.cbz]);
  await page.locator('dialog button', { hasText: /^\s*Import\s*$/ }).click();
  // Saved = its image row exists. Read IndexedDB directly: a production build
  // has no `/src/...` module to import.
  await expect
    .poll(
      () =>
        page.evaluate(
          (uuid) =>
            new Promise<boolean>((resolve) => {
              const open = indexedDB.open('mokuro_v3');
              open.onerror = () => resolve(false);
              open.onsuccess = () => {
                const db = open.result;
                if (!db.objectStoreNames.contains('volume_files')) return resolve(false);
                const get = db.transaction('volume_files').objectStore('volume_files').get(uuid);
                get.onsuccess = () => resolve(get.result != null);
                get.onerror = () => resolve(false);
              };
            }),
          volume.volumeUuid
        ),
      { timeout: 60_000, message: 'the import never saved the volume' }
    )
    .toBe(true);
}

/** The colour of one screen pixel, from a 1×1 PNG screenshot (any filter type
 * reduces to the raw bytes for the first pixel of the first row). */
async function pixel(page: Page, x: number, y: number): Promise<[number, number, number]> {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    if (type === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return [raw[1], raw[2], raw[3]];
}

for (const mode of MODES) {
  test.describe(`CSP_MODE=${mode}`, () => {
    test.describe.configure({ mode: 'serial' });

    const outDir = join(BUILDS, mode);
    let preview: ChildProcess | null = null;
    let origin = '';

    test.beforeAll(async () => {
      test.setTimeout(300_000);
      ({ origin, preview } = await buildAndPreview(outDir, { CSP_MODE: mode }));
    });

    test.afterAll(() => stopPreview(preview));

    test('the shell answers 200 with this mode’s policy, and reports nowhere', async ({
      request
    }) => {
      const response = await request.get(`${origin}/`);
      expect(response.status()).toBe(200);
      const headers = response.headers();
      const enforced = headers['content-security-policy'];
      const reportOnly = headers['content-security-policy-report-only'];
      expect(headers['reporting-endpoints']).toBeUndefined();
      expect(headers['report-to']).toBeUndefined();

      if (mode === 'off') {
        expect(enforced).toBeUndefined();
        expect(reportOnly).toBeUndefined();
        return;
      }
      const policy = mode === 'enforce' ? enforced : reportOnly;
      expect(mode === 'enforce' ? reportOnly : enforced).toBeUndefined();
      expect(policy).toBeTruthy();
      // kit's inline boot script, by hash — never a nonce on a cached shell.
      expect(policy).toMatch(/script-src [^;]*'sha256-[A-Za-z0-9+/=]+'/);
      expect(policy).not.toMatch(/nonce-/);
      expect(policy).not.toMatch(/report-uri/);
      if (mode === 'report-only') expect(policy).toMatch(/report-to csp-noop/);
      else expect(policy).not.toMatch(/report-to/);
      // The shell's inline scripts are kit's alone (app.html has none left).
      const html = (await response.text()).replace(/<!--[\s\S]*?-->/g, '');
      expect(html).not.toMatch(/<script\b[^>]*\bsrc=/);
      expect(html).not.toMatch(/<style\b/);
    });

    test('boot, import, reader, OCR text, settings, night mode, cloud page: no app violations', async ({
      context,
      page
    }) => {
      test.setTimeout(180_000);
      const volume = writeSyntheticVolume();
      const consoleLog = watchConsole(page);
      const workers: string[] = [];
      page.on('worker', (worker) => workers.push(new URL(worker.url()).pathname));
      await routeLikeVercel(context, origin);

      await boot(page, origin);
      // No Google script until Drive is needed (C5): not on the catalog.
      await expect(page.locator(`script[src="${GAPI}"], script[src="${GIS}"]`)).toHaveCount(0);

      await importVolume(page, volume);
      // The import's archive streaming runs in the unified file worker, under
      // the worker CSP vercel.json gives it.
      expect(workers.some((w) => w.startsWith('/_app/immutable/workers/'))).toBe(true);

      await page.evaluate(
        ([series, vol]) => (window.location.hash = `#/reader/${series}/${vol}`),
        [volume.seriesUuid, volume.volumeUuid]
      );
      const pageEl = page.locator('#manga-panel [data-page-index]').first();
      await expect(pageEl).toBeVisible({ timeout: 30000 });
      // The OCR text layer.
      await expect(page.locator('.textBox').first()).toContainText(volume.text, {
        timeout: 20000
      });

      const box = (await pageEl.boundingBox())!;
      const probe = {
        x: Math.round(box.x + box.width * 0.15),
        y: Math.round(box.y + box.height * 0.85)
      };
      const [r0, g0, b0] = await pixel(page, probe.x, probe.y);
      expect(Math.abs(g0 - volume.colour[1]), `page colour before night mode`).toBeLessThan(12);
      expect(Math.abs(b0 - volume.colour[2])).toBeLessThan(12);
      expect(r0).toBeGreaterThan(150);

      // Settings panel → Night mode, through the real controls.
      await page.locator('button.reader-hud.right-3').click();
      await page.getByText('Enable night mode').click();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.classList.contains('night-mode')))
        .toBe(true);
      // The drawer's own Close button, not its header's X (whose sr-only text is also Close).
      await page.locator('#settings button[type="button"]', { hasText: /^\s*Close\s*$/ }).click();
      await expect(page.locator('#settings')).toBeHidden();
      // Red monochrome: luminance in red, nothing in green or blue.
      await expect
        .poll(
          async () => {
            const [r, g, b] = await pixel(page, probe.x, probe.y);
            return r > 180 && g < 10 && b < 10;
          },
          { message: 'night mode tints the page red' }
        )
        .toBe(true);

      // The cloud page loads the Google scripts (C5), and the policy lets each
      // one — and what it pulls in, at the allowed paths — run.
      await page.evaluate(() => (window.location.hash = '#/cloud'));
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as unknown as { __e2eGoogle?: Record<string, boolean> }).__e2eGoogle ?? {}
          )
        )
        .toEqual({ gapi: true, gapiModule: true, gis: true, gisStyle: true });
      await expect(page.locator(`script[src="${GAPI}"]`)).toHaveCount(1);
      await expect(page.locator(`script[src="${GIS}"]`)).toHaveCount(1);

      // No extension is loaded here, so the filter removes nothing; by hand,
      // with Yomitan or Migaku on, every entry counts (`isAppViolation`).
      const appViolations = (await violations(page)).filter(isAppViolation);
      expect(appViolations, JSON.stringify(appViolations, null, 2)).toEqual([]);
      expect(consoleLog.csp).toEqual([]);
      // vercel.json's Permissions-Policy names only features Chromium knows —
      // but `bluetooth`, a spec feature Chromium does not parse yet: denied
      // ahead of time on purpose, one console warning per load.
      expect(consoleLog.permissions).toEqual([
        "Error with Permissions-Policy header: Unrecognized feature: 'bluetooth'."
      ]);

      // ...and the zero above covers the app's workers too: a violation in one
      // fires on the worker, never on the document, and reaches no console this
      // run can read (page or worker), so the worker forwards it to the page's
      // buffer. Prove that path with one deliberate violation in a live app
      // worker: a module from another origin, which the worker policy
      // (vercel.json, every mode) refuses. Not `eval`: code evaluated over CDP
      // is exempt from a policy's eval rule.
      const appWorker = page
        .workers()
        .find((w) => new URL(w.url()).pathname.startsWith('/_app/immutable/workers/'));
      expect(appWorker, `a live app worker (seen: ${workers.join(', ')})`).toBeTruthy();
      const workerPath = new URL(appWorker!.url()).pathname;
      const gadget = GADGETS[1];
      const imported = await appWorker!.evaluate(
        (url) =>
          import(/* @vite-ignore */ url).then(
            () => true,
            () => false
          ),
        gadget
      );
      expect(imported, 'the worker policy refuses a cross-origin module').toBe(false);
      await expect
        .poll(async () =>
          (await violations(page))
            .filter((v) => v.context !== 'document')
            .map((v) => `${v.context} ${v.blockedURI}`)
        )
        .toEqual([`worker ${workerPath} ${gadget}`]);
      expect(consoleLog.csp).toEqual([]);
    });

    test('the bare Google hosts stay closed to scripts, and the page records the attempt', async ({
      context,
      page
    }) => {
      await routeLikeVercel(context, origin);
      await boot(page, origin);
      await page.evaluate((urls) => {
        for (const src of urls) {
          const s = document.createElement('script');
          s.src = src;
          document.head.appendChild(s);
        }
      }, GADGETS);
      await page.waitForTimeout(1000);

      const ran = await page.evaluate(
        () => (window as unknown as { __e2eGoogle?: Record<string, boolean> }).__e2eGoogle ?? {}
      );
      const recorded = (await violations(page)).filter((v) => GADGETS.includes(v.blockedURI));
      if (mode === 'off') {
        expect(Object.keys(ran).sort()).toEqual([...GADGETS].sort());
        expect(recorded).toEqual([]);
        return;
      }
      // Report-only lets them run and counts them; enforce refuses them.
      expect(Object.keys(ran).sort()).toEqual(mode === 'enforce' ? [] : [...GADGETS].sort());
      expect(recorded.map((v) => v.blockedURI).sort()).toEqual([...GADGETS].sort());
      for (const v of recorded) {
        expect(v.disposition).toBe(mode === 'enforce' ? 'enforce' : 'report');
        expect(v.directive).toBe('script-src-elem');
      }
    });

    test('the service worker registers under the policy', async ({ browser }) => {
      const context = await browser.newContext({ serviceWorkers: 'allow' });
      const page = await context.newPage();
      const consoleLog = watchConsole(page);
      await boot(page, origin);
      const scope = await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        return registration.scope;
      });
      expect(scope).toBe(`${origin}/`);
      expect((await violations(page)).filter(isAppViolation)).toEqual([]);
      expect(consoleLog.csp).toEqual([]);
      await context.close();
    });
  });
}

/**
 * Every `securitypolicyviolation` in every document of the page, kept in
 * sessionStorage: the Drive callback page replaces itself at once, so its own
 * listeners and the app's buffer are both gone by the time anything is read.
 * Init scripts come in over CDP, outside every page policy.
 */
async function recordViolationsAcrossDocuments(page: Page) {
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const key = '__e2eCspViolations';
      const seen = JSON.parse(sessionStorage.getItem(key) || '[]');
      seen.push({
        page: location.pathname,
        directive: event.effectiveDirective,
        blocked: event.blockedURI,
        disposition: event.disposition
      });
      sessionStorage.setItem(key, JSON.stringify(seen));
    });
  });
  return () =>
    page.evaluate(() => JSON.parse(sessionStorage.getItem('__e2eCspViolations') || '[]'));
}

/** What `static/oauth/google-callback.js` hands the app (`auth-backend.ts`). */
const OAUTH_PENDING_KEY = 'gdrive_oauth_pending';
const OAUTH_CALLBACK_KEY = 'gdrive_oauth_callback';
/** The callback page's policy, as `vercel.json` sends it (pinned in vercel-headers.test.ts). */
const CALLBACK_CSP =
  "default-src 'none'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

test('the Drive sign-in callback page runs under its own enforced policy', async ({ page }) => {
  // The exact files, under the exact headers vercel.json gives /oauth/ — on an
  // origin this test answers itself, so no build or server is needed.
  const origin = 'https://reader.e2e.test';
  const files: Record<string, { type: string; body: string }> = {
    '/oauth/google-callback.html': {
      type: 'text/html; charset=utf-8',
      body: readFileSync(join('static', 'oauth', 'google-callback.html'), 'utf8')
    },
    '/oauth/google-callback.js': {
      type: 'text/javascript; charset=utf-8',
      body: readFileSync(join('static', 'oauth', 'google-callback.js'), 'utf8')
    }
  };
  expect(vercelHeadersFor('/oauth/google-callback.html')['content-security-policy']).toBe(
    CALLBACK_CSP
  );
  const served: { path: string; csp?: string }[] = [];
  await page.route(`${origin}/**`, (route) => {
    const { pathname } = new URL(route.request().url());
    const file = files[pathname];
    const headers: Record<string, string> = {
      'content-type': file?.type ?? 'text/html',
      ...vercelHeadersFor(pathname)
    };
    served.push({ path: pathname, csp: headers['content-security-policy'] });
    // Anything else stands in for the app the callback hands back to.
    return route.fulfill({
      status: 200,
      headers,
      body: file?.body ?? '<!doctype html><title>app</title>'
    });
  });
  const recorded = await recordViolationsAcrossDocuments(page);
  const consoleLog = watchConsole(page);

  // A sign-in this tab started (startSignIn's record), then Google's redirect.
  await page.goto(`${origin}/`);
  await page.evaluate(
    (key) =>
      sessionStorage.setItem(
        key,
        JSON.stringify({
          state: 'e2e-state',
          verifier: 'v',
          returnTo: '#/cloud',
          createdAt: Date.now()
        })
      ),
    OAUTH_PENDING_KEY
  );
  await page.goto(`${origin}/oauth/google-callback.html?code=4%2Fe2e-code&state=e2e-state`);

  // The script ran: it stashed the answer and replaced itself with the app.
  await expect.poll(() => page.url()).toBe(`${origin}/#/cloud`);
  expect(
    await page.evaluate(
      (key) => JSON.parse(sessionStorage.getItem(key) || 'null'),
      OAUTH_CALLBACK_KEY
    )
  ).toEqual({ code: '4/e2e-code', state: 'e2e-state', error: null });
  // Both files went out under the callback policy (the app stand-in under none).
  expect(served.filter((s) => s.path.startsWith('/oauth/'))).toEqual([
    { path: '/oauth/google-callback.html', csp: CALLBACK_CSP },
    { path: '/oauth/google-callback.js', csp: CALLBACK_CSP }
  ]);
  expect(await recorded()).toEqual([]);
  expect(consoleLog.csp).toEqual([]);
});

/**
 * The enforced shell with the Drive auth backend on (`VITE_GDRIVE_AUTH_BACKEND`):
 * Connect leaves for Google's page (here: answered with a code), comes back
 * through the static callback page under ITS policy, and the app redeems the
 * code at `/api/gdrive/session`; then sign-out goes to `/api/gdrive/logout`.
 * The routes are answered in the browser — the token exchange itself is
 * server-side and has its own spec (`gdrive-auth-backend.spec.ts`); what is
 * under test here is everything the PAGE does, under the policy it ships with.
 */
test.describe('CSP_MODE=enforce with the Drive auth backend', () => {
  test.describe.configure({ mode: 'serial' });

  const outDir = join(BUILDS, 'enforce-gdrive-backend');
  let preview: ChildProcess | null = null;
  let origin = '';

  /** gapi and GIS as inert stand-ins that the app can initialize against. */
  const BACKEND_STUBS: typeof STUBS = [
    [
      GAPI,
      js(`${mark('gapi')}
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
        };`)
    ],
    [
      GIS,
      js(`${mark('gis')}
        window.google = { accounts: { oauth2: {
          initTokenClient: function () {
            return { requestAccessToken: function () { window.__e2ePopupOpened = true; } };
          }
        } } };`)
    ]
  ];

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    ({ origin, preview } = await buildAndPreview(outDir, {
      CSP_MODE: 'enforce',
      VITE_GDRIVE_AUTH_BACKEND: 'true',
      VITE_GDRIVE_CLIENT_ID: 'e2e-client.apps.example'
    }));
  });

  test.afterAll(() => stopPreview(preview));

  test('sign-in, the callback page, the session and sign-out: nothing refused', async ({
    context,
    page
  }) => {
    test.setTimeout(180_000);
    await routeLikeVercel(context, origin, BACKEND_STUBS);
    const backendCalls: string[] = [];
    const api = (status: number, body: unknown) => ({
      status,
      contentType: 'application/json',
      headers: vercelHeadersFor('/api/gdrive/x'),
      body: JSON.stringify(body)
    });
    // Page routes win over the context's: the auth API, Google's consent
    // screen, Drive's REST host and Google's revoke endpoint.
    await page.route(`${origin}/api/gdrive/**`, (route) => {
      const route_ = new URL(route.request().url()).pathname.replace('/api/gdrive/', '');
      backendCalls.push(route_);
      if (route_ === 'refresh') return route.fulfill(api(401, { error: 'no_session' }));
      if (route_ === 'session')
        return route.fulfill(api(200, { access_token: 'ya29.csp-1', expires_in: 3599 }));
      if (route_ === 'logout') return route.fulfill(api(200, { ok: true, revoked: true }));
      return route.fulfill(api(404, { error: 'not_found' }));
    });
    const consent: { url?: URL } = {};
    await page.route('https://accounts.google.com/o/oauth2/v2/auth**', (route) => {
      const url = new URL(route.request().url());
      consent.url = url;
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', '4/e2e-code');
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      // A page that moves on, not a 302: the browser follows a fulfilled
      // redirect without routing it, and the callback page must come back
      // through routeLikeVercel to be served under its vercel.json policy.
      const to = back.toString().replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><meta http-equiv="refresh" content="0;url=${to}">`
      });
    });
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': '*'
    };
    await page.route('https://www.googleapis.com/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: cors,
        body: '{"id":"e2e-file"}'
      })
    );
    await page.route('https://oauth2.googleapis.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '{}' })
    );
    const callbackPolicies: (string | undefined)[] = [];
    page.on('response', (response) => {
      if (new URL(response.url()).pathname === '/oauth/google-callback.html')
        callbackPolicies.push(response.headers()['content-security-policy']);
    });
    const recorded = await recordViolationsAcrossDocuments(page);
    const consoleLog = watchConsole(page);
    const storedToken = () =>
      page.evaluate(() => localStorage.getItem('gdrive_token')).catch(() => undefined);

    const shell = await page.goto(`${origin}/#/cloud`);
    expect(shell?.headers()['content-security-policy']).toMatch(/script-src /);
    const connect = page.getByRole('button', { name: /Google Drive.*15GB free/ });
    await expect(connect).toBeVisible({ timeout: 30_000 });
    await connect.click();

    await expect.poll(storedToken, { timeout: 60_000 }).toBe('ya29.csp-1');
    expect(page.url()).toBe(`${origin}/#/cloud`);
    expect(consent.url?.searchParams.get('redirect_uri')).toBe(
      `${origin}/oauth/google-callback.html`
    );
    expect(callbackPolicies).toEqual([CALLBACK_CSP]);
    expect(backendCalls).toEqual(expect.arrayContaining(['refresh', 'session']));
    // The Google scripts ran under the policy; no popup was asked for.
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __e2eGoogle?: Record<string, boolean> }).__e2eGoogle ?? {}
        )
      )
      .toEqual({ gapi: true, gis: true });
    expect(
      await page.evaluate(() => (window as { __e2ePopupOpened?: boolean }).__e2ePopupOpened)
    ).toBeFalsy();

    // Sign-out reaches the backend. The token is cleared AHEAD of /logout
    // (a reload mid-sign-out must still find this device signed out), so wait
    // for the request itself, not just the cleared token.
    await page.getByRole('button', { name: 'Log out' }).click();
    await expect.poll(storedToken, { timeout: 30_000 }).toBeNull();
    await expect.poll(() => backendCalls, { timeout: 30_000 }).toContain('logout');

    expect(await recorded()).toEqual([]);
    expect((await violations(page)).filter(isAppViolation)).toEqual([]);
    expect(consoleLog.csp).toEqual([]);
  });
});

// Each mode's build is large; leave none behind.
test.afterAll(() => {
  rmSync(BUILDS, { recursive: true, force: true });
});
