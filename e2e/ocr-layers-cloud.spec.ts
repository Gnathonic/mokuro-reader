import { test, expect, type Page, type Route } from '@playwright/test';

/**
 * OCR layers in the cloud, against the REAL app and a stubbed WebDAV server
 * (`page.route` answers PROPFIND / GET / PUT / MOVE / DELETE / MKCOL / OPTIONS
 * for `http://stub.test`). One installed volume is seeded locally; the stub
 * lists its archive, its primary `.mokuro`, a bunko-style engine layer
 * `Vol 1.paddle-manga.mokuro`, a dotted sibling volume `Vol 1.5` with its own
 * primary, and an orphan `Vol 2.gcv.mokuro` with no archive. Asserted: the
 * engine layer becomes a row (kind ocr, engine paddle-manga), the dotted
 * volume and the orphan never become layers or phantom volumes, a local edit
 * is pushed under the same name, a rename MOVES the layer file, a delete
 * removes it before the archive.
 */

const SERIES = 'Cloud Layers';
const SERIES_UUID = 'e2e-cloud-layers-series';
const VOLUME_UUID = 'e2e-cloud-layers-volume';
const STUB = 'http://stub.test';
const ROOT = '/mokuro-reader';

function mokuroJson(text: string, volume = 'Vol 1', uuid = VOLUME_UUID): string {
  return JSON.stringify({
    version: '0.2.1',
    title: SERIES,
    title_uuid: SERIES_UUID,
    volume,
    volume_uuid: uuid,
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

interface StubEntry {
  dir: boolean;
  body: string;
  mtime: string;
}

/** A tiny in-memory WebDAV server behind `page.route`. */
class WebDavStub {
  files = new Map<string, StubEntry>();
  log: Array<{ method: string; path: string; destination?: string; body?: string }> = [];

  constructor() {
    this.dir('/');
    this.dir(ROOT);
  }
  dir(path: string) {
    this.files.set(this.norm(path), { dir: true, body: '', mtime: new Date().toUTCString() });
  }
  file(path: string, body: string, mtime = 'Wed, 16 Sep 2026 10:00:00 GMT') {
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
        const body = request.postData() ?? '';
        this.file(path, body, new Date().toUTCString());
        this.log.push({ method, path, body });
        return reply(201);
      }
      case 'DELETE': {
        if (!entry) return reply(404);
        for (const p of [path, ...this.children(path, true)]) this.files.delete(p);
        this.log.push({ method, path });
        return reply(204);
      }
      case 'MOVE': {
        if (!entry) return reply(404);
        const destination = this.norm(new URL(request.headers()['destination']).pathname);
        this.files.set(destination, entry);
        this.files.delete(path);
        this.log.push({ method, path, destination });
        return reply(201);
      }
      default:
        return reply(405);
    }
  };
}

async function seedInstalledVolume(page: Page) {
  await page.goto('/');
  await page.waitForTimeout(800);
  await page.evaluate(
    async ({ SERIES, SERIES_UUID, VOLUME_UUID, mokuro }) => {
      const { db } = await import('/src/lib/catalog/db.ts');
      await db.open();
      await Promise.all([
        db.volumes.clear(),
        db.volume_ocr.clear(),
        db.volume_files.clear(),
        db.volume_ocr_layers.clear()
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
        page_char_counts: [2]
      });
      await db.volume_ocr.put({ volume_uuid: VOLUME_UUID, pages: parsed.pages });
      await db.volume_files.put({
        volume_uuid: VOLUME_UUID,
        files: { '001.png': new File([blob], '001.png', { type: 'image/png' }) }
      });
      window.localStorage.removeItem('sidecar-backfill:edited-volumes');
    },
    { SERIES, SERIES_UUID, VOLUME_UUID, mokuro: mokuroJson('あい') }
  );
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

async function layerRows(page: Page) {
  return page.evaluate(async (uuid) => {
    const { db } = await import('/src/lib/catalog/db.ts');
    const rows = await db.volume_ocr_layers.where('volume_uuid').equals(uuid).toArray();
    return rows.map((r) => ({
      id: r.layer_id,
      kind: r.kind,
      engine: r.engine,
      name: r.name,
      text: r.pages[0]?.blocks[0]?.lines ?? null,
      cloud: r.cloud ? { provider: r.cloud.provider, size: r.cloud.size } : null
    }));
  }, VOLUME_UUID);
}

test.describe('OCR layers in the cloud (stubbed WebDAV)', () => {
  test('lists, pulls, pushes, moves and deletes layer files with the volume', async ({ page }) => {
    const stub = new WebDavStub();
    stub.file(`${ROOT}/${SERIES}/Vol 1.cbz`, 'PK-not-really');
    stub.file(`${ROOT}/${SERIES}/Vol 1.mokuro`, mokuroJson('あい'));
    stub.file(`${ROOT}/${SERIES}/Vol 1.paddle-manga.mokuro`, mokuroJson('えんじん'));
    stub.file(`${ROOT}/${SERIES}/Vol 1.5.cbz`, 'PK-not-really');
    stub.file(`${ROOT}/${SERIES}/Vol 1.5.mokuro`, mokuroJson('てん', 'Vol 1.5', 'other-uuid'));
    stub.file(`${ROOT}/${SERIES}/Vol 2.gcv.mokuro`, mokuroJson('こじ', 'Vol 2', 'orphan-uuid'));
    await page.route(`${STUB}/**`, stub.handle);

    await seedInstalledVolume(page);
    await connectStub(page);

    // PULL: the engine file became a layer of the installed volume — nothing else did.
    await expect
      .poll(async () => (await layerRows(page)).map((r) => r.id), { timeout: 20000 })
      .toEqual(['paddle-manga']);
    const [pulled] = await layerRows(page);
    expect(pulled).toMatchObject({
      kind: 'ocr',
      engine: 'paddle-manga',
      name: 'Paddle Manga',
      text: ['えんじん'],
      cloud: { provider: 'webdav' }
    });
    // The primary row is untouched by the pull.
    expect(
      await page.evaluate(async (uuid) => {
        const { db } = await import('/src/lib/catalog/db.ts');
        return (await db.volume_ocr.get(uuid))!.pages[0].blocks[0].lines;
      }, VOLUME_UUID)
    ).toEqual(['あい']);

    // No phantom volumes: the dotted sibling IS a volume, the orphan and the layer are not.
    await page.evaluate(() => {
      window.location.hash = '#/catalog';
    });
    await page.getByText(SERIES).first().click();
    await expect(page.getByText('Vol 1.5', { exact: true })).toBeVisible({ timeout: 20000 });
    await expect(page.getByText('Vol 1.paddle-manga')).toHaveCount(0);
    await expect(page.getByText('Vol 2.gcv')).toHaveCount(0);
    await expect(page.getByText('Vol 2', { exact: true })).toHaveCount(0);

    // PUSH: edit the layer locally, relist → uploaded under the same name.
    await page.evaluate(async (uuid) => {
      const { persistLayerPageEdit } = await import('/src/lib/reader/edit/layers.ts');
      const { db } = await import('/src/lib/catalog/db.ts');
      const row = (await db.volume_ocr_layers.get([uuid, 'paddle-manga']))!;
      const page0 = structuredClone(row.pages[0]);
      page0.blocks[0].lines = ['なおした'];
      await persistLayerPageEdit(uuid, 'paddle-manga', 0, page0);
    }, VOLUME_UUID);
    await relist(page);
    await expect
      .poll(() => stub.log.filter((l) => l.method === 'PUT').map((l) => l.path), {
        timeout: 20000
      })
      .toContain(`${ROOT}/${SERIES}/Vol 1.paddle-manga.mokuro`);
    const put = stub.log.find(
      (l) => l.method === 'PUT' && l.path === `${ROOT}/${SERIES}/Vol 1.paddle-manga.mokuro`
    )!;
    const putJson = JSON.parse(put.body!);
    expect(putJson.pages[0].blocks[0].lines).toEqual(['なおした']);
    expect(Object.keys(putJson).sort()).toEqual([
      'chars',
      'pages',
      'title',
      'title_uuid',
      'version',
      'volume',
      'volume_uuid'
    ]);
    // Stamped: a second relist pushes nothing more.
    const putsBefore = stub.log.filter((l) => l.method === 'PUT').length;
    await relist(page);
    await page.waitForTimeout(1500);
    expect(stub.log.filter((l) => l.method === 'PUT').length).toBe(putsBefore);

    // RENAME: the layer file MOVES with the volume; the primary is regenerated.
    stub.log.length = 0;
    await page.evaluate(
      async ({ SERIES, uuid }) => {
        const { unifiedCloudManager } = await import('/src/lib/util/sync/unified-cloud-manager.ts');
        await unifiedCloudManager.renameVolume(SERIES, 'Vol 1', SERIES, 'Vol 9', uuid);
      },
      { SERIES, uuid: VOLUME_UUID }
    );
    const moves = stub.log.filter((l) => l.method === 'MOVE');
    expect(moves).toContainEqual({
      method: 'MOVE',
      path: `${ROOT}/${SERIES}/Vol 1.paddle-manga.mokuro`,
      destination: `${ROOT}/${SERIES}/Vol 9.paddle-manga.mokuro`
    });
    expect(stub.log.filter((l) => l.method === 'PUT').map((l) => l.path)).toContain(
      `${ROOT}/${SERIES}/Vol 9.mokuro`
    );
    expect(stub.log.filter((l) => l.method === 'DELETE').map((l) => l.path)).toEqual([
      `${ROOT}/${SERIES}/Vol 1.mokuro`
    ]);
    expect(stub.files.has(`${ROOT}/${SERIES}/Vol 9.paddle-manga.mokuro`)).toBe(true);

    // DELETE: the layer file goes with the volume, before the archive.
    stub.log.length = 0;
    await page.evaluate(
      async ({ SERIES }) => {
        const { unifiedCloudManager } = await import('/src/lib/util/sync/unified-cloud-manager.ts');
        await unifiedCloudManager.deleteManagedVolume(SERIES, 'Vol 9');
      },
      { SERIES }
    );
    const deletes = stub.log.filter((l) => l.method === 'DELETE').map((l) => l.path);
    expect(deletes).toContain(`${ROOT}/${SERIES}/Vol 9.paddle-manga.mokuro`);
    expect(deletes[deletes.length - 1]).toBe(`${ROOT}/${SERIES}/Vol 9.cbz`);
    expect(deletes.indexOf(`${ROOT}/${SERIES}/Vol 9.paddle-manga.mokuro`)).toBeLessThan(
      deletes.indexOf(`${ROOT}/${SERIES}/Vol 9.cbz`)
    );
    // The dotted sibling was never touched.
    expect(stub.files.has(`${ROOT}/${SERIES}/Vol 1.5.mokuro`)).toBe(true);
  });
});
