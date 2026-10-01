/**
 * Automatic OCR upgrades against a REAL mokuro-bunko (>= the release that
 * publishes `mokuro_sha256` in `series.json` and `ocr.sha256` in the volume
 * manifest). The stubbed twin is `ocr-upgrade.spec.ts`; this one proves the
 * seam the stub cannot: bunko hashes the sidecar it STORES (gunzipped for
 * `.mokuro.gz`), the reader hashes the bytes it DOWNLOADED, and the two must
 * agree for the upgrade to fire exactly when the server's OCR changed.
 *
 * Needs a THROWAWAY bunko running on this machine (the test writes files
 * straight into its library, the way bunko's own OCR does: a temp file outside
 * the library, then a rename into place):
 *
 *   E2E_BUNKO_URL      e.g. http://127.0.0.1:5191 (CORS must allow the reader's origin)
 *   E2E_BUNKO_USER     an account of role editor or above (it may overwrite sidecars)
 *   E2E_BUNKO_PW_FILE  file holding that account's password (never on a command line)
 *   E2E_BUNKO_LIBRARY  the server's `<storage>/library` directory on this machine
 *
 * Run the server with OCR off (`--ocr skip`, or `ocr.local_processing: false`):
 * the test is the OCR. Each run creates its own series (`OCR Upgrade <run>`)
 * and removes it at the end. Without the variables every test here is skipped.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  test,
  expect,
  type APIRequestContext,
  type BrowserContext,
  type Page
} from '@playwright/test';

const BUNKO = (process.env.E2E_BUNKO_URL ?? '').replace(/\/$/, '');
const USER = process.env.E2E_BUNKO_USER ?? '';
const PW_FILE = process.env.E2E_BUNKO_PW_FILE ?? '';
const LIBRARY = process.env.E2E_BUNKO_LIBRARY ?? '';
const ENABLED = !!(BUNKO && USER && PW_FILE && LIBRARY);

const RUN = Date.now().toString(36);
const PAGES = ['001.png', '002.png', '003.png'];

// ------------------------------------------------------------------ content

function mokuroJson(series: string, volume: string, volumeUuid: string, texts: string[]): string {
  return JSON.stringify({
    version: '0.2.1',
    title: series,
    title_uuid: `${series}-uuid`,
    volume,
    volume_uuid: volumeUuid,
    pages: PAGES.map((img_path, i) => ({
      version: '0.2.1',
      img_width: 400,
      img_height: 600,
      img_path,
      blocks: [{ box: [250, 50, 310, 250], vertical: true, font_size: 30, lines: [texts[i]] }]
    })),
    chars: texts.join('').length
  });
}

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
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
        z.writestr(name, png(400, 600, (shade + 20 * i) % 256))`,
      path,
      String(shade),
      ...PAGES
    ],
    { encoding: 'utf8' }
  );
}

// ------------------------------------------------------------------ the server's library

class Library {
  readonly series: string;
  readonly dir: string;
  readonly staging: string;

  constructor(series: string) {
    this.series = series;
    this.dir = join(LIBRARY, series);
    // Outside the library (so the watcher never sees a half-written file),
    // same filesystem (so the move into place is a rename).
    this.staging = join(dirname(LIBRARY), `e2e-staging-${RUN}`);
    mkdirSync(this.dir, { recursive: true });
    mkdirSync(this.staging, { recursive: true });
  }

  /** Write `name` beside the archives the way bunko's OCR does: temp file, then rename. */
  place(name: string, bytes: string | Buffer, mtimeSeconds?: number): void {
    const tmp = join(this.staging, `${name}.${Date.now()}.tmp`);
    writeFileSync(tmp, bytes);
    if (mtimeSeconds !== undefined) utimesSync(tmp, mtimeSeconds, mtimeSeconds);
    renameSync(tmp, join(this.dir, name));
  }

  placeCbz(name: string, shade: number): void {
    const tmp = join(this.staging, `${name}.${Date.now()}.tmp.cbz`);
    writeCbz(tmp, shade);
    renameSync(tmp, join(this.dir, name));
  }

  /** The JSON bytes a sidecar holds, read back from disk (gunzipped for `.gz`). */
  sidecarJson(name: string): Buffer {
    const raw = readFileSync(join(this.dir, name));
    return name.endsWith('.gz') ? gunzipSync(raw) : raw;
  }

  files(): string[] {
    return existsSync(this.dir) ? readdirSync(this.dir).sort() : [];
  }

  remove(): void {
    rmSync(this.dir, { recursive: true, force: true });
    rmSync(this.staging, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ HTTP side

interface Seen {
  seq: number;
  method: string;
  path: string;
  status: number;
  scheme: string;
}

/** Every request to the server the page (or one of its workers) made, in order. */
function recordRequests(context: BrowserContext): Seen[] {
  const seen: Seen[] = [];
  context.on('response', async (response) => {
    const request = response.request();
    if (!request.url().startsWith(BUNKO)) return;
    const auth = (await request.allHeaders())['authorization'] ?? '';
    seen.push({
      seq: seen.length,
      method: request.method(),
      path: decodeURIComponent(new URL(request.url()).pathname),
      status: response.status(),
      scheme: auth ? auth.split(' ')[0] : 'none'
    });
  });
  return seen;
}

interface SeriesEntry {
  volume_uuid: string;
  volume_title: string;
  mokuro_size?: number;
  mokuro_modified?: number;
  mokuro_sha256?: string;
}

function basicAuth(password: string): string {
  return 'Basic ' + Buffer.from(`${USER}:${password}`).toString('base64');
}

async function getSeriesFile(
  api: APIRequestContext,
  password: string,
  series: string
): Promise<{ volumes: SeriesEntry[] } | null> {
  const response = await api.get(
    `${BUNKO}/mokuro-reader/${encodeURIComponent(series)}/series.json`,
    {
      headers: { Authorization: basicAuth(password) }
    }
  );
  if (response.status() !== 200) return null;
  return response.json();
}

/** Poll `series.json` until bunko's metadata pass compiled what `ready` wants. */
async function waitForSeriesFile(
  api: APIRequestContext,
  password: string,
  series: string,
  ready: (byTitle: Map<string, SeriesEntry>) => boolean
): Promise<Map<string, SeriesEntry>> {
  let last = new Map<string, SeriesEntry>();
  await expect
    .poll(
      async () => {
        const file = await getSeriesFile(api, password, series);
        last = new Map((file?.volumes ?? []).map((v) => [v.volume_title, v]));
        return ready(last);
      },
      { timeout: 60_000, intervals: [500] }
    )
    .toBe(true);
  return last;
}

// ------------------------------------------------------------------ reader side

async function connect(page: Page, password: string): Promise<void> {
  await page.evaluate(
    async ({ serverUrl, username, password }) => {
      const { providerManager } = await import('/src/lib/util/sync/provider-manager.ts');
      const provider = await providerManager.getOrLoadProvider('webdav');
      await provider.login({ serverUrl, username, password });
      await providerManager.setCurrentProvider(provider);
    },
    { serverUrl: BUNKO, username: USER, password }
  );
}

async function relist(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { unifiedCloudManager } = await import('/src/lib/util/sync/unified-cloud-manager.ts');
    await unifiedCloudManager.fetchAllCloudVolumes();
  });
}

