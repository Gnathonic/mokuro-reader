import { test, expect, type Browser, type Page, type Route } from '@playwright/test';
import { gotoApp } from './helpers/app';

/**
 * Two devices, one cloud: the bug report behind fix/sync-diverged-reads,
 * replayed through the REAL sync code against an in-memory WebDAV server
 * (`page.route` on `http://stub.test`), each device a separate browser context
 * (its own localStorage + IndexedDB).
 *
 * The phone reads on and syncs; the laptop never pulls that, turns one page
 * from its stale position and syncs. Before the fix the laptop's newer record
 * replaced the phone's on every device — page turns, timer and all. Now the
 * newest page event still decides the position, but both devices' reading
 * survives. A third device opening the volume with no record of it no longer
 * resets progress everywhere, and a device coming back to the foreground pulls.
 */

const STUB = 'http://stub.test';
const ROOT = '/mokuro-reader';
const VOL = 'e2e-diverged-volume';
const DATA_FILE = `${ROOT}/volume-data.json`;

interface StubEntry {
  dir: boolean;
  body: Buffer;
  mtime: string;
}

/** A tiny in-memory WebDAV server behind `page.route` that logs every request. */
class WebDavStub {
  files = new Map<string, StubEntry>();
  log: Array<{ method: string; path: string }> = [];

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
    this.log.push({ method, path });
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
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(entry.body))
        });
      }
      case 'MKCOL': {
        this.dir(path);
        return reply(201);
      }
      case 'PUT': {
        // Binary-safe: history segments are deflated bytes.
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
    // Manual: the current month's history goes up now, not on the 5-minute cadence.
    return unifiedCloudManager.syncProgress({ silent: false });
  });
  expect(result.succeeded).toBe(1);
}

/**
 * Turn pages in order, a few ms apart, the way the reader does: each page is
 * a view recorded in reading history, and the position moves.
 */
async function read(page: Page, pages: number[]) {
  await page.evaluate(
    async ({ VOL, pages }) => {
      const { updateProgress } = await import('/src/lib/settings/volume-data.ts');
      const { recordEvent } = await import('/src/lib/reading-history/record.ts');
      for (const p of pages) {
        await recordEvent({
          kind: 'page',
          volume: VOL,
          first_page: p,
          last_page: p,
          page_chars: [100],
          chars_before: (p - 1) * 100,
          dwell_ms: 5,
          layout: 'single',
          orientation: 'portrait',
          viewport: { w: 400, h: 800 }
        });
        updateProgress(VOL, p, p * 100);
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    { VOL, pages }
  );
}

/** The position (stored record) and the reading the stats see (projected turns). */
async function record(page: Page) {
  return page.evaluate(async (VOL) => {
    const { volumes } = await import('/src/lib/settings/volume-data.ts');
    let all: Record<string, { progress: number; recentPageTurns: number[][] }> = {};
    volumes.subscribe((v) => (all = v))();
    const r = all[VOL];
    return r ? { progress: r.progress, pages: r.recentPageTurns.map((t: number[]) => t[1]) } : null;
  }, VOL);
}

function cloudRecord(stub: WebDavStub) {
  const file = stub.files.get(DATA_FILE);
  if (!file) return null;
  const r = JSON.parse(file.body.toString())[VOL];
  return { progress: r.progress, turns: r.recentPageTurns };
}

test.describe('reading on two devices (stubbed WebDAV)', () => {
  test("a stale device keeps the newest position but loses nobody's reading", async ({
    browser
  }) => {
    const stub = new WebDavStub();
    const phone = await device(browser, stub);
    const laptop = await device(browser, stub);

    // Both devices know p.38-40.
    await read(phone, [38, 39, 40]);
    await sync(phone);
    await sync(laptop);
    expect((await record(laptop))?.progress).toBe(40);

    // The phone reads on to p.44 and syncs; the laptop never pulls it.
    await read(phone, [41, 42, 43, 44]);
    await sync(phone);

    // The laptop, still on p.40, turns one page and syncs first.
    await read(laptop, [41]);
    await sync(laptop);

    const laptopAfter = await record(laptop);
    expect(laptopAfter?.progress).toBe(41); // the newest page event
    expect(laptopAfter?.pages).toEqual([38, 39, 40, 41, 42, 43, 44, 41]);
    // The file carries the position only; the reading travels as history.
    expect(cloudRecord(stub)).toEqual({ progress: 41, turns: undefined });

    // The phone converges on the same record; its reading is still there.
    await sync(phone);
    expect(await record(phone)).toEqual(laptopAfter);
  });

  test('opening a volume on a device with no record of it does not reset progress', async ({
    browser
  }) => {
    const stub = new WebDavStub();
    const phone = await device(browser, stub);
    await read(phone, [1, 2, 3, 120]);
    await sync(phone);

    // A new device opens the volume: the reader creates a blank record.
    const tablet = await device(browser, stub);
    await tablet.evaluate(async (VOL) => {
      const { initializeVolume } = await import('/src/lib/settings/volume-data.ts');
      await new Promise((r) => setTimeout(r, 5));
      initializeVolume(VOL);
    }, VOL);
    await sync(tablet);

    expect((await record(tablet))?.progress).toBe(120);
    expect(cloudRecord(stub)?.progress).toBe(120);
    await sync(phone);
    expect((await record(phone))?.progress).toBe(120);
  });

  test('coming back to the foreground pulls the cloud', async ({ browser }) => {
    const stub = new WebDavStub();
    const phone = await device(browser, stub);
    await read(phone, [5]);
    await sync(phone);

    // The laptop starts up (lists and syncs), then sleeps while the phone reads.
    const laptop = await device(browser, stub);
    await sync(laptop);
    await read(phone, [6]);
    await sync(phone);
    expect((await record(laptop))?.progress).toBe(5);

    await laptop.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await expect.poll(async () => (await record(laptop))?.progress, { timeout: 10000 }).toBe(6);
  });
});
