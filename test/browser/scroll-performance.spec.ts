/**
 * Real browser scroll performance test using Playwright.
 *
 * This test runs in a real browser and measures actual scroll performance
 * including rendering, layout, and all browser overhead.
 *
 * Prerequisites:
 * - Build the app: npm run build
 * - Have at least one manga imported in IndexedDB
 *
 * Run with:
 *   npx playwright test test/browser/scroll-performance.spec.ts
 */

import { test, expect, Page } from '@playwright/test';

interface FrameMetrics {
  frameTimes: number[];
  droppedFrames: number;
  maxTime: number;
  avgTime: number;
}

/**
 * Inject scroll performance measurement script into the page
 */
async function measureScrollPerformance(
  page: Page,
  scrollFrames: number = 120
): Promise<FrameMetrics> {
  return await page.evaluate(async (frames) => {
    return new Promise<FrameMetrics>((resolve) => {
      const panzoomEl = document.querySelector('.continuous-content') as HTMLElement & {
        __panzoom?: any;
      };
      if (!panzoomEl) {
        throw new Error(
          'ContinuousReader not found - make sure a manga is open in continuous scroll mode'
        );
      }

      // Get panzoom instance - it's attached by the panzoom library
      const pz = panzoomEl.__panzoom;
      if (!pz) {
        throw new Error('Panzoom not initialized');
      }

      const results: FrameMetrics = {
        frameTimes: [],
        droppedFrames: 0,
        maxTime: 0,
        avgTime: 0
      };

      let frameIndex = 0;
      const startY = pz.getTransform().y;
      const scrollPerFrame = 50; // pixels per frame

      function runFrame() {
        const frameStart = performance.now();

        // Simulate scroll by moving panzoom
        const { x } = pz.getTransform();
        const newY = startY - frameIndex * scrollPerFrame;
        pz.moveTo(x, newY);

        // Force layout/paint
        void document.body.offsetHeight;

        const frameTime = performance.now() - frameStart;
        results.frameTimes.push(frameTime);

        if (frameTime > 16.67) {
          results.droppedFrames++;
        }

        results.maxTime = Math.max(results.maxTime, frameTime);
        frameIndex++;

        if (frameIndex < frames) {
          requestAnimationFrame(runFrame);
        } else {
          // Calculate final results
          results.avgTime = results.frameTimes.reduce((a, b) => a + b) / results.frameTimes.length;

          // Reset position
          pz.moveTo(x, startY);

          resolve(results);
        }
      }

      requestAnimationFrame(runFrame);
    });
  }, scrollFrames);
}

/**
 * Get list of available volumes from the catalog
 */
async function getAvailableVolumes(page: Page): Promise<string[]> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // Wait for catalog to load
  await page.waitForTimeout(1000);

  // Get all volume links
  const volumeLinks = await page.locator('a[href*="/"]').filter({ hasText: /.+/ }).all();
  const hrefs: string[] = [];

  for (const link of volumeLinks) {
    const href = await link.getAttribute('href');
    if (href && href.includes('/') && !href.startsWith('http') && href !== '/') {
      hrefs.push(href);
    }
  }

  return hrefs;
}