/**
 * List again until `done` holds. bunko serves PROPFIND from a cache refreshed
 * a few seconds (debounced) after the filesystem changes, so the listing can
 * trail a `series.json` GET by that long; the app's next listing is what
 * catches up, and this is that next listing.
 */
async function relistUntil<T>(
  page: Page,
  probe: () => Promise<T>,
  expected: T,
  timeout = 45_000
): Promise<void> {
  await expect
    .poll(
      async () => {
        await relist(page);
        await page.waitForTimeout(1500);
        return probe();
      },
      { timeout, intervals: [1000] }
    )
    .toEqual(expected);
}

async function download(page: Page, path: string): Promise<void> {
  await page.evaluate(async (path) => {
    const { unifiedCloudManager } = await import('/src/lib/util/sync/unified-cloud-manager.ts');
    const { queueVolumesFromCloudFiles } = await import('/src/lib/util/download-queue.ts');
    const files = unifiedCloudManager.getAllCloudVolumes?.() ?? [];
    const file = (files as Array<{ path: string }>).find((f) => f.path === path);
    if (!file) throw new Error(`not listed: ${path}`);
    queueVolumesFromCloudFiles([file as never]);
  }, path);
}

/** Every snackbar message from here on, in order (the "one summary notice" check). */
async function recordNotices(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { snackbarStore } = await import('/src/lib/util/snackbar.ts');
    const w = window as unknown as { __notices: string[] };
    w.__notices = [];
    snackbarStore.subscribe((s) => {
      if (s?.message) w.__notices.push(s.message);
    });
  });
}

async function notices(page: Page): Promise<string[]> {
  return page.evaluate(() => [...(window as unknown as { __notices: string[] }).__notices]);
}

interface Installed {
  uuid: string;
  title: string;
  installed: boolean;
  hash: string | null;
  cloud: unknown;
  edited: string | null;
  updatedOcrHash: string | null;
  chars: number;
  lines: string[];
}

async function installedRows(page: Page, series: string): Promise<Map<string, Installed>> {
  const rows = await page.evaluate(async (series) => {
    const { db } = await import('/src/lib/catalog/db.ts');
    const rows = await db.volumes.where('series_title').equals(series).toArray();
    const out = [];
    for (const r of rows) {
      const ocr = await db.volume_ocr.get(r.volume_uuid);
      const files = await db.volume_files.get(r.volume_uuid);
      out.push({
        uuid: r.volume_uuid,
        title: r.volume_title,
        installed: !!ocr && !!files && !r.metadata_only,
        hash: r.mokuro_sha256 ?? null,
        cloud: r.mokuro_sha256_cloud ?? null,
        edited: r.ocr_edited_at ?? null,
        updatedOcrHash: r.updated_ocr_sha256 ?? null,
        chars: r.character_count,
        lines: (ocr?.pages ?? []).map((p) => p.blocks.map((b) => b.lines.join('')).join('|'))
      });
    }
    return out;
  }, series);
  return new Map(rows.map((r) => [r.title, r]));
}

