import { test, expect, type Page } from '@playwright/test';
import { gotoApp } from './helpers/app';

/**
 * #283 — Page Down / Space / Page Up on a page taller (or wider) than the
 * screen scroll it a screenful at a time before turning, in the REAL reader:
 * the scroll position moves first, the page index changes only once the
 * page's far edge is in view. With the setting off the page turns at once.
 *
 * Geometry (1920×1080 viewport): a 1000×2000 page at fit-to-width / fill
 * screen is 1920×3840 — 2760 px taller than the screen. A step keeps 12.5% of
 * the viewport (PAGE_KEY_OVERLAP), so it is 945 px; the third one is clamped
 * to the 870 px left, landing the page's bottom on the screen's.
 */

const SERIES = 'Page Key Series';
const SERIES_UUID = 'e2e-page-key-series';
const VOLUME_UUID = 'e2e-page-key-volume';
const VIEW_H = 1080;
const STEP = VIEW_H * (1 - 0.125); // 945
const TALL = { width: 1000, height: 2000 };
const PAGE_H = (1920 / TALL.width) * TALL.height; // 3840
const OVERFLOW = PAGE_H - VIEW_H; // 2760

type Size = { width: number; height: number };

/** Six pages of `sizes` (one size for all), or one page per listed size. */
async function seedVolume(
  page: Page,
  sizes: Size | Size[],
  settings: Record<string, unknown>,
  volumeSettings: Record<string, unknown> = {}
) {
  await gotoApp(page);
  await page.evaluate(
    async ({ SERIES, SERIES_UUID, VOLUME_UUID, sizes, settings, volumeSettings }) => {
      const { db } = await import('/src/lib/catalog/db.ts');
      await db.open();
      await Promise.all([
        db.volumes.clear(),
        db.volume_ocr.clear(),
        db.volume_files.clear(),
        db.volume_ocr_layers.clear()
      ]);
      const colours = ['#e0f2fe', '#fde68a', '#bbf7d0', '#fecaca', '#ddd6fe', '#fed7aa'];
      const files: Record<string, File> = {};
      const sizeList = Array.isArray(sizes) ? sizes : colours.map(() => sizes);
      const pages = sizeList.map((size, i) => {
        const img_path = `${String(i + 1).padStart(3, '0')}.png`;
        return { colour: colours[i % colours.length], img_path, size };
      });
      for (const p of pages) {
        const { size } = p;
        const canvas = document.createElement('canvas');
        canvas.width = size.width;
        canvas.height = size.height;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = p.colour;
        ctx.fillRect(0, 0, size.width, size.height);
        const blob: Blob = await new Promise((r) => canvas.toBlob((c) => r(c!), 'image/png'));
        files[p.img_path] = new File([blob], p.img_path, { type: 'image/png' });
      }
      await db.volumes.put({
        volume_uuid: VOLUME_UUID,
        series_uuid: SERIES_UUID,
        series_title: SERIES,
        volume_title: 'Vol 1',
        mokuro_version: '0.3.0b',
        page_count: pages.length,
        character_count: 0,
        page_char_counts: pages.map(() => 0),
        // Seeded so the app's boot-time thumbnail pass (1 s after load) finds
        // nothing to do: its row write would reload the open volume's data
        // mid-test, unmounting the pages for a moment.
        thumbnail: files[pages[0].img_path],
        thumbnail_width: pages[0].size.width,
        thumbnail_height: pages[0].size.height
      });
      await db.volume_ocr.put({
        volume_uuid: VOLUME_UUID,
        pages: pages.map((p) => ({
          version: '0.3.0b',
          img_width: p.size.width,
          img_height: p.size.height,
          img_path: p.img_path,
          blocks: []
        }))
      });
      await db.volume_files.put({ volume_uuid: VOLUME_UUID, files });
      const { updateSetting, updateVolumeSetting } = await import('/src/lib/settings/index.ts');
      for (const [key, value] of Object.entries(settings))
        updateSetting(key as never, value as never);
      for (const [key, value] of Object.entries(volumeSettings))
        updateVolumeSetting(VOLUME_UUID, key as never, value);
    },
    { SERIES, SERIES_UUID, VOLUME_UUID, sizes, settings, volumeSettings }
  );
}

