import { expect, type Page } from '@playwright/test';
import { gradientAt, type SyntheticVolume } from './synthetic-volume';

/**
 * The two image crops a user can reach — the volume editor's cover crop and the
 * Anki card modal's — driven through the real UI. Only the UI, IndexedDB and
 * routed requests are used, so they run on the dev server and on a production
 * build alike (`csp.spec.ts` runs them under each CSP mode).
 *
 * Expected numbers are cropperjs 1.6.2's for the same crop: they were measured
 * against that release in Chromium before it was replaced (the crop maths and
 * the reasoning are in `src/lib/util/crop-geometry.ts`).
 */

type Rgb = [number, number, number];

interface CanvasBlob {
  width: number;
  height: number;
  type: string | undefined;
  quality: number | undefined;
  /** Top-left, top-right, bottom-left, bottom-right pixels, read off the canvas (lossless). */
  corners: [Rgb, Rgb, Rgb, Rgb] | null;
}

/**
 * Record every `canvas.toBlob()`: the canvas size, the format asked for and its
 * corner pixels. Must run before the page loads (an init script, over CDP, so
 * outside every page policy).
 */
export async function recordCanvasBlobs(page: Page) {
  await page.addInitScript(() => {
    const blobs: unknown[] = [];
    (window as unknown as { __e2eCanvasBlobs: unknown[] }).__e2eCanvasBlobs = blobs;
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (
      this: HTMLCanvasElement,
      callback: BlobCallback,
      type?: string,
      quality?: number
    ) {
      let corners = null;
      try {
        const context = this.getContext('2d');
        if (context && this.width > 0 && this.height > 0) {
          const at = (x: number, y: number) =>
            Array.from(context.getImageData(x, y, 1, 1).data).slice(0, 3);
          const right = this.width - 1;
          const bottom = this.height - 1;
          corners = [at(0, 0), at(right, 0), at(0, bottom), at(right, bottom)];
        }
      } catch {
        // not a 2D canvas
      }
      blobs.push({ width: this.width, height: this.height, type, quality, corners });
      return toBlob.call(this, callback, type, quality);
    };
  });
}

async function canvasBlobs(page: Page): Promise<CanvasBlob[]> {
  return page.evaluate(
    () => (window as unknown as { __e2eCanvasBlobs?: CanvasBlob[] }).__e2eCanvasBlobs ?? []
  );
}

/** The cover crops so far: the picker's JPEGs at 0.9 (the stitch is 0.95, thumbnails WebP). */
async function coverOutputs(page: Page) {
  return (await canvasBlobs(page)).filter((b) => b.type === 'image/jpeg' && b.quality === 0.9);
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The open cropper, in its own frame's CSS pixels: the frame size, the image's
 * rectangle as displayed (transform included) and the selection's.
 */
async function cropperGeometry(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('cropper-canvas');
    const image = canvas?.querySelector('cropper-image');
    const selection = canvas?.querySelector('cropper-selection') as
      (HTMLElement & Rect) | null | undefined;
    if (!canvas || !image || !selection) return null;
    const frame = canvas.getBoundingClientRect();
    const shown = image.getBoundingClientRect();
    return {
      frame: { width: canvas.clientWidth, height: canvas.clientHeight },
      image: {
        x: shown.x - frame.x,
        y: shown.y - frame.y,
        width: shown.width,
        height: shown.height
      },
      selection: {
        x: selection.x,
        y: selection.y,
        width: selection.width,
        height: selection.height
      },
      shadeHidden: canvas.querySelector('cropper-shade')?.hasAttribute('hidden') ?? true,
      // The elements style themselves from their shadow roots; under an enforced
      // policy that only works through constructed (adopted) stylesheets.
      canvasOverflow: getComputedStyle(canvas).overflow,
      adoptedSheets: canvas.shadowRoot?.adoptedStyleSheets.length ?? 0,
      shadowStyleElements: canvas.shadowRoot?.querySelectorAll('style').length ?? 0
    };
  });
}