async function layer(page: Page, uuid: string, layerId: string) {
  return page.evaluate(
    async ({ uuid, layerId }) => {
      const { db } = await import('/src/lib/catalog/db.ts');
      const { getLayerMeta, getLayerPages } = await import('/src/lib/catalog/layer-store.ts');
      const meta = await getLayerMeta(db, uuid, layerId);
      if (!meta) return null;
      const pages = (await getLayerPages(db, uuid, layerId)) ?? [];
      return {
        name: meta.name,
        kind: meta.kind,
        source_sha256: (meta as { source_sha256?: string }).source_sha256 ?? null,
        lines: pages.map((p) => p.blocks.map((b) => b.lines.join('')).join('|'))
      };
    },
    { uuid, layerId }
  );
}

const gets = (seen: Seen[], from: number, re: RegExp) =>
  seen.filter(
    (s) => s.seq >= from && (s.method === 'GET' || s.method === 'HEAD') && re.test(s.path)
  );

// ------------------------------------------------------------------ the test

test.describe('automatic OCR upgrade (real mokuro-bunko)', () => {
  test.skip(!ENABLED, 'needs E2E_BUNKO_URL/USER/PW_FILE/LIBRARY (see header)');
  test.setTimeout(300_000);

  test('bunko hashes what the reader hashes; a server re-OCR upgrades in place, an edit gets a layer, a legacy row gets a baseline', async ({
    page,
    context,
    request
  }) => {
    const password = readFileSync(PW_FILE, 'utf8').trim();
    const SERIES = `OCR Upgrade ${RUN}`;
    const lib = new Library(SERIES);
    const V1 = 'Vol 1';
    const V2 = 'Vol 2';
    const UUID1 = `e2e-up-${RUN}-1`;
    const UUID2 = `e2e-up-${RUN}-2`;
    const v1Old = mokuroJson(SERIES, V1, UUID1, ['いちのいち', 'いちのに', 'いちのさん']);
    const v1New = mokuroJson(SERIES, V1, UUID1, [
      'あたらしいいち',
      'あたらしいに',
      'あたらしいさん'
    ]);
    const v2Old = mokuroJson(SERIES, V2, UUID2, ['にのいち', 'にのに', 'にのさん']);
    const v2New = mokuroJson(SERIES, V2, UUID2, ['にのしんいち', 'にのしんに', 'にのしんさん']);

    const consoleLines: string[] = [];
    let seenRef: Seen[] = [];
    try {
      // ================================================================ (a) bunko compiles the hashes
      lib.place(`${V1}.mokuro`, v1Old);
      lib.place(`${V2}.mokuro.gz`, gzipSync(Buffer.from(v2Old)));
      lib.placeCbz(`${V1}.cbz`, 200);
      lib.placeCbz(`${V2}.cbz`, 120);

      const compiled = await waitForSeriesFile(
        request,
        password,
        SERIES,
        (m) => !!m.get(V1)?.mokuro_sha256 && !!m.get(V2)?.mokuro_sha256
      );
      const published1 = compiled.get(V1)!.mokuro_sha256!;
      const published2 = compiled.get(V2)!.mokuro_sha256!;
      const disk1 = sha256(lib.sidecarJson(`${V1}.mokuro`));
      const disk2 = sha256(lib.sidecarJson(`${V2}.mokuro.gz`));
      console.log(
        '[evidence] (a) series.json vs independent sha256 of the stored JSON bytes:',
        JSON.stringify({
          [V1]: { published: published1, disk: disk1, written: sha256(v1Old) },
          [`${V2} (.gz)`]: { published: published2, disk: disk2, written: sha256(v2Old) }
        })
      );
      expect(published1).toBe(disk1);
      expect(published1).toBe(sha256(v1Old));
      expect(published2).toBe(disk2);
      expect(published2).toBe(sha256(v2Old));
      expect(compiled.get(V1)!.volume_uuid).toBe(UUID1);
      expect(compiled.get(V2)!.volume_uuid).toBe(UUID2);

      // ================================================================ (b) the reader hashes what it downloads
      const seen = recordRequests(context);
      seenRef = seen;
      page.on('console', (message) => {
        const text = message.text();
        if (/ocr-upgrade|series-index|series-open|Cloud OCR Upgrade/i.test(text)) {
          consoleLines.push(`${new Date().toISOString().slice(11, 23)} ${text.slice(0, 300)}`);
        }
      });
      await page.goto('/');
      await page.waitForTimeout(800);
      await page.evaluate(async () => {
        const { updateSetting } = await import('/src/lib/settings/index.ts');
        updateSetting('continuousScroll', false);
        updateSetting('quickActions', true);
        updateSetting('singlePageView', 'single');
      });
      await recordNotices(page);
      await connect(page, password);
      expect(await page.evaluate(() => localStorage.getItem('webdav_token'))).not.toBeNull();
      await relist(page);
      await download(page, `${SERIES}/${V1}.cbz`);
      await download(page, `${SERIES}/${V2}.cbz`);
      await expect
        .poll(
          async () =>
            [...(await installedRows(page, SERIES)).values()].filter((r) => r.installed).length,
          { timeout: 60_000 }
        )
        .toBe(2);
      // Let the post-install hooks (sidecar backfill, series write) settle.
      await page.waitForTimeout(3000);
      await relist(page);
      await page.waitForTimeout(2000);

      let rows = await installedRows(page, SERIES);
      console.log(
        '[evidence] (b) IndexedDB after download:',
        JSON.stringify([...rows.values()].map((r) => ({ ...r, lines: r.lines.length })))
      );
      expect(rows.get(V1)!.uuid).toBe(UUID1);
      expect(rows.get(V2)!.uuid).toBe(UUID2);
      expect(rows.get(V1)!.hash).toBe(published1);
      expect(rows.get(V2)!.hash).toBe(published2);
      // Every request after the token was issued carried it.
      const schemes = new Set(
        seen
          .filter((s) => s.method !== 'OPTIONS' && s.path !== '/login/api/token')
          .map((s) => s.scheme)
      );
      expect([...schemes].filter((s) => s !== 'Basic')).toEqual(['Bearer']);

      // The manifest names the same hash for the same file.
      for (const [title, hash, file] of [
        [V1, published1, `${V1}.mokuro`],
        [V2, published2, `${V2}.mokuro.gz`]
      ] as const) {
        const manifest = await request.get(
          `${BUNKO}/catalog/api/manifest?series=${encodeURIComponent(SERIES)}&volume=${encodeURIComponent(title)}`,
          { headers: { Authorization: basicAuth(password) } }
        );
        expect(manifest.status()).toBe(200);
        const body = await manifest.json();
        console.log(`[evidence] (b) manifest ocr for ${title}:`, JSON.stringify(body.ocr));
        expect(decodeURIComponent(body.ocr.url)).toBe(`/mokuro-reader/${SERIES}/${file}`);
        expect(body.ocr.sha256).toBe(hash);
      }

      // ================================================================ (c) bunko re-OCRs volume 1
      const v2Before = rows.get(V2)!;
      let mark = seen.length;
      let noticeMark = (await notices(page)).length;
      lib.place(`${V1}.mokuro`, v1New);
      const afterC = await waitForSeriesFile(
        request,
        password,
        SERIES,
        (m) => m.get(V1)?.mokuro_sha256 === sha256(v1New)
      );
      expect(afterC.get(V2)!.mokuro_sha256).toBe(published2);
      await relistUntil(page, async () => (await installedRows(page, SERIES)).get(V1)!.lines, [
        'あたらしいいち',
        'あたらしいに',
        'あたらしいさん'
      ]);
      await page.waitForTimeout(2500);
      rows = await installedRows(page, SERIES);
      const c1 = rows.get(V1)!;
      console.log(
        '[evidence] (c) volume 1 after the re-OCR:',
        JSON.stringify({ uuid: c1.uuid, hash: c1.hash, expected: sha256(v1New), chars: c1.chars })
      );
      expect(c1.hash).toBe(sha256(v1New));
      expect(c1.uuid).toBe(UUID1);
      expect(c1.chars).toBe('あたらしいいちあたらしいにあたらしいさん'.length);
      expect([...rows.values()].map((r) => r.uuid).sort()).toEqual([UUID1, UUID2]);
      expect(gets(seen, mark, /\/Vol 1\.cbz$/)).toEqual([]);
      const sidecarGets = gets(seen, mark, /\/Vol 1\.mokuro$/).filter((s) => s.method === 'GET');
      console.log(
        '[evidence] (c) requests after the change:',
        JSON.stringify(seen.slice(mark).map((s) => `${s.method} ${s.path} ${s.status}`))
      );
      expect(sidecarGets.map((s) => s.status)).toEqual([200]);
      const cNotices = (await notices(page)).slice(noticeMark);
      console.log('[evidence] (c) notices:', JSON.stringify(cNotices));
      expect(cNotices).toEqual(['Updated OCR for 1 volume']);
      // Volume 2 untouched.
      expect(rows.get(V2)).toEqual(v2Before);
      // Converged: another listing fetches nothing more.
      await page.waitForTimeout(10_000); // past bunko's PROPFIND refresh
      const converged = seen.length;
      await relist(page);
      await page.waitForTimeout(2000);
      await relist(page);
      await page.waitForTimeout(2000);
      expect(gets(seen, converged, /\/Vol [12]\.mokuro(\.gz)?$/)).toEqual([]);

      // ================================================================ (d) an edited volume keeps its edit
      await page.evaluate(
        ({ series, uuid }) => {
          window.location.hash = `#/reader/${encodeURIComponent(series + '-uuid')}/${uuid}`;
        },
        { series: SERIES, uuid: UUID2 }
      );
      await expect(page.locator('[data-page-index="0"]')).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(500);
      await page.getByLabel('Quick actions menu').click();
      await page.getByLabel('Edit OCR').click();
      await expect(page.locator('[data-edit-toolbar]')).toBeVisible();
      const block = page.locator('.editBlock').first();
      await block.dblclick();
      const line = block.locator('[contenteditable]').first();
      await expect(line).toBeVisible();
      await line.click();
      await page.keyboard.press('Control+A');
      await page.keyboard.type('へんしゅう');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1500);
      await page.evaluate(() => {
        window.location.hash = '#/';
      });
      await page.waitForTimeout(1500);
      rows = await installedRows(page, SERIES);
      const edited = rows.get(V2)!;
      expect(edited.edited).not.toBeNull();
      expect(edited.lines[0]).toBe('へんしゅう');

      // Whatever the reader uploads for an edited volume, it does so now.
      mark = seen.length;
      await relist(page);
      await page.waitForTimeout(4000);
      const editUploads = seen
        .slice(mark)
        .filter((s) => s.method === 'PUT' || s.method === 'DELETE');
      console.log(
        '[evidence] (d) writes after the edit:',
        JSON.stringify(editUploads.map((s) => `${s.method} ${s.path} ${s.status}`)),
        'server files:',
        JSON.stringify(lib.files())
      );
      // The server's primary for volume 2 is whichever bunko itself would read:
      // the plain name over the `.gz`.
      const primary2 = lib.files().includes(`${V2}.mokuro`) ? `${V2}.mokuro` : `${V2}.mokuro.gz`;
      const baseBefore = (await installedRows(page, SERIES)).get(V2)!.hash;

      mark = seen.length;
      noticeMark = (await notices(page)).length;
      lib.place(primary2, primary2.endsWith('.gz') ? gzipSync(Buffer.from(v2New)) : v2New);
      await waitForSeriesFile(
        request,
        password,
        SERIES,
        (m) => m.get(V2)?.mokuro_sha256 === sha256(v2New)
      );
      await relistUntil(
        page,
        async () => (await layer(page, UUID2, 'updated-ocr'))?.lines ?? null,
        ['にのしんいち', 'にのしんに', 'にのしんさん']
      );
      const updated = (await layer(page, UUID2, 'updated-ocr'))!;
      rows = await installedRows(page, SERIES);
      const d2 = rows.get(V2)!;
      console.log(
        '[evidence] (d) volume 2 after the server change:',
        JSON.stringify({
          primary: d2.lines,
          base: d2.hash,
          baseBefore,
          updated_ocr_sha256: d2.updatedOcrHash,
          layer: { name: updated.name, kind: updated.kind, source_sha256: updated.source_sha256 },
          expected: sha256(v2New)
        })
      );
      expect(d2.lines[0]).toBe('へんしゅう');
      expect(d2.hash).toBe(baseBefore);
      expect(d2.updatedOcrHash).toBe(sha256(v2New));
      expect(updated.name).toBe('Updated OCR');
      expect(updated.kind).toBe('ocr');
      expect(updated.source_sha256).toBe(sha256(v2New));
      await page.waitForTimeout(1500);
      const dNotices = (await notices(page)).slice(noticeMark);
      console.log('[evidence] (d) notices:', JSON.stringify(dNotices));
      expect(dNotices).toEqual(['New OCR for 1 edited volume added as the "Updated OCR" layer']);
      expect(gets(seen, mark, /\/Vol 2\.cbz$/)).toEqual([]);

      // Give every writer a chance to push it (a sync and two listings), then
      // look on the server's disk and in the request log.
      await page.evaluate(async () => {
        const { unifiedSyncService } = await import('/src/lib/util/sync/unified-sync-service.ts');
        const { providerManager } = await import('/src/lib/util/sync/provider-manager.ts');
        await unifiedSyncService.syncProvider(providerManager.getActiveProvider()!);
      });
      await relist(page);
      await page.waitForTimeout(4000);
      await relist(page);
      await page.waitForTimeout(2000);
      const layerWrites = seen.filter((s) => /updated-ocr/.test(s.path) && s.method !== 'GET');
      console.log(
        '[evidence] (d) server files:',
        JSON.stringify(lib.files()),
        'writes since the change:',
        JSON.stringify(
          seen
            .slice(mark)
            .filter((s) => !['GET', 'HEAD', 'PROPFIND', 'OPTIONS'].includes(s.method))
            .map((s) => `${s.method} ${s.path} ${s.status}`)
        )
      );
      expect(layerWrites).toEqual([]);
      expect(lib.files().filter((f) => f.includes('updated-ocr'))).toEqual([]);
      // The edit survived the sync too.
      expect((await installedRows(page, SERIES)).get(V2)!.lines[0]).toBe('へんしゅう');

      // ================================================================ (e) a legacy row gets its baseline
      await page.evaluate(async (uuid) => {
        const { db } = await import('/src/lib/catalog/db.ts');
        await db.volumes.update(uuid, { mokuro_sha256: undefined, mokuro_sha256_cloud: undefined });
        const w = window as unknown as { __ocrWrites: string[] };
        w.__ocrWrites = [];
        db.volume_ocr.hook('creating', (key) => {
          if (key === uuid) w.__ocrWrites.push('create');
        });
        db.volume_ocr.hook('updating', (_mods, key) => {
          if (key === uuid) w.__ocrWrites.push('update');
        });
        db.volume_ocr.hook('deleting', (key) => {
          if (key === uuid) w.__ocrWrites.push('delete');
        });
      }, UUID1);
      expect((await installedRows(page, SERIES)).get(V1)!.hash).toBeNull();
      mark = seen.length;
      noticeMark = (await notices(page)).length;
      // The server's file did not change, so a listing refreshes nothing; the
      // series open is the pass that judges it.
      await page.evaluate((series) => {
        window.location.hash = `#/series/${encodeURIComponent(series)}`;
      }, SERIES);
      await expect
        .poll(async () => (await installedRows(page, SERIES)).get(V1)!.hash, { timeout: 30_000 })
        .toBe(sha256(v1New));
      await page.waitForTimeout(2000);
      const e1 = (await installedRows(page, SERIES)).get(V1)!;
      const writes = await page.evaluate(
        () => (window as unknown as { __ocrWrites: string[] }).__ocrWrites
      );
      const eNotices = (await notices(page)).slice(noticeMark);
      console.log(
        '[evidence] (e) legacy baseline:',
        JSON.stringify({
          hash: e1.hash,
          lines: e1.lines,
          volume_ocr_writes: writes,
          sidecar_gets: gets(seen, mark, /\/Vol 1\.mokuro$/).map((s) => `${s.method} ${s.status}`),
          notices: eNotices
        })
      );
      expect(e1.lines).toEqual(['あたらしいいち', 'あたらしいに', 'あたらしいさん']);
      expect(writes).toEqual([]);
      expect(eNotices).toEqual([]);
      expect(gets(seen, mark, /\/Vol 1\.mokuro$/).filter((s) => s.method === 'GET')).toHaveLength(
        1
      );
      expect(gets(seen, mark, /\/Vol 1\.cbz$/)).toEqual([]);
    } catch (error) {
      console.log('[diag] console:', JSON.stringify(consoleLines, null, 1));
      console.log(
        '[diag] requests:',
        JSON.stringify(
          seenRef.map((s) => `${s.seq} ${s.method} ${s.path} ${s.status}`),
          null,
          1
        )
      );
      throw error;
    } finally {
      lib.remove();
    }
  });
});