async function openReader(page: Page) {
  // The catalog may still be reacting to the freshly seeded rows, and a hash
  // set mid-reaction bounces back — set it until it sticks.
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ SERIES_UUID, VOLUME_UUID }) => {
            const target = `#/reader/${SERIES_UUID}/${VOLUME_UUID}`;
            if (window.location.hash !== target) {
              window.location.hash = target;
              return false;
            }
            return !!document.querySelector('[data-page-index="0"]');
          },
          { SERIES_UUID, VOLUME_UUID }
        ),
      { timeout: 30000, intervals: [100, 200, 400, 800] }
    )
    .toBe(true);
}

async function setSetting(page: Page, key: string, value: unknown) {
  await page.evaluate(
    async ({ key, value }) => {
      const { updateSetting } = await import('/src/lib/settings/index.ts');
      updateSetting(key as never, value as never);
    },
    { key, value }
  );
}

/** Paged mode: the shown page's index and its top edge on screen. */
function pagedState(page: Page) {
  return page.evaluate(() => {
    const all = document.querySelectorAll<HTMLElement>('#manga-panel [data-page-index]');
    const el = all[all.length - 1];
    // Absent for a moment while the page mounts: poll again, never throw.
    if (!el) return null;
    return { index: Number(el.dataset.pageIndex), top: Math.round(el.getBoundingClientRect().top) };
  });
}

/** Continuous modes: the scroll container and the page wrappers' screen rects. */
function stripState(page: Page) {
  return page.evaluate(async (VOLUME_UUID) => {
    const container = document.querySelector<HTMLElement>('.scrollbar-hide')!;
    // container > zoom spacer > zoom wrapper > [lead spacer, ...pages, tail spacer]
    const wrapper = container.firstElementChild!.firstElementChild!;
    const pages = [...wrapper.children].slice(1, -1).map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    });
    const { progress } = await import('/src/lib/settings/index.ts');
    let current = 0;
    progress.subscribe((p: Record<string, number>) => (current = p[VOLUME_UUID] ?? 0))();
    const box = container.getBoundingClientRect();
    return {
      scrollTop: Math.round(container.scrollTop),
      scrollLeft: Math.round(container.scrollLeft),
      box: { top: box.top, bottom: box.bottom, left: box.left, right: box.right },
      pages,
      progress: current
    };
  }, VOLUME_UUID);
}

const near = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;

/**
 * Page `i`'s edges against the scroll container's: 0 = flush, positive top /
 * left = inside the view, positive bottom / right = hidden past the view.
 */
async function edgesOf(page: Page, i: number) {
  const s = await stripState(page);
  const p = s.pages[i];
  return {
    top: Math.round(p.top - s.box.top),
    bottom: Math.round(p.bottom - s.box.bottom),
    left: Math.round(p.left - s.box.left),
    right: Math.round(p.right - s.box.right)
  };
}

/** Paged mode: every shown page's index and top edge, in page order. */
function pagedSpread(page: Page) {
  return page.evaluate(() => {
    const els = [...document.querySelectorAll<HTMLElement>('#manga-panel [data-page-index]')];
    if (els.length === 0) return null;
    return els
      .map((el) => ({
        index: Number(el.dataset.pageIndex),
        top: Math.round(el.getBoundingClientRect().top)
      }))
      .sort((a, b) => a.index - b.index);
  });
}

