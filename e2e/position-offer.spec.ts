import { test, expect, type Browser, type Page, type Route } from '@playwright/test';
import { gotoApp } from './helpers/app';

/**
 * Cross-device position offers (phase 2c) through the REAL app, two devices
 * (browser contexts) sharing an in-memory WebDAV server.
 *
 * The phone reads on to p.44 and syncs. The laptop, which never pulled that,
 * turns one page from its stale p.40 and syncs — its position is now the
 * newest page event (p.41). Opening the volume, its reader offers "You also
 * read to page 44 on another device"; "Go to page 44" moves there. The answer
 * is history: after a sync the phone has nothing to offer either.
 */

const STUB = 'http://stub.test';
const ROOT = '/mokuro-reader';
const SERIES = 'Offer Series';
const SERIES_UUID = 'e2e-offer-series';
const VOL = 'e2e-offer-volume';
const PAGES = 50;

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

/** Install a 50-page volume locally (as a download would have left it). */
async function installVolume(page: Page) {
  await page.evaluate(
    async ({ SERIES, SERIES_UUID, VOL, PAGES }) => {
      const { db } = await import('/src/lib/catalog/db.ts');
      await db.open();
      const canvas = document.createElement('canvas');
      canvas.width = 200;
      canvas.height = 300;
      canvas.getContext('2d')!.fillRect(0, 0, 200, 300);
      const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), 'image/png'));
      const pages = Array.from({ length: PAGES }, (_, i) => ({
        version: '0.2.1',
        img_width: 200,
        img_height: 300,
        img_path: `${String(i + 1).padStart(3, '0')}.png`,
        blocks: []
      }));
      const files: Record<string, File> = {};
      for (const p of pages)
        files[p.img_path] = new File([blob], p.img_path, { type: 'image/png' });
      await db.volumes.put({
        volume_uuid: VOL,
        series_uuid: SERIES_UUID,
        series_title: SERIES,
        volume_title: 'Vol 1',
        mokuro_version: '0.2.1',
        page_count: PAGES,
        character_count: 0,
        page_char_counts: pages.map(() => 0),
        thumbnail: new File([blob], 'thumb.webp', { type: 'image/webp' })
      });
      await db.volume_ocr.put({ volume_uuid: VOL, pages });
      await db.volume_files.put({ volume_uuid: VOL, files });
      const { updateSetting } = await import('/src/lib/settings/index.ts');
      updateSetting('continuousScroll', false);
      updateSetting('singlePageView', 'single');
    },
    { SERIES, SERIES_UUID, VOL, PAGES }
  );
}

/** Read pages the way the reader records them: a view each, and the position. */
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
          page_chars: [0],
          chars_before: 0,
          dwell_ms: 5,
          layout: 'single',
          orientation: 'portrait',
          viewport: { w: 400, h: 800 }
        });
        updateProgress(VOL, p, 0);
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    { VOL, pages }
  );
}

async function plan(page: Page) {
  return page.evaluate(async (VOL) => {
    const { positionPlanFor } = await import('/src/lib/reading-history/position-store.ts');
    return positionPlanFor(VOL);
  }, VOL);
}

async function progress(page: Page) {
  return page.evaluate(async (VOL) => {
    const { volumesWithTrash } = await import('/src/lib/settings/volume-data.ts');
    let all: Record<string, { progress: number }> = {};
    volumesWithTrash.subscribe((v) => (all = v))();
    return all[VOL]?.progress ?? null;
  }, VOL);
}

test("a stale device is offered the other device's page, and the answer syncs", async ({
  browser
}) => {
  const stub = new WebDavStub();
  const phone = await device(browser, stub);
  const laptop = await device(browser, stub);
  await installVolume(laptop);

  await read(phone, [38, 39, 40]);
  await sync(phone);
  await sync(laptop);
  expect(await progress(laptop)).toBe(40);

  // The phone reads on; the laptop never pulls it, turns one page and syncs.
  await read(phone, [41, 42, 43, 44]);
  await sync(phone);
  await read(laptop, [41]);
  await sync(laptop);
  expect(await progress(laptop)).toBe(41);
  await expect
    .poll(() => plan(laptop), { timeout: 10000 })
    .toMatchObject({
      offer: { page: 44, ownDevice: false }
    });

  // Opening the volume, the reader offers the phone's page.
  await laptop.evaluate(
    ({ SERIES_UUID, VOL }) => {
      window.location.hash = `#/reader/${SERIES_UUID}/${VOL}`;
    },
    { SERIES_UUID, VOL }
  );
  const banner = laptop.getByTestId('position-offer');
  await expect(banner).toBeVisible({ timeout: 20000 });
  await expect(banner).toContainText('You also read to page 44 on another device');
  await banner.getByRole('button', { name: 'Go to page 44' }).click();
  await expect(banner).toBeHidden();
  await expect.poll(() => progress(laptop), { timeout: 10000 }).toBe(44);

  // The answer is history: once both have synced, the phone has nothing to
  // offer either, and its position followed the jump.
  await sync(laptop);
  await sync(phone);
  await expect.poll(() => plan(phone), { timeout: 10000 }).toEqual({});
  expect(await progress(phone)).toBe(44);
});