// ------------------------------------------------------------------ the HTTP cache

test.describe('OCR upgrade vs the browser HTTP cache (real mokuro-bunko)', () => {
  test.skip(!ENABLED, 'needs E2E_BUNKO_URL/USER/PW_FILE/LIBRARY (see header)');
  test.setTimeout(180_000);

  // A sidecar written long ago (here: 30 days) and installed recently is in
  // the browser's HTTP cache. bunko serves `.mokuro`/`.mokuro.gz` with a
  // Last-Modified and no Cache-Control, so the cache may treat that copy as
  // fresh for a tenth of its age (RFC 9111 heuristic freshness: ~3 days).
  // A re-OCR inside that window must still reach the reader.
  test('a re-OCR of a sidecar this browser already fetched is read from the server', async ({
    page,
    context,
    request
  }) => {
    const password = readFileSync(PW_FILE, 'utf8').trim();
    const SERIES = `OCR Cache ${RUN}`;
    const lib = new Library(SERIES);
    const UUID = `e2e-cache-${RUN}`;
    const oldJson = mokuroJson(SERIES, 'Vol 1', UUID, ['ふるいいち', 'ふるいに', 'ふるいさん']);
    const newJson = mokuroJson(SERIES, 'Vol 1', UUID, ['しんいち', 'しんに', 'しんさん']);
    const monthAgo = Math.trunc(Date.now() / 1000) - 30 * 86400;
    try {
      lib.place('Vol 1.mokuro', oldJson, monthAgo);
      lib.placeCbz('Vol 1.cbz', 90);
      await waitForSeriesFile(request, password, SERIES, (m) => !!m.get('Vol 1')?.mokuro_sha256);

      const seen = recordRequests(context);
      await page.goto('/');
      await page.waitForTimeout(800);
      await connect(page, password);
      await relist(page);
      await download(page, `${SERIES}/Vol 1.cbz`);
      await expect
        .poll(async () => (await installedRows(page, SERIES)).get('Vol 1')?.hash ?? null, {
          timeout: 60_000
        })
        .toBe(sha256(oldJson));

      lib.place('Vol 1.mokuro', newJson);
      await waitForSeriesFile(
        request,
        password,
        SERIES,
        (m) => m.get('Vol 1')?.mokuro_sha256 === sha256(newJson)
      );
      const mark = seen.length;
      // The app's own pass first: list until the index refresh reached it.
      await page.waitForTimeout(10_000); // past bunko's PROPFIND refresh
      await relist(page);
      await page.waitForTimeout(5000);
      await relist(page);
      await page.waitForTimeout(5000);
      const afterPass = {
        row: (await installedRows(page, SERIES)).get('Vol 1')!,
        verdicts: await page.evaluate(() => localStorage.getItem('ocr-upgrade:verdicts'))
      };
      console.log(
        '[evidence] (4) after the pass:',
        JSON.stringify({
          hash: afterPass.row.hash,
          attestation: afterPass.row.cloud,
          listed: { size: Buffer.byteLength(newJson) },
          lines: afterPass.row.lines,
          verdicts: afterPass.verdicts,
          expected: sha256(newJson)
        })
      );
      // What the reader's own download path returns for the listed sidecar now.
      const fetched = await page.evaluate(async (path) => {
        const { unifiedCloudManager } = await import('/src/lib/util/sync/unified-cloud-manager.ts');
        const { cacheManager } = await import('/src/lib/util/sync/cache-manager.ts');
        const provider = unifiedCloudManager.getActiveProvider()!;
        const files = (cacheManager.getCache(provider.type)?.getAllFiles() ?? []) as Array<{
          path: string;
          size: number;
        }>;
        const file = files.find((f) => f.path === path)!;
        const blob = await provider.downloadFile(file as never);
        const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
        return {
          listedSize: file.size,
          bytes: blob.size,
          sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
        };
      }, `${SERIES}/Vol 1.mokuro`);
      const onServer = seen
        .slice(mark)
        .filter((s) => /Vol 1\.mokuro$/.test(s.path))
        .map((s) => `${s.method} ${s.status}`);
      console.log(
        '[evidence] (4) sidecar read after the re-OCR:',
        JSON.stringify({
          downloaded: fetched,
          server: { sha256: sha256(newJson), bytes: Buffer.byteLength(newJson) },
          stale: { sha256: sha256(oldJson), bytes: Buffer.byteLength(oldJson) },
          playwrightSaw: onServer
        })
      );
      expect(fetched.sha256).toBe(sha256(newJson));
      expect(afterPass.row.hash).toBe(sha256(newJson));

      await relistUntil(
        page,
        async () => (await installedRows(page, SERIES)).get('Vol 1')?.hash ?? null,
        sha256(newJson)
      );
    } finally {
      lib.remove();
    }
  });
});

