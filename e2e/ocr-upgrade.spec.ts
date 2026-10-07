import { createHash } from 'node:crypto';
import { test, expect, type Page, type Route } from '@playwright/test';
import { gotoApp } from './helpers/app';

/**
 * Automatic OCR upgrades against the REAL app and a stubbed WebDAV server
 * (`page.route` answers PROPFIND / GET / PUT / DELETE / MKCOL / OPTIONS for
 * `http://stub.test`). One volume is installed locally from the cloud's
 * `.mokuro`; the server's `series.json` names that file's `mokuro_sha256`.
 * Then the server re-OCRs: a new `.mokuro` and a `series.json` naming its
 * hash. One listing later the installed volume carries the new text — in the
 * database and in the reader — with the archive never fetched.
 */

const SERIES = 'Upgrade Series';
const SERIES_UUID = 'e2e-upgrade-series';
const VOLUME_UUID = 'e2e-upgrade-volume';
const STUB = 'http://stub.test';
const ROOT = '/mokuro-reader';

function mokuroJson(text: string): string {
  return JSON.stringify({
    version: '0.2.1',
    title: SERIES,
    title_uuid: SERIES_UUID,
    volume: 'Vol 1',
    volume_uuid: VOLUME_UUID,
    pages: [
      {
        version: '0.2.1',
        img_width: 400,
        img_height: 600,
        img_path: '001.png',
        blocks: [{ box: [250, 50, 310, 250], vertical: true, font_size: 30, lines: [text] }]
      }
    ],
    chars: text.length
  });
}

function sha256(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function seriesJson(mokuro: string, updatedAt: string): string {
  return JSON.stringify({
    version: 2,
    series_title: SERIES,
    external_ids: {},
    titles: {},
    synonyms: [],
    updated_at: '1970-01-01T00:00:00.000Z',
    volumes: [
      {
        volume_uuid: VOLUME_UUID,
        volume_title: 'Vol 1',
        page_count: 1,
        character_count: 2,
        mokuro_version: '0.2.1',
        mokuro_size: Buffer.byteLength(mokuro),
        mokuro_modified: Math.trunc(Date.parse(updatedAt) / 1000),
        mokuro_sha256: sha256(mokuro)
      }
    ]
  });
}

interface StubEntry {
  dir: boolean;
  body: string;
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
    this.files.set(this.norm(path), { dir: true, body: '', mtime: new Date().toUTCString() });
  }
  file(path: string, body: string, mtime: string) {
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
    const reply = (status: number, body = '', headers: Record<string, string> = {}) =>
      route.fulfill({ status, body, headers: { ...cors, ...headers } });

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
        return reply(200, method === 'GET' ? entry.body : '', {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(entry.body))
        });
      }
      case 'MKCOL': {
        this.dir(path);
        return reply(201);
      }
      case 'PUT': {
        this.file(path, request.postData() ?? '', new Date().toUTCString());
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

/** The volume as a download from this cloud left it: its primary IS `mokuro`'s bytes. */
async function seedInstalledVolume(page: Page, mokuro: string) {
  await gotoApp(page);
  await page.evaluate(
    async ({ SERIES, SERIES_UUID, VOLUME_UUID, mokuro, hash, size, modified }) => {
      const { db } = await import('/src/lib/catalog/db.ts');
      await db.open();
      await Promise.all([
        db.volumes.clear(),
        db.volume_ocr.clear(),
        db.volume_files.clear(),
        db.series_index.clear(),
        (await import('/src/lib/catalog/layer-store.ts')).clearAllLayers(db)
      ]);
      const canvas = document.createElement('canvas');
      canvas.width = 400;
      canvas.height = 600;
      canvas.getContext('2d')!.fillRect(0, 0, 400, 600);
      const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), 'image/png'));
      const parsed = JSON.parse(mokuro);
      await db.volumes.put({
        volume_uuid: VOLUME_UUID,
        series_uuid: SERIES_UUID,
        series_title: SERIES,
        volume_title: 'Vol 1',
        mokuro_version: '0.2.1',
        page_count: 1,
        character_count: 2,
        page_char_counts: [2],
        thumbnail: new File([blob], 'thumb.webp', { type: 'image/webp' }),
        thumbnail_width: 400,
        thumbnail_height: 600,
        mokuro_sha256: hash,
        mokuro_sha256_cloud: { provider: 'webdav', size, modified }
      });
      await db.volume_ocr.put({ volume_uuid: VOLUME_UUID, pages: parsed.pages });
      await db.volume_files.put({
        volume_uuid: VOLUME_UUID,
        files: { '001.png': new File([blob], '001.png', { type: 'image/png' }) }
      });
      const { updateSetting } = await import('/src/lib/settings/index.ts');
      updateSetting('continuousScroll', false);
      updateSetting('singlePageView', 'single');
      window.localStorage.removeItem('ocr-upgrade:verdicts');
    },
    {
      SERIES,
      SERIES_UUID,
      VOLUME_UUID,
      mokuro,
      hash: sha256(mokuro),
      size: Buffer.byteLength(mokuro),
      modified: Math.trunc(Date.parse('Wed, 30 Sep 2026 10:00:00 GMT') / 1000)
    }
  );
  // The catalog reads the database through a coalesced live query. Connect the
  // cloud before it lists the seeded volume and the listing's archive is, for a
  // moment, a bare placeholder — whose cover service pulls its .mokuro to learn
  // what it is. A device that installed a volume has it in its catalog long
  // before any sync, so wait for that state rather than racing it.
  await page.evaluate(async (uuid) => {
    const { volumes } = await import('/src/lib/catalog/index.ts');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('the catalog never listed the seeded volume')),
        20000
      );
      let stop: (() => void) | undefined;
      let done = false;
      stop = volumes.subscribe((all: Record<string, unknown> | undefined) => {
        if (done || !all?.[uuid]) return;
        done = true;
        clearTimeout(timer);
        queueMicrotask(() => stop?.());
        resolve();
      });
    });
  }, VOLUME_UUID);
}

