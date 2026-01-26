/**
 * Standalone scroll performance test using real fixture data.
 *
 * This test loads real manga data from test/fixtures/extracted and persists
 * it in IndexedDB. Data is kept between runs for faster iteration.
 *
 * Run with:
 *   npx playwright test test/browser/scroll-performance-standalone.spec.ts
 *
 * To force re-import of fixture data:
 *   REIMPORT=1 npx playwright test test/browser/scroll-performance-standalone.spec.ts
 */

import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

// ES Module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to fixtures
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'extracted');
const FIXTURES_CBZ_DIR = path.join(__dirname, '..', 'fixtures');

interface FixtureData {
  name: string;
  volume_uuid: string;
  series_uuid: string;
  mokuroData: any;
  imageFiles: { name: string; data: number[] }[];
  cbzPath: string; // Path to CBZ file for uploading
}

/**
 * Load fixture data from disk - prefer existing CBZ files
 */
function loadFixtureData(): FixtureData | null {
  // First check for existing CBZ files in fixtures directory
  const cbzFiles = fs.existsSync(FIXTURES_CBZ_DIR)
    ? fs.readdirSync(FIXTURES_CBZ_DIR).filter((f) => f.endsWith('.cbz'))
    : [];

  if (cbzFiles.length > 0) {
    // Use the largest CBZ file for more realistic performance testing
    const cbzWithSizes = cbzFiles.map((f) => ({
      name: f,
      size: fs.statSync(path.join(FIXTURES_CBZ_DIR, f)).size
    }));
    cbzWithSizes.sort((a, b) => b.size - a.size);

    const cbzPath = path.join(FIXTURES_CBZ_DIR, cbzWithSizes[0].name);
    const name = cbzWithSizes[0].name.replace('.cbz', '');

    console.log(`Using existing CBZ: ${cbzPath}`);
    console.log(`  Size: ${(fs.statSync(cbzPath).size / 1024 / 1024).toFixed(1)}MB`);

    return {
      name,
      volume_uuid: `perf-test-${name.replace(/[^a-zA-Z0-9]/g, '-')}`,
      series_uuid: `perf-series-${name.replace(/[^a-zA-Z0-9]/g, '-')}`,
      mokuroData: {},
      imageFiles: [],
      cbzPath
    };
  }

  // Fallback to extracted fixtures if no CBZ found
  if (!fs.existsSync(FIXTURES_DIR)) {
    console.log('No fixtures directory found at:', FIXTURES_DIR);
    return null;
  }

  const dirs = fs.readdirSync(FIXTURES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());

  if (dirs.length === 0) {
    console.log('No fixture directories found');
    return null;
  }

  // Use the first fixture
  const fixtureDir = path.join(FIXTURES_DIR, dirs[0].name);
  const files = fs.readdirSync(fixtureDir, { recursive: true }) as string[];

  // Find mokuro file
  const mokuroFile = files.find((f) => f.toString().endsWith('.mokuro'));
  if (!mokuroFile) {
    console.log('No .mokuro file found in fixture');
    return null;
  }

  const mokuroPath = path.join(fixtureDir, mokuroFile.toString());
  const mokuroData = JSON.parse(fs.readFileSync(mokuroPath, 'utf-8'));

  // Find image files
  const imageFiles = files
    .filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f.toString()))
    .slice(0, 30) // Limit to 30 images for reasonable test size
    .map((f) => {
      const imgPath = path.join(fixtureDir, f.toString());
      const data = fs.readFileSync(imgPath);
      return {
        name: f.toString(),
        data: Array.from(data)
      };
    });

  if (imageFiles.length === 0) {
    console.log('No image files found in fixture');
    return null;
  }

  // Create stable UUIDs based on fixture name
  const volume_uuid = `perf-test-${dirs[0].name.replace(/[^a-zA-Z0-9]/g, '-')}`;
  const series_uuid = `perf-series-${dirs[0].name.replace(/[^a-zA-Z0-9]/g, '-')}`;

  // Create CBZ file for upload using zip command
  const cbzPath = path.join('/tmp', `${dirs[0].name}.cbz`);
  try {
    // Delete existing if present
    if (fs.existsSync(cbzPath)) {
      fs.unlinkSync(cbzPath);
    }
    // Create CBZ (zip) from fixture directory
    execSync(`cd "${fixtureDir}" && zip -r "${cbzPath}" .`, { stdio: 'pipe' });
    console.log(`Created CBZ: ${cbzPath}`);
  } catch (err) {
    console.error('Failed to create CBZ:', err);
  }

  console.log(`Loaded fixture: ${dirs[0].name}`);
  console.log(`  Pages: ${mokuroData.pages?.length || 0}`);
  console.log(`  Images: ${imageFiles.length}`);
  console.log(
    `  Total size: ${(imageFiles.reduce((sum, f) => sum + f.data.length, 0) / 1024 / 1024).toFixed(1)}MB`
  );

  return {
    name: dirs[0].name,
    volume_uuid,
    series_uuid,
    mokuroData,
    imageFiles,
    cbzPath
  };
}