// ------------------------------------------------------------------ cross-origin headers

test.describe('bunko endpoints seen from the reader origin (real mokuro-bunko)', () => {
  test.skip(!ENABLED, 'needs E2E_BUNKO_URL/USER/PW_FILE/LIBRARY (see header)');

  test('queue file 304 and the manifest dead-token challenge are readable cross-origin', async ({
    page,
    request
  }) => {
    const password = readFileSync(PW_FILE, 'utf8').trim();
    const lib = new Library(`OCR Headers ${RUN}`);
    try {
      lib.place(
        'Vol 1.mokuro',
        mokuroJson(lib.series, 'Vol 1', `e2e-hdr-${RUN}`, ['あ', 'い', 'う'])
      );
      lib.placeCbz('Vol 1.cbz', 30);
      await waitForSeriesFile(
        request,
        password,
        lib.series,
        (m) => !!m.get('Vol 1')?.mokuro_sha256
      );
      const issued = await request.post(`${BUNKO}/login/api/token`, {
        data: { username: USER, password, label: 'e2e header probe' }
      });
      const bearer = (await issued.json()).token as string;
      await page.goto('/');
      const manifestUrl = `${BUNKO}/catalog/api/manifest?series=${encodeURIComponent(lib.series)}&volume=${encodeURIComponent('Vol 1')}`;
      const live = await page.evaluate(
        async ({ queueUrl, manifestUrl, bearer }) => {
          const auth = { Authorization: `Bearer ${bearer}` };
          const first = await fetch(queueUrl, { cache: 'no-store', headers: auth });
          const etag = first.headers.get('ETag');
          const again = await fetch(queueUrl, {
            cache: 'no-store',
            headers: { ...auth, 'If-None-Match': etag ?? '' }
          });
          const manifest = await fetch(manifestUrl, { cache: 'no-store', headers: auth });
          return {
            queue: { status: first.status, etag, cacheControl: first.headers.get('Cache-Control') },
            revalidated: again.status,
            manifest: {
              status: manifest.status,
              sha256: (await manifest.json()).ocr?.sha256 ?? null
            }
          };
        },
        { queueUrl: `${BUNKO}/mokuro-reader/.mokuro-queue.json`, manifestUrl, bearer }
      );
      await request.delete(`${BUNKO}/login/api/token`, {
        headers: { Authorization: `Bearer ${bearer}` }
      });
      const dead = await page.evaluate(
        async ({ manifestUrl, bearer }) => {
          const response = await fetch(manifestUrl, {
            cache: 'no-store',
            headers: { Authorization: `Bearer ${bearer}` }
          });
          return { status: response.status, challenge: response.headers.get('WWW-Authenticate') };
        },
        { manifestUrl, bearer }
      );
      const published = (await getSeriesFile(request, password, lib.series))!.volumes[0]
        .mokuro_sha256;
      console.log('[evidence] (4) cross-origin:', JSON.stringify({ live, dead, published }));
      expect(live.queue.status).toBe(200);
      expect(live.queue.etag).toBeTruthy();
      expect(live.revalidated).toBe(304);
      expect(live.manifest.status).toBe(200);
      expect(live.manifest.sha256).toBe(published);
      expect(dead.status).toBe(401);
      expect(dead.challenge ?? '').toMatch(/^Bearer/);
    } finally {
      lib.remove();
    }
  });
});

