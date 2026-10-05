import { test, expect, type Browser, type Page, type Route } from '@playwright/test';

/**
 * The phase-2b cut-over between two devices, through the REAL app and sync
 * code against an in-memory WebDAV server. Device A starts with an old
 * client's progress (page turns + an archived read in localStorage): they
 * become reading-history events, leave volume-data.json, go up as A's
 * legacy.events, and device B serves the same turns from them. Turns an old
 * client writes back into the cloud file are converted and stripped again.
 */

const STUB = 'http://stub.test';
const ROOT = '/mokuro-reader';
const VOL = 'e2e-cutover-volume';
const DATA_FILE = `${ROOT}/volume-data.json`;
const T0 = Date.UTC(2026, 8, 1, 12);
const TURNS = [1, 2, 3, 4, 5].map((p) => [T0 + p * 30_000, p, p * 100]);

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

async function device(browser: Browser, stub: WebDavStub, seed?: unknown): Promise<Page> {
  const context = await browser.newContext();
  if (seed) {
    await context.addInitScript((json) => {
      if (!sessionStorage.getItem('seeded')) {
        localStorage.setItem('volumes', json);
        sessionStorage.setItem('seeded', '1');
      }
    }, JSON.stringify(seed));
  }
  const page = await context.newPage();
  await page.route(`${STUB}/**`, stub.handle);
  await page.goto('/');
  await page.waitForTimeout(800);
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

/** What the stats see: the public `volumes` store's turns for VOL. */
async function statTurns(page: Page) {
  return page.evaluate(async (VOL) => {
    const { volumes } = await import('/src/lib/settings/volume-data.ts');
    let all: Record<string, { recentPageTurns: number[][] }> = {};
    volumes.subscribe((v) => (all = v))();
    return all[VOL]?.recentPageTurns ?? null;
  }, VOL);
}

/** What is stored (and synced): the record's own turns. */
async function storedTurns(page: Page) {
  return page.evaluate(async (VOL) => {
    const { volumesWithTrash } = await import('/src/lib/settings/volume-data.ts');
    let all: Record<string, { recentPageTurns: number[][] }> = {};
    volumesWithTrash.subscribe((v) => (all = v))();
    return all[VOL]?.recentPageTurns ?? null;
  }, VOL);
}

function cloudRecord(stub: WebDavStub) {
  return JSON.parse(stub.files.get(DATA_FILE)!.body.toString())[VOL];
}

test('legacy page turns cut over across two devices', async ({ browser }) => {
  const stub = new WebDavStub();
  const a = await device(browser, stub, {
    [VOL]: {
      progress: 5,
      chars: 500,
      lastProgressUpdate: new Date(T0 + 200_000).toISOString(),
      recentPageTurns: TURNS,
      archivedReads: [{ at: T0, pages: 10, chars: 1000, completed: true }]
    }
  });

  // On start: converted and stripped locally, still served to the stats.
  await expect.poll(() => storedTurns(a), { timeout: 10000 }).toEqual([]);
  await expect.poll(() => statTurns(a), { timeout: 10000 }).toEqual(TURNS);

  await sync(a);
  const idA = await a.evaluate(async () => {
    const { historyDb } = await import('/src/lib/reading-history/history-db.ts');
    const { getOrCreateDeviceId } = await import('/src/lib/reading-history/record.ts');
    return getOrCreateDeviceId(historyDb());
  });
  expect(cloudRecord(stub).recentPageTurns).toBeUndefined();
  expect(cloudRecord(stub).archivedReads).toHaveLength(1);
  expect(stub.files.has(`${ROOT}/history/${idA}/legacy.events`)).toBe(true);

  // A fresh device serves the same turns, from A's legacy segment.
  const b = await device(browser, stub);
  await sync(b);
  await expect.poll(() => statTurns(b), { timeout: 10000 }).toEqual(TURNS);
  expect(await storedTurns(b)).toEqual([]);

  // An old client writes a turn back into the cloud file.
  const file = JSON.parse(stub.files.get(DATA_FILE)!.body.toString());
  const extra = [T0 + 400_000, 6, 600];
  file[VOL].recentPageTurns = [extra];
  file[VOL].lastProgressUpdate = new Date(T0 + 400_000).toISOString();
  stub.file(DATA_FILE, Buffer.from(JSON.stringify(file)), new Date().toUTCString());

  await sync(a);
  expect(cloudRecord(stub).recentPageTurns).toBeUndefined();
  await expect.poll(() => statTurns(a), { timeout: 10000 }).toEqual([...TURNS, extra]);
});