/**
 * Upload CBZ by clicking the upload button and using file chooser
 */
async function uploadFixtureCBZ(page: Page, cbzPath: string): Promise<void> {
  // Navigate to home page
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);

  const fileName = path.basename(cbzPath);
  const fileSize = (fs.statSync(cbzPath).size / 1024 / 1024).toFixed(1);
  console.log(`Uploading ${fileName} (${fileSize}MB)...`);

  // The upload button is in the navbar - find buttons in the header/nav area
  // It has class "flex h-6 w-6 items-center justify-center" and contains UploadSolid icon
  const navButtons = page.locator(
    'nav button, header button, .navbar button, [class*="flex"] > button'
  );
  const count = await navButtons.count();
  console.log(`Found ${count} nav-area buttons`);

  // Try clicking each button that might be the upload button until we find one that opens a modal
  let foundUpload = false;
  for (let i = 0; i < count && !foundUpload; i++) {
    const btn = navButtons.nth(i);
    const isVisible = await btn.isVisible().catch(() => false);
    if (!isVisible) continue;

    // Click and check if modal appears
    await btn.click();
    await page.waitForTimeout(300);

    // Check if a modal/dialog appeared with upload-related content
    const hasChooseFiles = await page.locator('button:has-text("choose files")').count();
    if (hasChooseFiles > 0) {
      console.log(`Button ${i} opened upload modal`);
      foundUpload = true;

      // Wait for modal and click choose files
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 10000 }),
        page.locator('button:has-text("choose files")').click()
      ]);

      console.log('Setting files...');
      await fileChooser.setFiles(cbzPath);

      // Wait for file to be processed
      await page.waitForTimeout(2000);

      // Click Import button
      console.log('Clicking Import...');
      const importBtn = page.locator('button:has-text("Import")').last();
      await importBtn.click();
    } else {
      // Click elsewhere to close any opened menu
      await page.locator('body').click({ position: { x: 10, y: 10 } });
      await page.waitForTimeout(100);
    }
  }

  if (!foundUpload) {
    console.log('Could not find upload button, trying direct file input approach...');

    // Fallback: create a hidden file input and trigger the app's processFiles
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'file';
      input.id = 'playwright-file-input';
      input.accept = '.cbz,.zip';
      input.style.cssText = 'position:absolute;top:0;left:0;opacity:0;pointer-events:none;';
      document.body.appendChild(input);
    });

    // Set file using Playwright
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null),
      page.locator('#playwright-file-input').click()
    ]);

    if (fileChooser) {
      await fileChooser.setFiles(cbzPath);
    }
  }

  console.log('Waiting for import to complete...');
  await page.waitForTimeout(20000);
}

/**
 * Check if fixture data already exists in IndexedDB
 */
async function checkDataExists(page: Page, volumeUuid: string): Promise<boolean> {
  return await page.evaluate(async (uuid) => {
    return new Promise<boolean>((resolve) => {
      const dbRequest = indexedDB.open('mokuro_v3');

      dbRequest.onerror = () => resolve(false);

      dbRequest.onsuccess = async () => {
        const db = dbRequest.result;

        try {
          const tx = db.transaction('volumes', 'readonly');
          const store = tx.objectStore('volumes');
          const getRequest = store.get(uuid);

          getRequest.onsuccess = () => {
            db.close();
            resolve(!!getRequest.result);
          };
          getRequest.onerror = () => {
            db.close();
            resolve(false);
          };
        } catch {
          db.close();
          resolve(false);
        }
      };
    });
  }, volumeUuid);
}