// ------------------------------------------------------------------ the queue file

test.describe('OCR queue file (real mokuro-bunko)', () => {
  test.skip(!ENABLED, 'needs E2E_BUNKO_URL/USER/PW_FILE/LIBRARY (see header)');

  test("the reader's parser accepts bunko's .mokuro-queue.json, pending_volumes included", async ({
    page,
    request
  }) => {
    test.setTimeout(120_000);
    const password = readFileSync(PW_FILE, 'utf8').trim();
    // An archive with no sidecar, UPLOADED (a PUT is what joins a held queue
    // at once; a file dropped on disk waits for the next scan, and a held
    // queue does not scan): queued, and held (no OCR runs on the server).
    const lib = new Library(`OCR Queue ${RUN}`);
    try {
      const token = await request.post(`${BUNKO}/login/api/token`, {
        data: { username: USER, password, label: 'e2e queue probe' }
      });
      expect(token.status()).toBe(200);
      const bearer = (await token.json()).token as string;
      try {
        const cbz = join(lib.staging, 'queued.cbz');
        writeCbz(cbz, 60);
        const put = await request.put(
          `${BUNKO}/mokuro-reader/${encodeURIComponent(lib.series)}/${encodeURIComponent('Queued 01.cbz')}`,
          { headers: { Authorization: `Bearer ${bearer}` }, data: readFileSync(cbz) }
        );
        expect(put.status()).toBe(201);
        let raw: Record<string, unknown> = {};
        await expect
          .poll(
            async () => {
              const response = await request.get(`${BUNKO}/mokuro-reader/.mokuro-queue.json`, {
                headers: { Authorization: `Bearer ${bearer}` }
              });
              if (response.status() !== 200) return `status ${response.status()}`;
              raw = await response.json();
              const volumes = (raw.volumes as Array<{ series: string; volume: string }>) ?? [];
              return volumes.some((v) => v.series === lib.series && v.volume === 'Queued 01')
                ? 'listed'
                : 'not yet';
            },
            { timeout: 60_000, intervals: [1000] }
          )
          .toBe('listed');
        console.log('[evidence] (3) queue file:', JSON.stringify(raw));
        await page.goto('/');
        await page.waitForTimeout(500);
        const parsed = await page.evaluate(async (raw) => {
          const { parseQueueFile } = await import('/src/lib/catalog/server-ocr-queue.ts');
          return parseQueueFile(raw);
        }, raw);
        console.log('[evidence] (3) parseQueueFile:', JSON.stringify(parsed));
        expect(parsed).not.toBeNull();
        expect(parsed!.pending_volumes).toBe(raw.pending_volumes);
        expect(typeof parsed!.pending_volumes).toBe('number');
        const rawVolumes = raw.volumes as Array<{ jobs: unknown[] }>;
        expect(parsed!.volumes).toHaveLength(rawVolumes.length);
        // No job was dropped as malformed.
        expect(parsed!.volumes.map((v) => v.jobs.length)).toEqual(
          rawVolumes.map((v) => v.jobs.length)
        );
        const queued = parsed!.volumes.find(
          (v) => v.series === lib.series && v.volume === 'Queued 01'
        )!;
        expect(queued.path).toBe(
          `/mokuro-reader/${encodeURIComponent(lib.series)}/${encodeURIComponent('Queued 01.cbz')}`
        );
        expect(queued.manifest).toMatch(/^\/catalog\/api\/manifest\?/);
        expect(queued.jobs.map((j) => j.kind)).toContain('ocr');
      } finally {
        // Over WebDAV, not from the disk: a held queue never rescans, so a
        // folder removed out of band stays listed in the queue file.
        await request.delete(`${BUNKO}/mokuro-reader/${encodeURIComponent(lib.series)}/`, {
          headers: { Authorization: `Bearer ${bearer}` }
        });
        await request.delete(`${BUNKO}/login/api/token`, {
          headers: { Authorization: `Bearer ${bearer}` }
        });
      }
    } finally {
      lib.remove();
    }
  });
});