test.describe('Real Browser Scroll Performance', () => {
  test.beforeEach(async ({ page }) => {
    // Increase timeout for this test
    test.setTimeout(60000);
  });

  test('should measure scroll performance in continuous reader', async ({ page }) => {
    // Navigate to home page
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Wait for catalog to potentially load
    await page.waitForTimeout(2000);

    // Check if there are any volumes
    const content = await page.content();
    const hasVolumes =
      content.includes('volume_uuid') ||
      (await page.locator('.volume-card, .manga-card, [data-volume]').count()) > 0;

    if (!hasVolumes) {
      console.log('No volumes found in catalog. Skipping scroll test.');
      console.log('To run this test, import a manga first.');
      test.skip();
      return;
    }

    // Try to find and click on a volume
    const volumeLink = page.locator('a').filter({ hasText: /.+/ }).first();
    if ((await volumeLink.count()) === 0) {
      console.log('No clickable volumes found');
      test.skip();
      return;
    }

    await volumeLink.click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Look for a "Read" or volume entry link
    const readLink = page
      .locator('a')
      .filter({ hasText: /read|volume|chapter/i })
      .first();
    if ((await readLink.count()) > 0) {
      await readLink.click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1000);
    }

    // Check if we're in the reader (look for continuous-content)
    const hasContinuousReader = (await page.locator('.continuous-content').count()) > 0;

    if (!hasContinuousReader) {
      // Try to enable continuous scroll mode if there's a settings toggle
      const settingsButton = page
        .locator('button, [role="button"]')
        .filter({ hasText: /settings|gear/i });
      if ((await settingsButton.count()) > 0) {
        await settingsButton.first().click();
        await page.waitForTimeout(500);

        const continuousToggle = page
          .locator('input, button, [role="switch"]')
          .filter({ hasText: /continuous|scroll/i });
        if ((await continuousToggle.count()) > 0) {
          await continuousToggle.first().click();
          await page.waitForTimeout(1000);
        }
      }
    }

    // Final check for continuous reader
    const finalCheck = await page.locator('.continuous-content').count();
    if (finalCheck === 0) {
      console.log('Could not navigate to continuous reader mode');
      console.log('Current URL:', page.url());
      test.skip();
      return;
    }

    // Wait for images to load
    await page.waitForTimeout(2000);

    // Measure scroll performance
    console.log('\nMeasuring scroll performance...');
    const metrics = await measureScrollPerformance(page, 120);

    console.log('\n=== SCROLL PERFORMANCE RESULTS ===');
    console.log(`Total frames: 120`);
    console.log(`Average frame time: ${metrics.avgTime.toFixed(3)}ms`);
    console.log(`Max frame time: ${metrics.maxTime.toFixed(3)}ms`);
    console.log(
      `Dropped frames (>16.67ms): ${metrics.droppedFrames} (${((metrics.droppedFrames / 120) * 100).toFixed(1)}%)`
    );

    // Show distribution
    const under5ms = metrics.frameTimes.filter((t) => t < 5).length;
    const under10ms = metrics.frameTimes.filter((t) => t < 10).length;
    const under16ms = metrics.frameTimes.filter((t) => t < 16.67).length;
    console.log(`\nFrame time distribution:`);
    console.log(`  < 5ms: ${under5ms} frames`);
    console.log(`  < 10ms: ${under10ms} frames`);
    console.log(`  < 16.67ms: ${under16ms} frames`);
    console.log(`  > 16.67ms: ${metrics.droppedFrames} frames`);

    // Show worst frames
    const sortedTimes = [...metrics.frameTimes].sort((a, b) => b - a);
    console.log(`\nWorst 5 frame times:`);
    sortedTimes.slice(0, 5).forEach((t, i) => {
      console.log(`  ${i + 1}. ${t.toFixed(2)}ms`);
    });

    // Assertions
    // Allow up to 10% dropped frames as a starting point
    const droppedFramePercent = (metrics.droppedFrames / 120) * 100;
    expect(droppedFramePercent).toBeLessThan(10);

    // Max frame time shouldn't exceed 100ms (severe stutter)
    expect(metrics.maxTime).toBeLessThan(100);
  });

  test('should profile individual operations during scroll', async ({ page }) => {
    // Navigate to a manga reader
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Navigate to reader (simplified - assumes direct URL works)
    // In a real scenario, you'd navigate through the UI
    const hasContinuousReader = (await page.locator('.continuous-content').count()) > 0;

    if (!hasContinuousReader) {
      console.log('Not on continuous reader page, skipping profiling test');
      test.skip();
      return;
    }

    // Profile individual operations
    const profile = await page.evaluate(() => {
      const panzoomEl = document.querySelector('.continuous-content') as HTMLElement & {
        __panzoom?: any;
      };
      if (!panzoomEl?.__panzoom) {
        throw new Error('Panzoom not found');
      }

      const pz = panzoomEl.__panzoom;
      const profiles = {
        getTransform: [] as number[],
        moveTo: [] as number[],
        domQuery: [] as number[],
        forceLayout: [] as number[]
      };

      const { x, y } = pz.getTransform();

      for (let i = 0; i < 100; i++) {
        // Profile getTransform
        let t0 = performance.now();
        pz.getTransform();
        profiles.getTransform.push(performance.now() - t0);

        // Profile moveTo
        t0 = performance.now();
        pz.moveTo(x, y - i);
        profiles.moveTo.push(performance.now() - t0);

        // Profile DOM query
        t0 = performance.now();
        document.querySelectorAll('.spread-wrapper');
        profiles.domQuery.push(performance.now() - t0);

        // Profile forced layout
        t0 = performance.now();
        void document.body.offsetHeight;
        profiles.forceLayout.push(performance.now() - t0);
      }

      // Restore position
      pz.moveTo(x, y);

      // Calculate stats
      const stats = (arr: number[]) => ({
        avg: arr.reduce((a, b) => a + b) / arr.length,
        max: Math.max(...arr)
      });

      return {
        getTransform: stats(profiles.getTransform),
        moveTo: stats(profiles.moveTo),
        domQuery: stats(profiles.domQuery),
        forceLayout: stats(profiles.forceLayout)
      };
    });

    console.log('\n=== OPERATION PROFILING (100 samples) ===');
    console.log(
      `getTransform: avg=${profile.getTransform.avg.toFixed(3)}ms, max=${profile.getTransform.max.toFixed(3)}ms`
    );
    console.log(
      `moveTo:       avg=${profile.moveTo.avg.toFixed(3)}ms, max=${profile.moveTo.max.toFixed(3)}ms`
    );
    console.log(
      `DOM query:    avg=${profile.domQuery.avg.toFixed(3)}ms, max=${profile.domQuery.max.toFixed(3)}ms`
    );
    console.log(
      `forceLayout:  avg=${profile.forceLayout.avg.toFixed(3)}ms, max=${profile.forceLayout.max.toFixed(3)}ms`
    );

    // These should all be fast
    expect(profile.getTransform.max).toBeLessThan(5);
    expect(profile.moveTo.max).toBeLessThan(10);
  });
});