/** Wait for the cropper to show its image and a selection, and return its geometry. */
async function placedCropper(page: Page) {
  try {
    await expect
      .poll(async () => (await cropperGeometry(page))?.selection.width ?? 0, { timeout: 20_000 })
      .toBeGreaterThan(0);
  } catch (error) {
    // What the cropper had to go on: its frame, and the image inside it.
    const state = await page.evaluate(() =>
      Array.from(document.querySelectorAll('cropper-canvas'), (canvas) => {
        const image = canvas.querySelector('cropper-image') as
          (HTMLElement & { $image?: HTMLImageElement }) | null;
        return {
          frame: [canvas.clientWidth, canvas.clientHeight],
          src: image?.getAttribute('src')?.slice(0, 40),
          complete: image?.$image?.complete,
          natural: [image?.$image?.naturalWidth, image?.$image?.naturalHeight]
        };
      })
    );
    throw new Error(`the cropper never placed its selection: ${JSON.stringify(state)}`, {
      cause: error
    });
  }
  const geometry = (await cropperGeometry(page))!;
  expect(geometry.canvasOverflow, 'the cropper canvas is styled from its shadow root').toBe(
    'hidden'
  );
  expect(geometry.adoptedSheets).toBeGreaterThan(0);
  expect(geometry.shadowStyleElements).toBe(0);
  return geometry;
}

/** A selection rectangle in image pixels, given where the image is displayed. */
function inImagePixels(selection: Rect, image: Rect, naturalWidth: number): Rect {
  const scale = image.width / naturalWidth;
  return {
    x: (selection.x - image.x) / scale,
    y: (selection.y - image.y) / scale,
    width: selection.width / scale,
    height: selection.height / scale
  };
}

function expectRectClose(actual: Rect, expected: Rect, tolerance: number, what: string) {
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs(actual[key] - expected[key]), `${what}: ${key} ${actual[key]}`).toBeLessThan(
      tolerance
    );
  }
}