/**
 * Inject fixture data into IndexedDB (using Dexie v3 schema: mokuro_v3)
 */
async function injectFixtureData(page: Page, fixture: FixtureData): Promise<void> {
  // Limit pages to match available images
  const pages = fixture.mokuroData.pages.slice(0, fixture.imageFiles.length);

  // Create filename-to-imagefile mapping based on page img_path
  // mokuro pages have img_path like "subfolder/image.jpg"
  const filenameMap: { [key: string]: { name: string; data: number[] } } = {};
  for (const img of fixture.imageFiles) {
    // Store by both full path and just filename for flexible matching
    filenameMap[img.name] = img;
    const baseName = img.name.split('/').pop() || img.name;
    filenameMap[baseName] = img;
  }

  // Calculate page_char_counts (cumulative character counts)
  let totalChars = 0;
  const pageCharCounts = pages.map((p: any) => {
    const pageChars =
      p.blocks?.reduce((sum: number, b: any) => sum + (b.lines?.join('').length || 0), 0) || 0;
    totalChars += pageChars;
    return totalChars;
  });

  await page.evaluate(
    async ({ fixture, pages, pageCharCounts, totalChars }) => {
      // Open existing IndexedDB (don't specify version to use existing)
      const dbRequest = indexedDB.open('mokuro_v3');

      await new Promise<void>((resolve, reject) => {
        dbRequest.onerror = () => reject(dbRequest.error);

        dbRequest.onsuccess = async () => {
          const db = dbRequest.result;

          // Create files record with real images
          // Key by img_path from pages for correct matching
          const files: Record<string, File> = {};
          for (const img of fixture.imageFiles) {
            const blob = new Blob([new Uint8Array(img.data)], { type: 'image/webp' });
            // Use the full path as key (matching page img_path)
            files[img.name] = new File([blob], img.name, { type: 'image/webp' });
          }

          // Store volume metadata with correct field names
          const volumeTx = db.transaction('volumes', 'readwrite');
          const volumeStore = volumeTx.objectStore('volumes');
          volumeStore.put({
            volume_uuid: fixture.volume_uuid,
            series_uuid: fixture.series_uuid,
            series_title: fixture.name,
            volume_title: fixture.mokuroData.title || fixture.name,
            mokuro_version: fixture.mokuroData.version || '0.2.0',
            page_count: pages.length,
            character_count: totalChars,
            page_char_counts: pageCharCounts
          });
          await new Promise<void>((res) => {
            volumeTx.oncomplete = () => res();
          });

          // Store OCR data (pages)
          const ocrTx = db.transaction('volume_ocr', 'readwrite');
          const ocrStore = ocrTx.objectStore('volume_ocr');
          ocrStore.put({
            volume_uuid: fixture.volume_uuid,
            pages
          });
          await new Promise<void>((res) => {
            ocrTx.oncomplete = () => res();
          });

          // Store files
          const filesTx = db.transaction('volume_files', 'readwrite');
          const filesStore = filesTx.objectStore('volume_files');
          filesStore.put({
            volume_uuid: fixture.volume_uuid,
            files
          });
          await new Promise<void>((res) => {
            filesTx.oncomplete = () => res();
          });

          db.close();
          resolve();
        };
      });
    },
    {
      fixture: {
        volume_uuid: fixture.volume_uuid,
        series_uuid: fixture.series_uuid,
        name: fixture.name,
        mokuroData: fixture.mokuroData,
        imageFiles: fixture.imageFiles
      },
      pages,
      pageCharCounts,
      totalChars
    }
  );
}

/**
 * Clean up test data (only used with CLEANUP=1 env var)
 */
