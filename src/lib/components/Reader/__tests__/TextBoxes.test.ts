import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import { get, writable, type Writable } from 'svelte/store';
import TextBoxes from '../TextBoxes.svelte';
import { settings } from '$lib/settings';
import type { Page } from '$lib/types';

vi.mock('$lib/settings', async () => {
  const { writable } = await import('svelte/store');
  return {
    settings: writable({
      fontSize: 'auto',
      boldFont: false,
      displayOCR: true,
      alwaysShowOCR: true,
      textBoxBorders: false,
      textEditable: false,
      ankiConnectSettings: { triggerMethod: 'doubleTap', tags: [], cardMode: 'single' }
    }),
    volumes: writable({})
  };
});

vi.mock('$lib/catalog/db', () => ({
  db: { volumes: { get: vi.fn() } }
}));

vi.mock('$lib/anki-connect', () => ({
  showCropper: vi.fn(),
  openCreateModal: vi.fn(),
  openUpdateModal: vi.fn(),
  expandTextBoxBounds: vi.fn(),
  sendQuickCapture: vi.fn(),
  getLastCardInfo: vi.fn(),
  getCardAgeInMin: vi.fn(),
  extractFieldValues: vi.fn(),
  getModelConfig: vi.fn(),
  blobToBase64: vi.fn()
}));

const settingsStore = settings as unknown as Writable<Record<string, unknown>>;

// Real block from Jujutsukaisen 24 p57: font_size 46 is furigana-inflated;
// true glyphs are ~20-30px
const blockWithCoords = {
  box: [653, 123, 801, 358],
  vertical: true,
  font_size: 46,
  lines_coords: [
    [
      [733, 123],
      [793, 123],
      [793, 298],
      [733, 298]
    ],
    [
      [697, 125],
      [736, 125],
      [741, 358],
      [703, 358]
    ],
    [
      [653, 128],
      [692, 128],
      [692, 325],
      [653, 325]
    ]
  ],
  lines: ['総則追加で言うのは', '結界の出入りを', '可能にしても']
};

function makePage(blocks: unknown[]): Page {
  return {
    version: '0.2.2',
    img_width: 1500,
    img_height: 2200,
    img_path: 'page_001.jpg',
    blocks: blocks as Page['blocks']
  };
}

describe('TextBoxes auto mode with lines_coords', () => {
  it('renders each line as a positioned span sized from its quad', () => {
    const { container } = render(TextBoxes, {
      page: makePage([blockWithCoords]),
      volumeUuid: 'test-uuid'
    });

    const spans = container.querySelectorAll<HTMLElement>('.ocr-line.positionedLine');
    expect(spans).toHaveLength(3);

    // first line: its quad captured a neighbor's ruby ink (60px wide for
    // ~19px glyphs) → wraps at the reference size inside its quad bbox,
    // clipped off the neighboring column's rendered edge (the no-overlap
    // invariant trims the first ~2.7px). The quad origin is carried on
    // data-target-* (not style.left/top) and applied as a transform by
    // positionPerLine after layout — see the continuity guard test below.
    expect(spans[0].classList.contains('wrappedLine')).toBe(true);
    expect(parseFloat(spans[0].dataset.targetLeft!)).toBeCloseTo(82.6, 0);
    expect(spans[0].dataset.targetTop).toBe('0');
    expect(parseFloat(spans[0].style.width)).toBeCloseTo(57.4, 0);
    expect(spans[0].style.height).toBe('175px');
    expect(parseFloat(spans[0].style.fontSize)).toBeCloseTo(28.7, 1);

    // remaining lines: clean columns, no wrapping container
    expect(spans[1].classList.contains('wrappedLine')).toBe(false);
    expect(spans[1].style.width).toBe('');

    for (const span of spans) {
      const size = parseFloat(span.style.fontSize);
      // fitted sizes stay below the inflated block font_size
      expect(size).toBeGreaterThan(10);
      expect(size).toBeLessThan(46);
    }

    // the box keeps its OCR dimensions as the hover/tap target
    const box = container.querySelector<HTMLElement>('.textBox');
    expect(box?.style.width).toBe('148px');
    expect(box?.style.height).toBe('235px');
  });

  // Regression guard for #254: per-line spans must stay in normal flow so DOM
  // text scanners (Yomitan/Migaku) read the block as one continuous run. A
  // per-line `position: absolute` (or inline left/top) re-introduces the hard
  // line break that splits words and truncates the mined sentence. The exact
  // on-quad placement is a transform applied after layout and is verified in
  // the browser, not jsdom (offsetParent is null here, so the action no-ops).
  it('keeps per-line spans in flow with no absolute positioning (#254)', () => {
    const { container } = render(TextBoxes, {
      page: makePage([blockWithCoords]),
      volumeUuid: 'test-uuid'
    });

    const spans = container.querySelectorAll<HTMLElement>('.ocr-line.positionedLine');
    expect(spans.length).toBeGreaterThan(0);

    for (const span of spans) {
      // no inline absolute-positioning styles
      expect(span.style.position).toBe('');
      expect(span.style.left).toBe('');
      expect(span.style.top).toBe('');
      // placement data is carried for the post-layout transform instead
      expect(span.dataset.targetLeft).toBeDefined();
      expect(span.dataset.targetTop).toBeDefined();
    }
  });

  it('falls back to legacy hover-fit auto when lines_coords is absent', () => {
    const { lines_coords: _dropped, ...legacyBlock } = blockWithCoords;
    const { container } = render(TextBoxes, {
      page: makePage([legacyBlock]),
      volumeUuid: 'test-uuid'
    });

    expect(container.querySelectorAll('.ocr-line.positionedLine')).toHaveLength(0);
    expect(container.querySelectorAll('.ocr-line')).toHaveLength(3);

    const box = container.querySelector<HTMLElement>('.textBox');
    expect(box?.style.fontSize).toBe('46px');
    expect(box?.classList.contains('perLine')).toBe(false);
    // legacy auto expands the box 10% and fixes its dimensions as fit target
    expect(parseFloat(box!.style.width)).toBeCloseTo(148 * 1.1, 1);
  });

  it('original mode renders the raw block font_size without per-line layout', () => {
    settingsStore.update((s) => ({ ...s, fontSize: 'original' }));
    try {
      const { container } = render(TextBoxes, {
        page: makePage([blockWithCoords]),
        volumeUuid: 'test-uuid'
      });
      expect(container.querySelectorAll('.ocr-line.positionedLine')).toHaveLength(0);
      expect(container.querySelectorAll('.ocr-line')).toHaveLength(3);
      const box = container.querySelector<HTMLElement>('.textBox');
      expect(box?.style.fontSize).toBe('46px');
      // faithful original mode: unsized, overflow-visible box
      expect(box?.style.width).toBe('');
    } finally {
      settingsStore.update((s) => ({ ...s, fontSize: 'auto' }));
      expect(get(settingsStore)).toBeTruthy();
    }
  });
});