/** Drag the centre of `selector` (inside the open cropper) by (dx, dy). */
async function drag(page: Page, selector: string, dx: number, dy: number) {
  const box = (await page.locator(`cropper-canvas ${selector}`).first().boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}

async function volumeThumbnailSize(page: Page, uuid: string) {
  return page.evaluate(
    (volumeUuid) =>
      new Promise<{ width?: number; height?: number }>((resolve) => {
        const open = indexedDB.open('mokuro_v3');
        open.onerror = () => resolve({});
        open.onsuccess = () => {
          const get = open.result.transaction('volumes').objectStore('volumes').get(volumeUuid);
          get.onsuccess = () =>
            resolve({ width: get.result?.thumbnail_width, height: get.result?.thumbnail_height });
          get.onerror = () => resolve({});
        };
      }),
    uuid
  );
}

/** generateThumbnail's fit into 250×350 (thumbnails.ts), never upscaled. */
function thumbnailFor(width: number, height: number) {
  const scale = Math.min(250 / width, 350 / height, 1);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/**
 * The cover crop, four times over, on a `gradient` volume wider than 3:4:
 *
 *   1. the default crop is full height at 3:4, centred, and confirms to exactly
 *      that part of the page, at natural size, as a JPEG at 0.9;
 *   2. the selection dragged far past the right edge stops at it (v1 `viewMode: 1`);
 *   3. a corner dragged far past the top-left stops at the image's corner, and the
 *      output drops the fraction (937.5 px wide → 937, as cropperjs 1 did);
 *   4. "Rotate 90°" turns clockwise, refits, and keeps the selection on the turned
 *      image; "Reset" undoes it.
 *
 * Each confirm saves the cover; the stored thumbnail is checked for its size.
 */
export async function coverCropFlow(page: Page, volume: SyntheticVolume) {
  const { width: W, height: H } = volume;
  const blue = volume.colour[2];
  expect(W / H, 'the flow needs a page wider than 3:4').toBeGreaterThan(3 / 4);
  const cropWidth = H * 0.75;
  const centredX = (W - cropWidth) / 2;

  await page.evaluate((id) => (window.location.hash = `#/series/${id}`), volume.seriesUuid);
  // The volume list's rows carry the edit button (the grid's cards do not).
  const editButton = page.locator('[title="Edit volume"]').first();
  await expect(page.getByRole('button', { name: 'List', exact: true })).toBeVisible({
    timeout: 30_000
  });
  if (!(await editButton.isVisible())) {
    await page.getByRole('button', { name: 'List', exact: true }).click();
  }
  await expect(editButton).toBeVisible();
  const editor = page.locator('dialog', { hasText: 'Edit Volume' });

  async function openCropper() {
    if (!(await editor.isVisible())) {
      await editButton.click();
      await expect(editor).toBeVisible();
    }
    await editor.getByRole('button', { name: 'Change', exact: true }).click();
    const picker = page.locator('dialog.cover-picker-modal');
    await picker.getByRole('button', { name: 'Crop Page' }).click();
    await expect(picker.getByRole('heading', { name: 'Crop Cover' })).toBeVisible();
    return { picker, geometry: await placedCropper(page) };
  }

  async function confirm(picker: ReturnType<typeof page.locator>) {
    const before = (await coverOutputs(page)).length;
    await picker.getByRole('button', { name: 'Use Cropped Image' }).click();
    await expect.poll(async () => (await coverOutputs(page)).length).toBe(before + 1);
    await expect(picker).toBeHidden();
    return (await coverOutputs(page))[before];
  }

  async function expectOutput(
    output: CanvasBlob,
    width: number,
    height: number,
    /** The page pixel the output's top-left pixel is. */
    origin: [number, number],
    /** Maps an output pixel to the page pixel it shows. */
    pageAt: (x: number, y: number) => [number, number] = (x, y) => [origin[0] + x, origin[1] + y]
  ) {
    expect(output.width, 'output width').toBe(width);
    expect(output.height, 'output height').toBe(height);
    const where = [
      pageAt(0, 0),
      pageAt(width - 1, 0),
      pageAt(0, height - 1),
      pageAt(width - 1, height - 1)
    ];
    expect(output.corners).toEqual(where.map(([x, y]) => gradientAt(x, y, W, H, blue)));
    const thumbnail = thumbnailFor(width, height);
    await expect
      .poll(() => volumeThumbnailSize(page, volume.volumeUuid), {
        message: 'the saved thumbnail is the crop, fitted to 250×350'
      })
      .toEqual(thumbnail);
  }

  // 1. The default crop.
  let { picker, geometry } = await openCropper();
  expect(geometry.shadeHidden, 'the shade darkens outside the selection').toBe(false);
  expectRectClose(
    inImagePixels(geometry.selection, geometry.image, W),
    { x: centredX, y: 0, width: cropWidth, height: H },
    0.5,
    'default crop'
  );
  let output = await confirm(picker);
  await expectOutput(output, Math.floor(cropWidth), H, [Math.floor(centredX), 0]);

  // 2. Dragged past the right edge: stops there, same size.
  ({ picker, geometry } = await openCropper());
  await drag(page, 'cropper-handle[action="move"]', geometry.frame.width, 0);
  geometry = (await cropperGeometry(page))!;
  expectRectClose(
    inImagePixels(geometry.selection, geometry.image, W),
    { x: W - cropWidth, y: 0, width: cropWidth, height: H },
    0.5,
    'moved crop'
  );
  output = await confirm(picker);
  await expectOutput(output, Math.floor(cropWidth), H, [Math.floor(W - cropWidth), 0]);

  // 3. The top-left corner dragged past the image's: stops at it.
  ({ picker, geometry } = await openCropper());
  await drag(
    page,
    'cropper-handle[action="nw-resize"]',
    -geometry.frame.width,
    -geometry.frame.height
  );
  geometry = (await cropperGeometry(page))!;
  const resized = inImagePixels(geometry.selection, geometry.image, W);
  expectRectClose(
    resized,
    { x: 0, y: 0, width: centredX + cropWidth, height: H },
    0.5,
    'resized crop'
  );
  output = await confirm(picker);
  await expectOutput(output, Math.floor(centredX + cropWidth), H, [0, 0]);

  // 4. Rotate and reset.
  ({ picker, geometry } = await openCropper());
  const unturned = geometry;
  await picker.getByRole('button', { name: 'Rotate 90°' }).click();
  await expect
    .poll(async () => {
      const { width, height } = (await cropperGeometry(page))!.image;
      return width > height;
    })
    .toBe(H > W);
  geometry = (await cropperGeometry(page))!;
  // Turned and refitted: H wide, W tall, inside the frame.
  expect(Math.abs(geometry.image.width / geometry.image.height - H / W)).toBeLessThan(0.01);
  expect(geometry.image.height).toBeLessThanOrEqual(geometry.frame.height + 0.5);
  // The selection stayed on the turned image.
  const sel = geometry.selection;
  const img = geometry.image;
  expect(sel.x).toBeGreaterThanOrEqual(img.x - 0.01);
  expect(sel.y).toBeGreaterThanOrEqual(img.y - 0.01);
  expect(sel.x + sel.width).toBeLessThanOrEqual(img.x + img.width + 0.01);
  expect(sel.y + sel.height).toBeLessThanOrEqual(img.y + img.height + 0.01);

  await picker.getByRole('button', { name: 'Reset' }).click();
  geometry = (await cropperGeometry(page))!;
  expectRectClose(geometry.image, unturned.image, 0.5, 'image after reset');
  expectRectClose(geometry.selection, unturned.selection, 0.5, 'selection after reset');

  // A 3:4 crop of a 4:3 page turned a quarter is exactly the turned page: the
  // whole of it, H×W. Clockwise: the output's top-left is the page's bottom-left.
  await picker.getByRole('button', { name: 'Rotate 90°' }).click();
  if (Math.abs(W / H - 4 / 3) < 1e-9) {
    geometry = (await cropperGeometry(page))!;
    expectRectClose(geometry.selection, geometry.image, 0.5, 'turned crop');
    output = await confirm(picker);
    await expectOutput(output, H, W, [0, H - 1], (x, y) => [y, H - 1 - x]);
  } else {
    await confirm(picker);
  }
}

/** The AnkiConnect requests a flow made, by action. */
export interface AnkiStub {
  actions: string[];
  notes: { fields: Record<string, string>; picture?: { data: string; fields: string[] }[] }[];
}

/**
 * Answer AnkiConnect on its default loopback address: one note type, `Basic`
 * (Front, Picture), one deck, and every `addNote` recorded.
 */
export async function stubAnkiConnect(page: Page): Promise<AnkiStub> {
  const stub: AnkiStub = { actions: [], notes: [] };
  await page.route('http://127.0.0.1:8765/**', async (route) => {
    const request = route.request();
    const headers = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'POST, OPTIONS'
    };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const { action, params } = JSON.parse(request.postData() ?? '{}');
    stub.actions.push(action);
    const results: Record<string, unknown> = {
      version: 6,
      deckNames: ['Default'],
      modelNames: ['Basic'],
      modelFieldNames: ['Front', 'Picture'],
      requestPermission: { permission: 'granted', version: 6 }
    };
    let result = results[action] ?? null;
    if (action === 'addNote') {
      stub.notes.push(params.note);
      result = 1700000000000 + stub.notes.length;
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers,
      body: JSON.stringify({ result, error: null })
    });
  });
  return stub;
}

