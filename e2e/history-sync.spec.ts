import { test, expect, type Browser, type Page, type Route } from '@playwright/test';
import { gotoApp } from './helpers/app';

/**
 * Reading history between two devices, through the REAL sync code against an
 * in-memory WebDAV server (`page.route` on `http://stub.test`), each device a
 * separate browser context (its own IndexedDB).
 *
 * Device A records page views and syncs: its month goes up as
 * `history/<A>/<YYYY-MM>.events` beside `device.json`. Device B syncs and holds
 * A's events, identical, under A's device id. Syncing again moves nothing.
 *
 * Mid-session (no reload, no full listing), B picks up A's NEW month through
 * the throttled `history/` listing (`history-listing-refresh.ts`): one
 * PROPFIND of that folder per interval, never a walk of the library.
 */

const STUB = 'http://stub.test';
const ROOT = '/mokuro-reader';

interface StubEntry {
  dir: boolean;
  body: Buffer;
  mtime: string;
}

/** A tiny in-memory WebDAV server behind `page.route` that logs every request. */
class WebDavStub {
  files = new Map<string, StubEntry>();
  log: Array<{ method: string; path: string; depth?: string }> = [];

  constructor() {
    this.dir('/');
    this.dir(ROOT);
  }
  dir(path: string) {
    this.files.set(this.norm(path), {
      dir: true,
      body: Buffer.alloc(0),
      mtime: new Date().toUTCString()
    });
  }
  file(path: string, body: Buffer, mtime: string) {
    const p = this.norm(path);
    this.dir(p.slice(0, p.lastIndexOf('/')) || '/');
    this.files.set(p, { dir: false, body, mtime });
  }
  norm(path: string): string {
    const decoded = decodeURIComponent(path).replace(/\/+$/, '');
    return decoded === '' ? '/' : decoded;
  }
  private children(path: string, deep: boolean): string[] {
    const prefix = path === '/' ? '/' : `${path}/`;
    return [...this.files.keys()].filter(
      (p) => p !== path && p.startsWith(prefix) && (deep || !p.slice(prefix.length).includes('/'))
    );
  }
  private multistatus(paths: string[]): string {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const responses = paths.map((p) => {
      const e = this.files.get(p)!;
      const href = e.dir && p !== '/' ? `${p}/` : p;
      return (
        `<d:response><d:href>${esc(encodeURI(href))}</d:href><d:propstat><d:prop>` +
        `<d:resourcetype>${e.dir ? '<d:collection/>' : ''}</d:resourcetype>` +
        `<d:getcontentlength>${e.dir ? 0 : Buffer.byteLength(e.body)}</d:getcontentlength>` +
        `<d:getlastmodified>${e.mtime}</d:getlastmodified>` +
        `<d:getcontenttype>${e.dir ? 'httpd/unix-directory' : 'application/octet-stream'}</d:getcontenttype>` +
        `<d:displayname>${esc(p.split('/').pop() ?? '')}</d:displayname>` +
        `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
      );
    });
    return `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${responses.join('')}</d:multistatus>`;
  }
  gets(path: string): number {
    return this.log.filter((l) => l.method === 'GET' && l.path === path).length;
  }
  handle = async (route: Route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = this.norm(url.pathname);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods':
        'GET, HEAD, PUT, DELETE, OPTIONS, PROPFIND, MKCOL, MOVE, COPY',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Expose-Headers': '*'
    };
    const reply = (
      status: number,
      body: string | Buffer = '',
      headers: Record<string, string> = {}
    ) => route.fulfill({ status, body, headers: { ...cors, ...headers } });

    if (url.pathname.endsWith('/login/api/me')) return reply(404, 'not bunko');
    if (method === 'OPTIONS') {
      return reply(200, '', {
        DAV: '1,2',
        Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, MOVE, COPY, PROPFIND'
      });
    }
    this.log.push({ method, path, depth: request.headers()['depth'] });
    const entry = this.files.get(path);
    switch (method) {
      case 'PROPFIND': {
        if (!entry) return reply(404);
        const depth = (request.headers()['depth'] ?? '1').toLowerCase();
        const paths =
          depth === '0'
            ? [path]
            : [path, ...this.children(path, depth === 'infinity')].filter((p) => this.files.has(p));
        return reply(207, this.multistatus(paths), { 'Content-Type': 'application/xml' });
      }
      case 'HEAD':
      case 'GET': {
        if (!entry || entry.dir) return reply(404);
        return reply(200, method === 'GET' ? entry.body : Buffer.alloc(0), {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(Buffer.byteLength(entry.body))
        });
      }
      case 'MKCOL': {
        this.dir(path);
        return reply(201);
      }
      case 'PUT': {
        this.file(path, request.postDataBuffer() ?? Buffer.alloc(0), new Date().toUTCString());
        return reply(201);
      }
      case 'DELETE': {
        if (!entry) return reply(404);
        for (const p of [path, ...this.children(path, true)]) this.files.delete(p);
        return reply(204);
      }
      default:
        return reply(405);
    }
  };
}

async function device(browser: Browser, stub: WebDavStub): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route(`${STUB}/**`, stub.handle);
  await gotoApp(page);
  await page.evaluate(async (serverUrl) => {
    const { providerManager } = await import('/src/lib/util/sync/provider-manager.ts');
    const provider = await providerManager.getOrLoadProvider('webdav');
    await provider.login({ serverUrl, username: '', password: '' });
    await providerManager.setCurrentProvider(provider);
  }, STUB);
  return page;
}

async function sync(page: Page) {
  const result = await page.evaluate(async () => {
    const { unifiedCloudManager } = await import('/src/lib/util/sync/unified-cloud-manager.ts');
    await unifiedCloudManager.fetchAllCloudVolumes();
    return unifiedCloudManager.syncProgress({ silent: false });
  });
  expect(result.succeeded).toBe(1);
}

async function deviceId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const { historyDb } = await import('/src/lib/reading-history/history-db.ts');
    const { getOrCreateDeviceId } = await import('/src/lib/reading-history/record.ts');
    return getOrCreateDeviceId(historyDb());
  });
}

/** Record page views on `page` at the given times. */
async function record(page: Page, volume: string, times: number[]) {
  await page.evaluate(
    async ({ volume, times }) => {
      const { recordEvent } = await import('/src/lib/reading-history/record.ts');
      for (const [i, t] of times.entries()) {
        await recordEvent(
          {
            kind: 'page',
            volume,
            first_page: i + 1,
            last_page: i + 1,
            page_chars: [10],
            chars_before: i * 10,
            dwell_ms: 4000,
            layout: 'single',
            orientation: 'portrait',
            viewport: { w: 400, h: 800 }
          },
          t
        );
      }
    },
    { volume, times }
  );
}

/** The sync a reading burst triggers mid-session: no full listing first. */
async function sessionSync(page: Page) {
  const result = await page.evaluate(async () => {
    const { unifiedCloudManager } = await import('/src/lib/util/sync/unified-cloud-manager.ts');
    return unifiedCloudManager.syncProgress({ silent: true });
  });
  expect(result.succeeded).toBe(1);
}

async function events(page: Page) {
  return page.evaluate(async () => {
    const { historyDb } = await import('/src/lib/reading-history/history-db.ts');
    return historyDb().reading_events.toArray();
  });
}

const historyPuts = (stub: WebDavStub) =>
  stub.log.filter((l) => l.method === 'PUT' && l.path.startsWith(`${ROOT}/history/`)).length;

test('two devices exchange reading history through WebDAV', async ({ browser }) => {
  const stub = new WebDavStub();
  const a = await device(browser, stub);
  const idA = await deviceId(a);

  await a.evaluate(async () => {
    const { recordEvent } = await import('/src/lib/reading-history/record.ts');
    for (const p of [1, 2, 3]) {
      await recordEvent(
        {
          kind: 'page',
          volume: 'e2e-history-volume',
          first_page: p,
          last_page: p,
          page_chars: [p * 10],
          chars_before: p * 100,
          dwell_ms: 4000 + p,
          layout: 'single',
          orientation: 'portrait',
          viewport: { w: 400, h: 800 }
        },
        Date.UTC(2026, 9, 3, 12, p)
      );
    }
  });
  await sync(a);

  expect(stub.files.has(`${ROOT}/history/${idA}/2026-10.events`)).toBe(true);
  expect(stub.files.has(`${ROOT}/history/${idA}/device.json`)).toBe(true);
  const facts = JSON.parse(stub.files.get(`${ROOT}/history/${idA}/device.json`)!.body.toString());
  expect(facts.device).toBe(idA);

  const b = await device(browser, stub);
  const idB = await deviceId(b);
  expect(idB).not.toBe(idA);
  await sync(b);

  const fromA = (await events(a)).filter((e) => e.device === idA);
  const onB = (await events(b)).filter((e) => e.device === idA);
  expect(onB).toHaveLength(3);
  expect(onB.sort((x, y) => x.seq - y.seq)).toEqual(fromA.sort((x, y) => x.seq - y.seq));

  // B wrote only its own folder; a second round moves nothing more.
  expect(
    [...stub.files]
      .filter(([p, e]) => !e.dir && p.startsWith(`${ROOT}/history/`))
      .map(([p]) => p)
      .sort()
  ).toEqual(
    [
      `${ROOT}/history/${idA}/2026-10.events`,
      `${ROOT}/history/${idA}/device.json`,
      `${ROOT}/history/${idB}/device.json`
    ].sort()
  );
  const putsBefore = historyPuts(stub);
  await sync(a);
  await sync(b);
  expect(historyPuts(stub)).toBe(putsBefore);
  expect((await events(b)).filter((e) => e.device === idA)).toHaveLength(3);
});

test("another device's new month arrives mid-session from one history/ PROPFIND", async ({
  browser
}) => {
  const stub = new WebDavStub();
  const a = await device(browser, stub);
  const idA = await deviceId(a);
  await record(a, 'e2e-history-volume', [Date.UTC(2026, 9, 3, 12, 1)]);
  await sync(a);

  const b = await device(browser, stub);
  await sync(b); // B's one full listing: it holds A's October
  expect((await events(b)).filter((e) => e.device === idA)).toHaveLength(1);

  // A reads into a new month and syncs it up.
  await record(a, 'e2e-history-volume', [Date.UTC(2026, 10, 5, 9, 0), Date.UTC(2026, 10, 5, 9, 1)]);
  await sync(a);
  const novemberA = `${ROOT}/history/${idA}/2026-11.events`;
  expect(stub.files.has(novemberA)).toBe(true);

  // Shorten the interval (5 min in the app) and let it pass since B's listing.
  const INTERVAL_MS = 4000;
  await b.evaluate(async (ms) => {
    const m = await import('/src/lib/util/sync/history-listing-refresh.ts');
    m._setHistoryRefreshIntervalForTests(ms);
  }, INTERVAL_MS);
  await b.waitForTimeout(INTERVAL_MS + 500);

  const from = stub.log.length;
  await sessionSync(b);
  await sessionSync(b); // within the interval: no second listing
  const window = stub.log.slice(from);

  expect((await events(b)).filter((e) => e.device === idA)).toHaveLength(3);
  expect(window.filter((l) => l.method === 'GET' && l.path === novemberA)).toHaveLength(1);
  const propfinds = window.filter((l) => l.method === 'PROPFIND');
  expect(
    propfinds.filter((l) => l.path === `${ROOT}/history`),
    JSON.stringify(propfinds)
  ).toEqual([{ method: 'PROPFIND', path: `${ROOT}/history`, depth: 'infinity' }]);
  // No walk of the library: nothing above or beside history/ listed deeper than a stamp.
  expect(
    propfinds.filter((l) => l.path !== `${ROOT}/history` && l.depth !== '0'),
    JSON.stringify(propfinds)
  ).toEqual([]);
});