test.describe('Direct Reader URL Test', () => {
  test('measure scroll on specific volume URL', async ({ page }) => {
    // This test requires knowing a specific volume URL
    // You can run it with a specific URL like:
    // VOLUME_URL="/manga-name/volume-1" npx playwright test

    const volumeUrl = process.env.VOLUME_URL;

    if (!volumeUrl) {
      console.log('No VOLUME_URL provided. Set VOLUME_URL env var to test a specific volume.');
      console.log('Example: VOLUME_URL="/manga/volume" npx playwright test');
      test.skip();
      return;
    }

    await page.goto(volumeUrl);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000); // Wait for images to decode

    const hasContinuousReader = (await page.locator('.continuous-content').count()) > 0;
    if (!hasContinuousReader) {
      console.log('Continuous reader not found at URL:', volumeUrl);
      test.skip();
      return;
    }

    const metrics = await measureScrollPerformance(page, 180); // 3 seconds

    console.log('\n=== SCROLL PERFORMANCE (180 frames) ===');
    console.log(`Average: ${metrics.avgTime.toFixed(3)}ms`);
    console.log(`Max: ${metrics.maxTime.toFixed(3)}ms`);
    console.log(
      `Dropped: ${metrics.droppedFrames} (${((metrics.droppedFrames / 180) * 100).toFixed(1)}%)`
    );

    // Store results globally for CI reporting
    const droppedPercent = (metrics.droppedFrames / 180) * 100;

    if (droppedPercent > 5) {
      console.log('\n*** WARNING: Significant frame drops detected! ***');
    }

    expect(droppedPercent).toBeLessThan(15);
  });
});