/**
 * Turn AnkiConnect on in the current profile — create mode, the text box preset
 * on, double-tap to capture — with `Basic`'s Front ← {selection}, Picture ← {image}.
 * Takes effect at the next load.
 */
export async function enableAnkiCapture(page: Page) {
  await page.evaluate(() => {
    const profiles = JSON.parse(localStorage.getItem('profiles') ?? '{}');
    const current = localStorage.getItem('currentProfile') ?? 'Desktop';
    profiles[current] = {
      ...profiles[current],
      ankiConnectSettings: {
        ...profiles[current]?.ankiConnectSettings,
        enabled: true,
        selectedModel: 'Basic',
        cardMode: 'create',
        triggerMethod: 'both',
        cropImage: true,
        quickCapture: false,
        createModelConfigs: {
          Basic: {
            modelName: 'Basic',
            deckName: 'Default',
            fieldMappings: [
              { fieldName: 'Front', template: '{selection}' },
              { fieldName: 'Picture', template: '{image}' }
            ]
          }
        }
      }
    };
    localStorage.setItem('profiles', JSON.stringify(profiles));
  });
}

/** Width, height and four corner pixels of a base64 JPEG, decoded by the browser. */
async function decodeJpeg(page: Page, base64: string) {
  return page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    // A few pixels in from each corner: JPEG blocks blur the outermost ones.
    const at = (x: number, y: number) =>
      Array.from(context.getImageData(x, y, 1, 1).data).slice(0, 3);
    const w = bitmap.width;
    const h = bitmap.height;
    return {
      width: w,
      height: h,
      inset: 4,
      corners: [at(4, 4), at(w - 5, 4), at(4, h - 5), at(w - 5, h - 5)] as Rgb[]
    };
  }, base64);
}

/**
 * The Anki card crop, from a double-tap on the page's text box: the crop starts
 * on the text box (padded by `expandTextBoxBounds`), a drag far to the right
 * stops at the image's edge, and the card's picture is exactly that crop.
 * Needs `stubAnkiConnect` and `enableAnkiCapture` (and a reload) first.
 */