async function connectStub(page: Page) {
  await page.evaluate(async (serverUrl) => {
    const { providerManager } = await import('/src/lib/util/sync/provider-manager.ts');
    const provider = await providerManager.getOrLoadProvider('webdav');
    await provider.login({ serverUrl, username: '', password: '' });
    await providerManager.setCurrentProvider(provider);
    const { unifiedCloudManager } = await import('/src/lib/util/sync/unified-cloud-manager.ts');
    await unifiedCloudManager.fetchAllCloudVolumes();
  }, STUB);
}

async function relist(page: Page) {
  await page.evaluate(async () => {
    const { unifiedCloudManager } = await import('/src/lib/util/sync/unified-cloud-manager.ts');
    await unifiedCloudManager.fetchAllCloudVolumes();
  });
}

async function installedState(page: Page) {
  return page.evaluate(async (uuid) => {
    const { db } = await import('/src/lib/catalog/db.ts');
    const ocr = await db.volume_ocr.get(uuid);
    const row = await db.volumes.get(uuid);
    return {
      lines: ocr?.pages[0]?.blocks[0]?.lines ?? null,
      hash: row?.mokuro_sha256 ?? null,
      chars: row?.character_count ?? null,
      uuids: (await db.volumes.toArray()).map((v) => v.volume_uuid)
    };
  }, VOLUME_UUID);
}

test.describe('automatic OCR upgrade (stubbed WebDAV)', () => {
  test('a changed cloud .mokuro reaches the installed volume and the reader, archive untouched', async ({
    page
  }) => {
    const OLD_MTIME = 'Wed, 30 Sep 2026 10:00:00 GMT';
    const NEW_MTIME = 'Wed, 30 Sep 2026 12:00:00 GMT';
    const oldMokuro = mokuroJson('ふるい');
    const newMokuro = mokuroJson('あたらしい');
    const archive = `${ROOT}/${SERIES}/Vol 1.cbz`;
    const sidecar = `${ROOT}/${SERIES}/Vol 1.mokuro`;
    const index = `${ROOT}/${SERIES}/series.json`;

    const stub = new WebDavStub();
    stub.file(archive, 'PK-not-really', OLD_MTIME);
    stub.file(sidecar, oldMokuro, OLD_MTIME);
    stub.file(index, seriesJson(oldMokuro, OLD_MTIME), OLD_MTIME);
    await page.route(`${STUB}/**`, stub.handle);

    await seedInstalledVolume(page, oldMokuro);
    await connectStub(page);

    // The index is read, and names the file the volume already has: nothing more.
    await expect.poll(() => stub.gets(index), { timeout: 20000 }).toBeGreaterThan(0);
    await page.waitForTimeout(1500);
    expect(stub.gets(sidecar)).toBe(0);
    expect((await installedState(page)).lines).toEqual(['ふるい']);

    // The server re-OCRs the volume: a new sidecar, and an index naming its hash.
    stub.file(sidecar, newMokuro, NEW_MTIME);
    stub.file(index, seriesJson(newMokuro, NEW_MTIME), NEW_MTIME);
    await relist(page);

    await expect
      .poll(async () => (await installedState(page)).lines, { timeout: 20000 })
      .toEqual(['あたらしい']);
    const after = await installedState(page);
    expect(after.hash).toBe(sha256(newMokuro));
    expect(after.chars).toBe(5);
    // Same volume, same uuid — no second row.
    expect(after.uuids).toEqual([VOLUME_UUID]);
    expect(stub.gets(sidecar)).toBe(1);
    // ONE summary notice for the run.
    await expect(page.getByText('Updated OCR for 1 volume')).toBeVisible({ timeout: 5000 });

    // The reader shows the new text, from what is installed.
    await page.evaluate(
      ({ SERIES_UUID, VOLUME_UUID }) => {
        window.location.hash = `#/reader/${SERIES_UUID}/${VOLUME_UUID}`;
      },
      { SERIES_UUID, VOLUME_UUID }
    );
    const firstPage = page.locator('[data-page-index="0"]');
    await expect(firstPage).toBeVisible({ timeout: 20000 });
    await expect(firstPage.locator('.textBox').first()).toContainText('あたらしい', {
      timeout: 10000
    });
    await expect(firstPage).not.toContainText('ふるい');

    // The archive was never downloaded, at any point.
    expect(stub.gets(archive)).toBe(0);

    // Converged: another listing fetches nothing more.
    await relist(page);
    await page.waitForTimeout(1500);
    expect(stub.gets(sidecar)).toBe(1);
  });
});
