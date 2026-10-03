import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Peak memory while importing 20 picked image-only archives (#285): main-thread
 * JS heap (CDP Performance.getMetrics) and the summed RSS of this browser's
 * renderer processes, which hold the page AND its workers. Run on the base and
 * on the branch; the branch must not be higher. Opt-in: IMPORT_MEMORY=1.
 *
 * `performance.measureUserAgentSpecificMemory()` needs cross-origin isolation,
 * which the app does not have — the result records `crossOriginIsolated` to show it.
 */

const ARCHIVES = 20;
const PAGES = 30;

test.skip(!process.env.IMPORT_MEMORY, 'memory measurement: run with IMPORT_MEMORY=1');

function buildArchives(): string[] {
  const root = mkdtempSync(join(tmpdir(), 'import-memory-'));
  const pages = join(root, 'pages');
  mkdirSync(pages);
  for (let i = 1; i <= PAGES; i++) {
    execFileSync('magick', [
      '-size',
      '1200x1700',
      'plasma:fractal',
      '-quality',
      '92',
      join(pages, `${String(i).padStart(3, '0')}.jpg`)
    ]);
  }
  const files = readdirSync(pages).map((f) => join(pages, f));
  return Array.from({ length: ARCHIVES }, (_, i) => {
    const cbz = join(root, `Memtest v${String(i + 1).padStart(2, '0')}.cbz`);
    execFileSync('zip', ['-q', '-0', '-j', cbz, ...files]);
    return cbz;
  });
}

/**
 * Summed RSS (bytes) of this test browser's renderer processes. The browser is
 * found by its own `--user-data-dir`, never by the shared
 * `playwright_chromiumdev_profile` prefix: every other Playwright Chromium on
 * the machine (other worktrees, other agents) carries that prefix too, and
 * summing their renderers swamps the number.
 */
function rendererRss(userDataDir: string): number {
  const procs = execFileSync('ps', ['-eo', 'pid=,ppid=,rss=,args='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: +m[1], ppid: +m[2], rss: +m[3], args: m[4] }));
  const tree = new Set(
    procs
      .filter((p) => p.args.includes(userDataDir) && !p.args.includes('--type='))
      .map((p) => p.pid)
  );
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of procs) {
      if (!tree.has(p.pid) && tree.has(p.ppid)) {
        tree.add(p.pid);
        grew = true;
      }
    }
  }
  return procs
    .filter((p) => tree.has(p.pid) && p.args.includes('--type=renderer'))
    .reduce((sum, p) => sum + p.rss * 1024, 0);
}

test('peak memory while importing 20 picked image-only archives', async ({
  page,
  context
}, testInfo) => {
  test.setTimeout(15 * 60_000);
  const archives = buildArchives();

  await page.goto('/');
  // The navbar's upload icon (stats, progress tracker, settings, upload).
  await page.locator('nav div.md\\:order-2 > button').nth(3).click();
  const chooser = page.waitForEvent('filechooser');
  await page.locator('dialog button', { hasText: 'choose files' }).click();
  await (await chooser).setFiles(archives);

  const browserCdp = await context.browser()!.newBrowserCDPSession();
  const { arguments: commandLine } = await browserCdp.send('Browser.getBrowserCommandLine');
  const userDataDir = commandLine.find((a) => a.startsWith('--user-data-dir='));
  expect(userDataDir, 'this browser’s own profile directory').toBeTruthy();
  const baseline = rendererRss(userDataDir!);
  expect(baseline, 'found this browser’s renderer processes').toBeGreaterThan(0);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const samples: { t: number; heap: number; rss: number }[] = [];
  let sampling = true;
  const t0 = Date.now();
  const sampler = (async () => {
    while (sampling) {
      const { metrics } = await cdp.send('Performance.getMetrics');
      samples.push({
        t: Date.now() - t0,
        heap: metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0,
        rss: rendererRss(userDataDir!)
      });
      await new Promise((r) => setTimeout(r, 100));
    }
  })();

  await page.locator('dialog button', { hasText: /^\s*Import\s*$/ }).click();
  // Approve image-only confirmations as they appear: the base's prompt per
  // archive ("Image-Only Import") or the branch's review.
  const approve = page
    .locator(
      'dialog:has-text("Image-Only Import") button, [data-testid="image-only-review"] button'
    )
    .filter({ hasText: /^\s*Import\s*$/ });
  const deadline = Date.now() + 12 * 60_000;
  let saved = 0;
  while (saved < ARCHIVES && Date.now() < deadline) {
    if (
      await approve
        .first()
        .isVisible()
        .catch(() => false)
    )
      await approve
        .first()
        .click()
        .catch(() => {});
    saved = await page.evaluate(async () =>
      (await import('/src/lib/catalog/db.ts')).db.volumes.count()
    );
    await page.waitForTimeout(200);
  }
  sampling = false;
  await sampler;
  expect(saved).toBe(ARCHIVES);

  const result = {
    label: process.env.IMPORT_MEMORY_LABEL ?? 'unlabelled',
    crossOriginIsolated: await page.evaluate(() => self.crossOriginIsolated),
    baselineRendererRssMB: +(baseline / 2 ** 20).toFixed(1),
    peakRendererRssMB: +(Math.max(...samples.map((s) => s.rss)) / 2 ** 20).toFixed(1),
    peakJsHeapMB: +(Math.max(...samples.map((s) => s.heap)) / 2 ** 20).toFixed(1),
    durationS: +((samples.at(-1)?.t ?? 0) / 1000).toFixed(1),
    samples: samples.length
  };
  writeFileSync(testInfo.outputPath('import-memory.json'), JSON.stringify(result, null, 2));
  console.log('[import-memory]', JSON.stringify(result));
});