export async function ankiCropFlow(page: Page, volume: SyntheticVolume, stub: AnkiStub) {
  const { width: W, height: H } = volume;
  const blue = volume.colour[2];
  // expandTextBoxBounds([260, 120, 340, 420]): 5% of the width, 2% of the height.
  const padX = W * 0.05;
  const padY = H * 0.02;
  const textBox = {
    x: Math.max(0, 260 - padX),
    y: Math.max(0, 120 - padY),
    width: Math.min(W, 340 + padX) - Math.max(0, 260 - padX),
    height: Math.min(H, 420 + padY) - Math.max(0, 120 - padY)
  };

  await page.evaluate(
    ([series, vol]) => (window.location.hash = `#/reader/${series}/${vol}`),
    [volume.seriesUuid, volume.volumeUuid]
  );
  const textBoxEl = page.locator('.textBox').first();
  await expect(textBoxEl).toContainText(volume.text, { timeout: 30_000 });
  // The capture takes the page's image from its `.pageImage` layer
  // (`pageImageUrlFrom`); until that layer has its image, the walk up from the
  // text box ends on the shell's own background instead (app.html).
  await expect
    .poll(
      () =>
        textBoxEl.evaluate((box) => {
          for (let el = box.parentElement; el; el = el.parentElement) {
            const layer = el.querySelector(':scope > .pageImage, :scope > .pageArt > .pageImage');
            if (layer) return getComputedStyle(layer).backgroundImage;
          }
          return 'no page image layer';
        }),
      { timeout: 30_000, message: 'the page image is on its layer' }
    )
    .toMatch(/^url\("blob:/);
  await textBoxEl.dispatchEvent('dblclick');

  const modal = page.locator('dialog', { hasText: 'Create Card' });
  await expect(modal).toBeVisible({ timeout: 20_000 });
  let geometry = await placedCropper(page);
  expectRectClose(
    inImagePixels(geometry.selection, geometry.image, W),
    textBox,
    0.5,
    'Anki crop starts on the text box'
  );

  // The wheel over the crop is the page's (the modal body scrolls), and moves
  // nothing in the crop: cropperjs 2's canvas would cancel it to zoom.
  const wheel = await page.evaluate(
    () =>
      new Promise<{ cancelled: boolean }>((resolve) => {
        const canvas = document.querySelector('cropper-canvas')!;
        const rect = canvas.getBoundingClientRect();
        const event = new WheelEvent('wheel', {
          deltaY: 120,
          clientX: rect.x + rect.width / 2,
          clientY: rect.y + rect.height / 2,
          bubbles: true,
          cancelable: true,
          composed: true
        });
        canvas.querySelector('cropper-image')!.dispatchEvent(event);
        resolve({ cancelled: event.defaultPrevented });
      })
  );
  expect(wheel.cancelled, 'the wheel over the crop is left to the page').toBe(false);
  expectRectClose((await cropperGeometry(page))!.image, geometry.image, 0.01, 'image after wheel');

  await drag(page, 'cropper-handle[action="move"]', geometry.frame.width, 0);
  geometry = (await cropperGeometry(page))!;
  const moved = { ...textBox, x: W - textBox.width };
  expectRectClose(
    inImagePixels(geometry.selection, geometry.image, W),
    moved,
    0.5,
    'Anki crop dragged to the edge'
  );

  await modal.getByRole('button', { name: 'Create Card' }).click();
  await expect.poll(() => stub.notes.length, { timeout: 20_000 }).toBe(1);
  const picture = stub.notes[0].picture?.[0];
  expect(picture?.fields).toEqual(['Picture']);
  const jpeg = await decodeJpeg(page, picture!.data);
  // cropperjs 1's getData(true): corners rounded.
  const x = Math.round(moved.x);
  const y = Math.round(moved.y);
  const width = Math.round(moved.x + moved.width) - x;
  const height = Math.round(moved.y + moved.height) - y;
  expect({ width: jpeg.width, height: jpeg.height }).toEqual({ width, height });
  const i = jpeg.inset;
  const expected = [
    [x + i, y + i],
    [x + width - 1 - i, y + i],
    [x + i, y + height - 1 - i],
    [x + width - 1 - i, y + height - 1 - i]
  ].map(([px, py]) => gradientAt(px, py, W, H, blue));
  jpeg.corners.forEach((rgb, corner) =>
    rgb.forEach((channel, c) =>
      expect(Math.abs(channel - expected[corner][c]), `JPEG corner ${corner}`).toBeLessThan(6)
    )
  );
  await expect(modal).toBeHidden();
}