async function cleanupTestData(page: Page, volumeUuid: string): Promise<void> {
  await page.evaluate(async (uuid) => {
    const dbRequest = indexedDB.open('mokuro_v3');

    await new Promise<void>((resolve) => {
      dbRequest.onsuccess = async () => {
        const db = dbRequest.result;

        try {
          // Delete from all three tables
          const volumeTx = db.transaction('volumes', 'readwrite');
          volumeTx.objectStore('volumes').delete(uuid);
          await new Promise<void>((res) => {
            volumeTx.oncomplete = () => res();
          });

          const ocrTx = db.transaction('volume_ocr', 'readwrite');
          ocrTx.objectStore('volume_ocr').delete(uuid);
          await new Promise<void>((res) => {
            ocrTx.oncomplete = () => res();
          });

          const filesTx = db.transaction('volume_files', 'readwrite');
          filesTx.objectStore('volume_files').delete(uuid);
          await new Promise<void>((res) => {
            filesTx.oncomplete = () => res();
          });
        } catch (e) {
          // Ignore cleanup errors
        }

        db.close();
        resolve();
      };

      dbRequest.onerror = () => resolve();
    });
  }, volumeUuid);
}

interface FrameMetrics {
  frameTimes: number[];
  droppedFrames: number;
  maxTime: number;
  avgTime: number;
}

interface ExtendedFrameMetrics extends FrameMetrics {
  scrollDistance: number;
  framesWhereScrollMoved: number;
}

/**
 * Measure scroll performance using frame-to-frame timing
 * This measures actual frame delivery time, not just JS execution
 */
async function measureScrollPerformance(
  page: Page,
  frames: number = 120
): Promise<ExtendedFrameMetrics> {
  return await page.evaluate(async (frameCount) => {
    return new Promise<ExtendedFrameMetrics>((resolve, reject) => {
      const container = document.querySelector('.continuous-reader') as HTMLElement;
      const content = document.querySelector('.continuous-content') as HTMLElement;
      if (!container || !content) {
        reject(new Error('ContinuousReader not found'));
        return;
      }

      const results: ExtendedFrameMetrics = {
        frameTimes: [],
        droppedFrames: 0,
        maxTime: 0,
        avgTime: 0,
        scrollDistance: 0,
        framesWhereScrollMoved: 0
      };

      let frameIndex = 0;
      let lastFrameTime = performance.now();
      let lastTransformY = 0;

      // Try to get initial Y from transform
      const match = content.style.transform.match(/translateY\(([^)]+)\)/);
      if (match) {
        lastTransformY = parseFloat(match[1]) || 0;
      }

      function runFrame(timestamp: number) {
        // Measure time since last frame (actual frame delivery time)
        const frameTime = timestamp - lastFrameTime;
        lastFrameTime = timestamp;

        // Check if scroll position changed
        const transformMatch = content.style.transform.match(/translateY\(([^)]+)\)/);
        const currentY = transformMatch ? parseFloat(transformMatch[1]) || 0 : 0;
        if (frameIndex > 0 && currentY !== lastTransformY) {
          results.framesWhereScrollMoved++;
          results.scrollDistance += Math.abs(currentY - lastTransformY);
        }
        lastTransformY = currentY;

        // Record (skip first frame - no prior reference)
        if (frameIndex > 0) {
          results.frameTimes.push(frameTime);
          if (frameTime > 16.67) {
            results.droppedFrames++;
          }
          results.maxTime = Math.max(results.maxTime, frameTime);
        }

        // Dispatch wheel event to trigger scroll
        const wheelEvent = new WheelEvent('wheel', {
          deltaY: 100,
          deltaMode: 0,
          bubbles: true,
          cancelable: true,
          clientX: window.innerWidth / 2,
          clientY: window.innerHeight / 2
        });
        window.dispatchEvent(wheelEvent);

        frameIndex++;

        if (frameIndex < frameCount + 1) {
          // +1 because we skip first measurement
          requestAnimationFrame(runFrame);
        } else {
          results.avgTime = results.frameTimes.reduce((a, b) => a + b) / results.frameTimes.length;
          resolve(results);
        }
      }

      requestAnimationFrame(runFrame);
    });
  }, frames);
}

// Load fixture data at module level
const fixtureData = loadFixtureData();

