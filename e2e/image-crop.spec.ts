import { test } from '@playwright/test';
import { gotoApp } from './helpers/app';
import {
  ankiCropFlow,
  coverCropFlow,
  coverCropGesturesFlow,
  enableAnkiCapture,
  recordCanvasBlobs,
  stubAnkiConnect
} from './helpers/crop-flows';
import { importVolume } from './helpers/import-volume';
import { writeSyntheticVolume } from './helpers/synthetic-volume';

/**
 * Both image crops (cropperjs 2's web components behind `ImageCropper.svelte`)
 * in a real browser: the volume editor's cover crop and the Anki card's. The
 * flows and what they check are in `helpers/crop-flows.ts`; `csp.spec.ts` runs
 * the same flows on production builds under each CSP mode.
 *
 * A 4:3 gradient page: wider than 3:4, so the cover's default crop is the 3:4
 * box (not the whole page), and every output pixel says where it came from.
 */
const pageSize = { width: 1200, height: 900, gradient: true };

test('cover crop: default 3:4, clamped drag and resize, rotate and reset, saved thumbnail', async ({
  page
}) => {
  test.setTimeout(180_000);
  const volume = writeSyntheticVolume('CropCover', 2, [0, 0, 128], pageSize);
  await recordCanvasBlobs(page);
  await gotoApp(page);
  await importVolume(page, volume);
  await coverCropFlow(page, volume);
});

test('cover crop: drawing from the margin, every handle, last crop zone, refit, append', async ({
  page
}) => {
  test.setTimeout(180_000);
  const volume = writeSyntheticVolume('CropGestures', 2, [0, 0, 128], pageSize);
  await recordCanvasBlobs(page);
  await gotoApp(page);
  await importVolume(page, volume);
  await coverCropGesturesFlow(page, volume);
});

test('Anki crop: starts on the text box, large handles, preset toggle, clamped drag, the card gets that crop', async ({
  page
}) => {
  test.setTimeout(180_000);
  const volume = writeSyntheticVolume('CropAnki', 2, [0, 0, 128], pageSize);
  const stub = await stubAnkiConnect(page);
  await gotoApp(page);
  await enableAnkiCapture(page);
  await gotoApp(page);
  await importVolume(page, volume);
  await ankiCropFlow(page, volume, stub);
});