test.describe('Page keys scroll tall pages before turning (#283)', () => {
  test('paged fit-to-width: scrolls down through the page, then turns; Page Up opens the previous page at its bottom', async ({
    page
  }) => {
    await seedVolume(page, TALL, {
      continuousScroll: false,
      singlePageView: 'single',
      zoomDefault: 'zoomFitToWidth',
      pageKeysScrollFirst: true
    });
    await openReader(page);
    await expect.poll(() => pagedState(page)).toEqual({ index: 0, top: 0 });

    // Three steps down the same page: 945, 945, then the 870 px left.
    for (const top of [-STEP, -2 * STEP, -OVERFLOW]) {
      await page.keyboard.press('PageDown');
      await expect.poll(() => pagedState(page)).toEqual({ index: 0, top });
    }
    // The bottom is in view: Space (the same key) turns to the next page's top.
    await page.keyboard.press('Space');
    await expect.poll(() => pagedState(page)).toEqual({ index: 1, top: 0 });

    // Page Up at the top turns back — onto the previous page's BOTTOM screenful…
    await page.keyboard.press('PageUp');
    await expect.poll(() => pagedState(page)).toEqual({ index: 0, top: -OVERFLOW });
    // …and keeps walking up it.
    await page.keyboard.press('PageUp');
    await expect.poll(() => pagedState(page)).toEqual({ index: 0, top: -(OVERFLOW - STEP) });
  });

  test('paged: a held key chains its steps from the pan target instead of stalling', async ({
    page
  }) => {
    await seedVolume(page, TALL, {
      continuousScroll: false,
      singlePageView: 'single',
      zoomDefault: 'zoomFitToWidth',
      pageKeysScrollFirst: true
    });
    await openReader(page);
    await expect.poll(() => pagedState(page)).toEqual({ index: 0, top: 0 });

    // Auto-repeat: keydowns arrive faster than one glide settles.
    await page.keyboard.down('PageDown');
    for (let i = 0; i < 2; i++) await page.keyboard.down('PageDown');
    await page.keyboard.up('PageDown');
    // Three repeats = three chained steps; no turn yet, no step lost.
    await expect.poll(() => pagedState(page)).toEqual({ index: 0, top: -OVERFLOW });
    await page.keyboard.press('PageDown');
    await expect.poll(() => pagedState(page)).toEqual({ index: 1, top: 0 });

    // Four repeats: the fourth arrives while the glide to the bottom is still
    // running — measured from the TARGET it turns, rather than re-scrolling a
    // half-finished glide (a stall).
    await page.keyboard.down('PageDown');
    for (let i = 0; i < 3; i++) await page.keyboard.down('PageDown');
    await page.keyboard.up('PageDown');
    await expect.poll(() => pagedState(page)).toEqual({ index: 2, top: 0 });
  });

  test('paged: setting off turns the page at once, as before', async ({ page }) => {
    await seedVolume(page, TALL, {
      continuousScroll: false,
      singlePageView: 'single',
      zoomDefault: 'zoomFitToWidth',
      pageKeysScrollFirst: false
    });
    await openReader(page);
    await expect.poll(() => pagedState(page)).toEqual({ index: 0, top: 0 });
    await page.keyboard.press('PageDown');
    await expect.poll(() => pagedState(page)).toEqual({ index: 1, top: 0 });
    await page.keyboard.press('PageUp');
    // The old landing too: the previous page opens at its top.
    await expect.poll(() => pagedState(page)).toEqual({ index: 0, top: 0 });

    // Turning the setting on mid-session takes effect on the next key.
    await setSetting(page, 'pageKeysScrollFirst', true);
    await page.keyboard.press('PageDown');
    await expect.poll(() => pagedState(page)).toEqual({ index: 0, top: -STEP });
  });

  test('paged and continuous with animations disabled (e-ink): every step lands at once', async ({
    page
  }) => {
    await seedVolume(page, TALL, {
      continuousScroll: false,
      singlePageView: 'single',
      zoomDefault: 'zoomFitToWidth',
      disableAnimations: true,
      pageKeysScrollFirst: true
    });
    await openReader(page);
    await expect.poll(() => pagedState(page)).toEqual({ index: 0, top: 0 });
    // No glide: the very next read sees the step's end, no polling needed.
    await page.keyboard.press('PageDown');
    expect(await pagedState(page)).toEqual({ index: 0, top: -STEP });
    await page.keyboard.press('PageUp');
    expect(await pagedState(page)).toEqual({ index: 0, top: 0 });

    await setSetting(page, 'continuousScroll', true);
    await setSetting(page, 'scrollMode', 'vertical');
    await setSetting(page, 'continuousZoomDefault', 'zoomFillScreen');
    await expect
      .poll(async () => {
        const s = await stripState(page);
        return Math.round(s.pages[0].top - s.box.top);
      })
      .toBe(0);
    const start = (await stripState(page)).scrollTop;
    await page.keyboard.press('PageDown');
    expect((await stripState(page)).scrollTop - start).toBe(STEP);
    await setSetting(page, 'disableAnimations', false);
  });

  test('continuous vertical: scrolls a screenful while the page continues, then lands on the next page top', async ({
    page
  }) => {
    await seedVolume(page, TALL, {
      continuousScroll: true,
      scrollMode: 'vertical',
      continuousZoomDefault: 'zoomFillScreen',
      pageDividers: false,
      pageKeysScrollFirst: true
    });
    await openReader(page);
    // Opens with page 0's top at the screen's top.
    await expect
      .poll(async () => {
        const s = await stripState(page);
        return Math.round(s.pages[0].top - s.box.top);
      })
      .toBe(0);
    const start = (await stripState(page)).scrollTop;

    for (const moved of [STEP, 2 * STEP, OVERFLOW]) {
      await page.keyboard.press('PageDown');
      await expect.poll(async () => (await stripState(page)).scrollTop - start).toBe(moved);
    }
    let s = await stripState(page);
    // Still the first page: its bottom sits on the screen's bottom, and no
    // page change was reported (progress is unset until the first one).
    expect(near(s.pages[0].bottom, s.box.bottom)).toBe(true);
    expect([0, 1]).toContain(s.progress);

    // Its bottom is in view: the next key turns, onto page 1's top.
    await page.keyboard.press('PageDown');
    await expect
      .poll(async () => {
        const st = await stripState(page);
        return Math.round(st.pages[1].top - st.box.top);
      })
      .toBe(0);
    await expect.poll(async () => (await stripState(page)).progress).toBe(2);

    // Page Up at a page's top goes back to the previous page's LAST screenful.
    await page.keyboard.press('PageUp');
    await expect
      .poll(async () => {
        const st = await stripState(page);
        return Math.round(st.pages[0].bottom - st.box.bottom);
      })
      .toBe(0);
    s = await stripState(page);
    expect(s.scrollTop - start).toBe(OVERFLOW);
    // …and walks up through it, clamped at its top.
    for (const moved of [OVERFLOW - STEP, OVERFLOW - 2 * STEP, 0]) {
      await page.keyboard.press('PageUp');
      await expect.poll(async () => (await stripState(page)).scrollTop - start).toBe(moved);
    }
  });

  test('continuous vertical: a held key chains its steps and turns without stalling', async ({
    page
  }) => {
    await seedVolume(page, TALL, {
      continuousScroll: true,
      scrollMode: 'vertical',
      continuousZoomDefault: 'zoomFillScreen',
      pageDividers: false,
      pageKeysScrollFirst: true
    });
    await openReader(page);
    await expect
      .poll(async () => {
        const s = await stripState(page);
        return Math.round(s.pages[0].top - s.box.top);
      })
      .toBe(0);
    // Three chained steps, then the turn — all faster than one glide settles.
    await page.keyboard.down('PageDown');
    for (let i = 0; i < 3; i++) await page.keyboard.down('PageDown');
    await page.keyboard.up('PageDown');
    await expect
      .poll(async () => {
        const s = await stripState(page);
        return Math.round(s.pages[1].top - s.box.top);
      })
      .toBe(0);
  });

  test('continuous vertical, mixed heights: a tall page after a short one scrolls, and a short page after a tall one is landed on', async ({
    page
  }) => {
    // Fill-width at 1920 px: P 1536 px, A (webtoon) 11520 px, S 768 px (fits,
    // centred on arrival), T 1536 px. The page nearest the view centre is the
    // WRONG page on both sides of A: P while A's top fills the screen (the
    // key re-aligned A's top — a stall), S while A's bottom does (the key
    // turned past S).
    await seedVolume(
      page,
      [
        { width: 1000, height: 800 },
        { width: 1000, height: 6000 },
        { width: 1000, height: 400 },
        { width: 1000, height: 800 }
      ],
      {
        continuousScroll: true,
        scrollMode: 'vertical',
        continuousZoomDefault: 'zoomFillScreen',
        pageDividers: false,
        pageKeysScrollFirst: true
      }
    );
    await openReader(page);
    const topOf = async (i: number) => {
      const s = await stripState(page);
      return Math.round(s.pages[i].top - s.box.top);
    };
    const bottomOf = async (i: number) => {
      const s = await stripState(page);
      return Math.round(s.pages[i].bottom - s.box.bottom);
    };
    const centreOf = async (i: number) => {
      const s = await stripState(page);
      return Math.round((s.pages[i].top + s.pages[i].bottom) / 2 - (s.box.top + s.box.bottom) / 2);
    };
    await expect.poll(() => topOf(0)).toBe(0);
    const heights = (await stripState(page)).pages.map((p) => Math.round(p.bottom - p.top));
    expect(heights).toEqual([1536, 11520, 768, 1536]);

    // P is 456 px taller than the screen: one clamped step to its bottom…
    await page.keyboard.press('PageDown');
    await expect.poll(() => bottomOf(0)).toBe(0);
    // …then the turn onto A's top.
    await page.keyboard.press('PageDown');
    await expect.poll(() => topOf(1)).toBe(0);

    // The stall: with A's top on the screen's top the key must scroll A.
    await page.keyboard.press('PageDown');
    await expect.poll(() => topOf(1)).toBe(-STEP);

    // Walk A to its bottom: 10440 px hidden = 11 full steps + 45 px.
    const overflowA = 11520 - VIEW_H;
    for (let i = 2; i <= 11; i++) {
      await page.keyboard.press('PageDown');
      await expect.poll(() => topOf(1)).toBe(-i * STEP);
    }
    await page.keyboard.press('PageDown');
    await expect.poll(() => topOf(1)).toBe(-overflowA);

    // A's bottom in view: the next key lands on S (centred), not past it.
    await page.keyboard.press('PageDown');
    await expect.poll(() => centreOf(2)).toBe(0);
    await expect.poll(async () => (await stripState(page)).progress).toBe(3);
    // …and only then on T's top.
    await page.keyboard.press('PageDown');
    await expect.poll(() => topOf(3)).toBe(0);

    // Backward mirrors: T's top → S centred → A's LAST screenful → up A.
    await page.keyboard.press('PageUp');
    await expect.poll(() => centreOf(2)).toBe(0);
    await page.keyboard.press('PageUp');
    await expect.poll(() => bottomOf(1)).toBe(0);
    await page.keyboard.press('PageUp');
    await expect.poll(() => topOf(1)).toBe(-(overflowA - STEP));
  });

  test('continuous vertical: setting off jumps a page at a time, as before', async ({ page }) => {
    await seedVolume(page, TALL, {
      continuousScroll: true,
      scrollMode: 'vertical',
      continuousZoomDefault: 'zoomFillScreen',
      pageDividers: false,
      pageKeysScrollFirst: false
    });
    await openReader(page);
    await expect
      .poll(async () => {
        const s = await stripState(page);
        return Math.round(s.pages[0].top - s.box.top);
      })
      .toBe(0);
    await page.keyboard.press('PageDown');
    await expect
      .poll(async () => {
        const s = await stripState(page);
        return Math.round(s.pages[1].top - s.box.top);
      })
      .toBe(0);
    await expect.poll(async () => (await stripState(page)).progress).toBe(2);
  });

  test('continuous horizontal RTL: scrolls leftward through a wide spread before stepping', async ({
    page
  }) => {
    // 3000×1000 pages fill the 1080 px height: 3240 px wide each.
    await seedVolume(
      page,
      { width: 3000, height: 1000 },
      {
        continuousScroll: true,
        scrollMode: 'horizontal',
        continuousZoomDefault: 'zoomFillScreen',
        pageDividers: false,
        pageKeysScrollFirst: true
      }
    );
    await openReader(page);
    // The cover (page 0) shows alone, centred: 660 px hidden on each side.
    await expect
      .poll(async () => {
        const s = await stripState(page);
        return Math.round(s.pages[0].right - s.box.right);
      })
      .toBe(660);

    // Forward in RTL is LEFTWARD: the cover's left part comes into view.
    await page.keyboard.press('PageDown');
    await expect
      .poll(async () => {
        const s = await stripState(page);
        return Math.round(s.pages[0].left - s.box.left);
      })
      .toBe(0);

    // Its reading end is in view: step to the spread [1, 2] — wider than the
    // screen, so it opens at its reading START (page 1's right edge).
    await page.keyboard.press('PageDown');
    await expect
      .poll(async () => {
        const s = await stripState(page);
        return Math.round(s.pages[1].right - s.box.right);
      })
      .toBe(0);
    const before = (await stripState(page)).scrollLeft;
    await page.keyboard.press('PageDown');
    const width = 1920;
    await expect
      .poll(async () => before - (await stripState(page)).scrollLeft)
      .toBe(width * (1 - 0.125));
    // Page Up walks back to the spread's reading start…
    await page.keyboard.press('PageUp');
    await expect.poll(async () => (await stripState(page)).scrollLeft).toBe(before);
    // …and from there turns back onto the cover — wider than the screen, so
    // it opens at its reading END (its left edge, in RTL), not centred.
    await page.keyboard.press('PageUp');
    await expect.poll(async () => (await edgesOf(page, 0)).left).toBe(0);
  });

  test('continuous horizontal LTR: scrolls rightward through a wide spread; Page Up opens the previous spread at its end', async ({
    page
  }) => {
    await seedVolume(
      page,
      { width: 3000, height: 1000 },
      {
        continuousScroll: true,
        scrollMode: 'horizontal',
        continuousZoomDefault: 'zoomFillScreen',
        pageDividers: false,
        pageKeysScrollFirst: true
      },
      { rightToLeft: false }
    );
    await openReader(page);
    // The cover shows alone, centred: 660 px hidden on each side.
    await expect.poll(async () => (await edgesOf(page, 0)).left).toBe(-660);

    // Forward in LTR is RIGHTWARD: the cover's right part comes into view…
    await page.keyboard.press('PageDown');
    await expect.poll(async () => (await edgesOf(page, 0)).right).toBe(0);
    // …then the spread [1, 2] opens at its reading start (page 1's left edge).
    await page.keyboard.press('PageDown');
    await expect.poll(async () => (await edgesOf(page, 1)).left).toBe(0);
    await expect.poll(async () => (await stripState(page)).progress).toBe(2);
    const before = (await stripState(page)).scrollLeft;
    await page.keyboard.press('PageDown');
    await expect
      .poll(async () => (await stripState(page)).scrollLeft - before)
      .toBe(1920 * (1 - 0.125));

    // Backward: up the spread to its start, then onto the cover at its END.
    await page.keyboard.press('PageUp');
    await expect.poll(async () => (await stripState(page)).scrollLeft).toBe(before);
    await page.keyboard.press('PageUp');
    await expect.poll(async () => (await edgesOf(page, 0)).right).toBe(0);
    // …and walks back along it, clamped at its start.
    await page.keyboard.press('PageUp');
    await expect.poll(async () => (await edgesOf(page, 0)).left).toBe(0);
  });

  test('continuous horizontal: setting off steps a spread at a time, centred, as before', async ({
    page
  }) => {
    await seedVolume(
      page,
      { width: 3000, height: 1000 },
      {
        continuousScroll: true,
        scrollMode: 'horizontal',
        continuousZoomDefault: 'zoomFillScreen',
        pageDividers: false,
        pageKeysScrollFirst: false
      }
    );
    await openReader(page);
    await expect.poll(async () => (await edgesOf(page, 0)).right).toBe(660);
    // The cover's hidden sides are skipped: page 1 opens centred.
    await page.keyboard.press('PageDown');
    await expect.poll(async () => (await edgesOf(page, 1)).right).toBe(660);
    await expect.poll(async () => (await stripState(page)).progress).toBe(2);
    await page.keyboard.press('PageUp');
    await expect.poll(async () => (await edgesOf(page, 0)).right).toBe(660);
  });

  test('continuous horizontal, pages taller than the screen (original size): scrolls down a spread before stepping along the strip', async ({
    page
  }) => {
    // 800×2600 at native size: 1520 px taller than the 1080 px screen. Spreads
    // of two (1600 px) fit the width, so only the vertical axis overflows.
    const overflow = 2600 - VIEW_H;
    await seedVolume(
      page,
      { width: 800, height: 2600 },
      {
        continuousScroll: true,
        scrollMode: 'horizontal',
        continuousZoomDefault: 'zoomOriginal',
        pageDividers: false,
        pageKeysScrollFirst: true
      }
    );
    await openReader(page);
    // The cover opens centred: 760 px hidden above and below. Page Down
    // shows its bottom (one step, clamped) instead of turning.
    await expect.poll(async () => (await edgesOf(page, 0)).bottom).toBe(overflow / 2);
    await page.keyboard.press('PageDown');
    await expect.poll(async () => (await edgesOf(page, 0)).bottom).toBe(0);
    expect([0, 1]).toContain((await stripState(page)).progress);

    // The turn: spread [1, 2] centred along the strip, at its TOP.
    await page.keyboard.press('PageDown');
    await expect.poll(async () => (await edgesOf(page, 1)).top).toBe(0);
    let s = await stripState(page);
    const pairCentre =
      (Math.min(s.pages[1].left, s.pages[2].left) + Math.max(s.pages[1].right, s.pages[2].right)) /
      2;
    expect(near(pairCentre, (s.box.left + s.box.right) / 2)).toBe(true);
    await expect.poll(async () => (await stripState(page)).progress).toBe(2);

    // Down it — a screenful, then the rest — before the next turn.
    await page.keyboard.press('PageDown');
    await expect.poll(async () => (await edgesOf(page, 1)).top).toBe(-STEP);
    await page.keyboard.press('PageDown');
    await expect.poll(async () => (await edgesOf(page, 1)).top).toBe(-overflow);
    expect((await stripState(page)).progress).toBe(2);
    await page.keyboard.press('PageDown');
    await expect.poll(async () => (await edgesOf(page, 3)).top).toBe(0);
    await expect.poll(async () => (await stripState(page)).progress).toBe(4);

    // Backward: the previous spread opens at its BOTTOM, then walks up it.
    await page.keyboard.press('PageUp');
    await expect.poll(async () => (await edgesOf(page, 1)).bottom).toBe(0);
    await expect.poll(async () => (await stripState(page)).progress).toBe(2);
    await page.keyboard.press('PageUp');
    await expect.poll(async () => (await edgesOf(page, 1)).top).toBe(-(overflow - STEP));
    await page.keyboard.press('PageUp');
    await expect.poll(async () => (await edgesOf(page, 1)).top).toBe(0);
    s = await stripState(page);
    expect(s.progress).toBe(2);
  });

  test('continuous horizontal, a page wider AND taller than the screen: read in rows — down, then along back at the top, then turn', async ({
    page
  }) => {
    // 3000×2000 at native size, RTL: 1080 px wider and 920 px taller than
    // the screen, so the lone cover opens centred with 540 px hidden on each
    // side and 460 px above and below.
    await seedVolume(
      page,
      { width: 3000, height: 2000 },
      {
        continuousScroll: true,
        scrollMode: 'horizontal',
        continuousZoomDefault: 'zoomOriginal',
        pageDividers: false,
        pageKeysScrollFirst: true
      }
    );
    await openReader(page);
    await expect
      .poll(async () => {
        const e = await edgesOf(page, 0);
        return [e.right, e.bottom];
      })
      .toEqual([540, 460]);

    // Down first…
    await page.keyboard.press('PageDown');
    await expect
      .poll(async () => {
        const e = await edgesOf(page, 0);
        return [e.right, e.bottom];
      })
      .toEqual([540, 0]);
    // …then along in reading direction (leftward), back at the top…
    await page.keyboard.press('PageDown');
    await expect
      .poll(async () => {
        const e = await edgesOf(page, 0);
        return [e.left, e.top];
      })
      .toEqual([0, 0]);
    // …down that column…
    await page.keyboard.press('PageDown');
    await expect.poll(async () => (await edgesOf(page, 0)).bottom).toBe(0);
    // …and only then the turn: page 1 at its reading start (right) and top.
    await page.keyboard.press('PageDown');
    await expect
      .poll(async () => {
        const e = await edgesOf(page, 1);
        return [e.right, e.top];
      })
      .toEqual([0, 0]);
    await expect.poll(async () => (await stripState(page)).progress).toBe(2);

    // Page Up turns back onto the cover's LAST view: reading end, bottom.
    await page.keyboard.press('PageUp');
    await expect
      .poll(async () => {
        const e = await edgesOf(page, 0);
        return [e.left, e.bottom];
      })
      .toEqual([0, 0]);
    // …and walks it backwards: up, then back along at the bottom.
    await page.keyboard.press('PageUp');
    await expect.poll(async () => (await edgesOf(page, 0)).top).toBe(0);
    await page.keyboard.press('PageUp');
    await expect
      .poll(async () => {
        const e = await edgesOf(page, 0);
        return [e.right, e.bottom];
      })
      .toEqual([0, 0]);
  });

  test('paged dual-page fit-to-width: scrolls down a spread; Page Up opens the previous spread, and the cover, at the bottom', async ({
    page
  }) => {
    // Seven 1000×2000 pages, cover alone: [0] [1 2] [3 4] [5 6]. A spread of
    // two at fit-to-width is 1920×1920 (840 px hidden); the lone cover is
    // 1920×3840, as in single mode.
    await seedVolume(
      page,
      [...Array(7)].map(() => TALL),
      {
        continuousScroll: false,
        singlePageView: 'dual',
        zoomDefault: 'zoomFitToWidth',
        pageKeysScrollFirst: true
      }
    );
    await openReader(page);
    await expect.poll(() => pagedSpread(page)).toEqual([{ index: 0, top: 0 }]);

    for (const top of [-STEP, -2 * STEP, -OVERFLOW]) {
      await page.keyboard.press('PageDown');
      await expect.poll(() => pagedSpread(page)).toEqual([{ index: 0, top }]);
    }
    await page.keyboard.press('PageDown');
    const spread = (i: number, top: number) => [
      { index: i, top },
      { index: i + 1, top }
    ];
    await expect.poll(() => pagedSpread(page)).toEqual(spread(1, 0));
    // 840 px hidden: one clamped step, then the turn.
    await page.keyboard.press('PageDown');
    await expect.poll(() => pagedSpread(page)).toEqual(spread(1, -840));
    await page.keyboard.press('PageDown');
    await expect.poll(() => pagedSpread(page)).toEqual(spread(3, 0));

    // Page Up at a spread's top: the previous SPREAD at its bottom…
    await page.keyboard.press('PageUp');
    await expect.poll(() => pagedSpread(page)).toEqual(spread(1, -840));
    await page.keyboard.press('PageUp');
    await expect.poll(() => pagedSpread(page)).toEqual(spread(1, 0));
    // …and the cover (a one-page step back) at its bottom too.
    await page.keyboard.press('PageUp');
    await expect.poll(() => pagedSpread(page)).toEqual([{ index: 0, top: -OVERFLOW }]);
  });
});