test.describe('Standalone Scroll Performance Test', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120000); // 2 minutes for image loading
  });

  test('should measure scroll performance with real fixture data', async ({ page }) => {
    // Capture browser console output for performance measurements
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[PERF]')) {
        console.log('BROWSER:', text);
      }
    });

    // Skip if no fixtures available
    if (!fixtureData) {
      console.log('No fixture data available. Add manga to test/fixtures/extracted/');
      test.skip();
      return;
    }

    const forceReimport = process.env.REIMPORT === '1';
    const shouldCleanup = process.env.CLEANUP === '1';

    // Navigate to home page first
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Enable continuous scroll mode in settings
    console.log('Enabling continuous scroll mode...');
    await page.evaluate(() => {
      const storedProfiles = localStorage.getItem('profiles');
      const profiles = storedProfiles ? JSON.parse(storedProfiles) : {};

      // Update all profiles to enable continuous scroll
      for (const profileName of Object.keys(profiles)) {
        profiles[profileName].continuousScroll = true;
      }

      // If no profiles, create a default one
      if (Object.keys(profiles).length === 0) {
        profiles['Desktop'] = { continuousScroll: true };
      }

      localStorage.setItem('profiles', JSON.stringify(profiles));
      localStorage.setItem('currentProfile', 'Desktop');
    });

    // Check if any volumes already exist in IndexedDB
    const existingVolumes = await page.evaluate(async () => {
      return new Promise<string[]>((resolve) => {
        const dbRequest = indexedDB.open('mokuro_v3');
        dbRequest.onerror = () => resolve([]);
        dbRequest.onsuccess = () => {
          const db = dbRequest.result;
          try {
            const tx = db.transaction('volumes', 'readonly');
            const store = tx.objectStore('volumes');
            const getAll = store.getAllKeys();
            getAll.onsuccess = () => {
              db.close();
              resolve(getAll.result as string[]);
            };
            getAll.onerror = () => {
              db.close();
              resolve([]);
            };
          } catch {
            db.close();
            resolve([]);
          }
        };
      });
    });

    console.log(`Found ${existingVolumes.length} existing volumes`);

    // If no volumes or force reimport, upload the CBZ
    if (existingVolumes.length === 0 || forceReimport) {
      if (forceReimport && existingVolumes.length > 0) {
        console.log('Force reimport requested, will upload fresh...');
      }

      // Upload CBZ using the app's import flow
      console.log(`Uploading CBZ: ${fixtureData.cbzPath}`);
      const startTime = Date.now();
      await uploadFixtureCBZ(page, fixtureData.cbzPath);
      console.log(`Upload completed in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    } else {
      console.log('Using existing volume data');
    }

    // Reload to pick up the data
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Find the first volume and navigate to it
    console.log('Looking for imported volume...');
    const volumeInfo = await page.evaluate(async () => {
      return new Promise<{ seriesUuid: string; volumeUuid: string } | null>((resolve) => {
        const dbRequest = indexedDB.open('mokuro_v3');
        dbRequest.onerror = () => resolve(null);
        dbRequest.onsuccess = () => {
          const db = dbRequest.result;
          try {
            const tx = db.transaction('volumes', 'readonly');
            const store = tx.objectStore('volumes');
            const getAll = store.getAll();
            getAll.onsuccess = () => {
              db.close();
              const volumes = getAll.result;
              if (volumes.length > 0) {
                resolve({
                  seriesUuid: volumes[0].series_uuid,
                  volumeUuid: volumes[0].volume_uuid
                });
              } else {
                resolve(null);
              }
            };
            getAll.onerror = () => {
              db.close();
              resolve(null);
            };
          } catch {
            db.close();
            resolve(null);
          }
        };
      });
    });

    if (!volumeInfo) {
      console.log('No volume found after import');
      test.skip();
      return;
    }

    console.log(`Found volume: ${volumeInfo.volumeUuid}`);

    // Navigate to the volume using hash router format
    console.log('Navigating to reader...');
    const readerUrl = `/#/reader/${encodeURIComponent(volumeInfo.seriesUuid)}/${encodeURIComponent(volumeInfo.volumeUuid)}`;
    await page.goto(readerUrl);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000); // Wait for images to decode

    // Check if we're in continuous reader mode
    let hasContinuousReader = (await page.locator('.continuous-content').count()) > 0;

    if (!hasContinuousReader) {
      // Try to find settings and enable continuous scroll
      const settingsBtn = page
        .locator('#settings-button, [aria-label*="settings"], button:has-text("Settings")')
        .first();
      if ((await settingsBtn.count()) > 0) {
        await settingsBtn.click();
        await page.waitForTimeout(500);

        // Look for continuous scroll toggle
        const continuousToggle = page
          .locator('input[type="checkbox"], [role="switch"]')
          .filter({
            has: page.locator('text=/continuous|scroll/i')
          })
          .first();

        if ((await continuousToggle.count()) > 0) {
          await continuousToggle.click();
          await page.waitForTimeout(1000);
        }
      }
    }

    hasContinuousReader = (await page.locator('.continuous-content').count()) > 0;

    if (!hasContinuousReader) {
      console.log('Could not enable continuous reader. Current URL:', page.url());
      console.log('Page content preview:', await page.content().then((c) => c.substring(0, 500)));

      // Debug: Check what elements exist
      const bodyClasses = await page.evaluate(() => document.body.className);
      const mainContent = await page.evaluate(() => {
        const main = document.querySelector('main, .reader, [class*="reader"], [class*="Reader"]');
        return main ? main.className : 'No main/reader found';
      });
      const allClasses = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('*'))
          .map((el) => el.className)
          .filter((c) => c && typeof c === 'string' && c.includes('reader'))
          .slice(0, 10);
      });
      console.log('Body classes:', bodyClasses);
      console.log('Main content:', mainContent);
      console.log('Reader-related classes:', allClasses);

      // Check for error messages
      const errorText = await page.evaluate(() => {
        const errors = document.querySelectorAll(
          '[class*="error"], [class*="Error"], .text-red-500'
        );
        return Array.from(errors)
          .map((e) => e.textContent?.trim())
          .filter(Boolean)
          .slice(0, 3);
      });
      console.log('Error messages:', errorText);

      if (shouldCleanup && volumeInfo) {
        await cleanupTestData(page, volumeInfo.volumeUuid);
      }
      test.skip();
      return;
    }

    // Wait for content to render
    await page.waitForTimeout(2000);

    // Debug: Check what we're measuring
    const readerState = await page.evaluate(() => {
      const continuousReader = document.querySelector('.continuous-reader');
      const continuousContent = document.querySelector('.continuous-content');
      const spreads = document.querySelectorAll('.spread-wrapper');
      const images = document.querySelectorAll('.spread-wrapper img');

      return {
        hasContinuousReader: !!continuousReader,
        hasContinuousContent: !!continuousContent,
        spreadCount: spreads.length,
        imageCount: images.length,
        viewportSize: { width: window.innerWidth, height: window.innerHeight },
        contentHeight: continuousContent?.scrollHeight || 0
      };
    });
    console.log('Reader state:', JSON.stringify(readerState, null, 2));

    // Measure scroll performance using Playwright's native wheel simulation
    console.log('Measuring scroll performance...');

    // Start measurement in parallel with scrolling
    const measurementPromise = page.evaluate(async () => {
      return new Promise<{
        frameTimes: number[];
        droppedFrames: number;
        maxTime: number;
        avgTime: number;
        scrollDistance: number;
        framesWhereScrollMoved: number;
      }>((resolve) => {
        const content = document.querySelector('.continuous-content') as HTMLElement;

        const results = {
          frameTimes: [] as number[],
          droppedFrames: 0,
          maxTime: 0,
          avgTime: 0,
          scrollDistance: 0,
          framesWhereScrollMoved: 0
        };

        let frameIndex = 0;
        let lastFrameTime = performance.now();
        let lastTransformY = 0;

        // Parse current transform
        const parseY = () => {
          const style = content?.style.transform || '';
          // panzoom uses matrix() or translate() - check both
          const matrixMatch = style.match(/matrix\([^,]+,[^,]+,[^,]+,[^,]+,[^,]+,\s*([^)]+)\)/);
          const translateMatch = style.match(/translate(?:3d)?\([^,]+,\s*([^,)]+)/);
          if (matrixMatch) return parseFloat(matrixMatch[1]) || 0;
          if (translateMatch) return parseFloat(translateMatch[1]) || 0;
          return 0;
        };

        lastTransformY = parseY();

        function measureFrame(timestamp: number) {
          const frameTime = timestamp - lastFrameTime;
          lastFrameTime = timestamp;

          const currentY = parseY();
          if (frameIndex > 0) {
            results.frameTimes.push(frameTime);
            if (frameTime > 16.67) results.droppedFrames++;
            results.maxTime = Math.max(results.maxTime, frameTime);
            if (currentY !== lastTransformY) {
              results.framesWhereScrollMoved++;
              results.scrollDistance += Math.abs(currentY - lastTransformY);
            }
          }
          lastTransformY = currentY;
          frameIndex++;

          if (frameIndex < 121) {
            requestAnimationFrame(measureFrame);
          } else {
            results.avgTime =
              results.frameTimes.reduce((a, b) => a + b) / results.frameTimes.length;
            resolve(results);
          }
        }

        requestAnimationFrame(measureFrame);
      });
    });

    // Scroll while measurement runs using Playwright wheel
    for (let i = 0; i < 60; i++) {
      await page.mouse.wheel(0, 100);
      await page.waitForTimeout(16); // ~60fps timing
    }

    const metrics = await measurementPromise;

    // Report results
    console.log('\n=== SCROLL PERFORMANCE (120 frames) ===');
    console.log(`Average frame time: ${metrics.avgTime.toFixed(3)}ms`);
    console.log(`Max frame time: ${metrics.maxTime.toFixed(3)}ms`);
    console.log(
      `Dropped frames: ${metrics.droppedFrames} (${((metrics.droppedFrames / 120) * 100).toFixed(1)}%)`
    );
    console.log(`Scroll moved in ${metrics.framesWhereScrollMoved} frames`);
    console.log(`Total scroll distance: ${metrics.scrollDistance.toFixed(1)}px`);

    // Frame time distribution
    const buckets = {
      under5: metrics.frameTimes.filter((t) => t < 5).length,
      under10: metrics.frameTimes.filter((t) => t < 10).length,
      under16: metrics.frameTimes.filter((t) => t < 16.67).length,
      over16: metrics.droppedFrames
    };
    console.log('\nFrame distribution:');
    console.log(`  < 5ms: ${buckets.under5}`);
    console.log(`  < 10ms: ${buckets.under10}`);
    console.log(`  < 16.67ms: ${buckets.under16}`);
    console.log(`  > 16.67ms: ${buckets.over16}`);

    // Worst frames
    const sorted = [...metrics.frameTimes].sort((a, b) => b - a);
    console.log('\nWorst 5 frames:');
    sorted.slice(0, 5).forEach((t, i) => console.log(`  ${i + 1}. ${t.toFixed(2)}ms`));

    // Retrieve performance logs from browser
    const { perfLogs, panCount, transitionCount, wheelCount } = await page.evaluate(() => ({
      perfLogs: (window as any).__perfLogs || [],
      panCount: (window as any).__panCount || 0,
      transitionCount: (window as any).__transitionCount || 0,
      wheelCount: (window as any).__wheelCount || 0
    }));

    console.log(`\nWheel: ${wheelCount}, Pan: ${panCount}, Transitions: ${transitionCount}`);

    if (perfLogs.length > 0) {
      console.log('\n=== PERFORMANCE BREAKDOWN ===');
      // Sort by elapsed time descending
      perfLogs.sort((a: any, b: any) => b.elapsed - a.elapsed);
      perfLogs.slice(0, 20).forEach((log: any) => {
        console.log(`  ${log.label}: ${log.elapsed.toFixed(2)}ms`);
      });
    } else {
      console.log('No performance logs captured');
    }

    // Cleanup only if requested (data persists between runs by default)
    if (shouldCleanup && volumeInfo) {
      console.log('Cleaning up test data...');
      await cleanupTestData(page, volumeInfo.volumeUuid);
    }

    // Assertions
    const droppedPercent = (metrics.droppedFrames / 120) * 100;

    // Performance targets - with pre-rendering, aim for <35ms frame times
    // 35ms = ~2 frames at 60fps, acceptable for occasional transitions
    expect(metrics.maxTime).toBeLessThan(35);
    expect(droppedPercent).toBeLessThan(3); // Less than 3% dropped frames
  });
});
