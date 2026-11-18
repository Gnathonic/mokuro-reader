import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { flushSync } from 'svelte';

vi.mock('#lib/catalog/db.js', () => ({ db: {} }));

import QuickActions from '#lib/components/Reader/QuickActions.svelte';
import RowsHarness from './RowsHarness.svelte';
import { allActions } from '#lib/keys/registry.js';
import {
  menuEligible,
  quickMenuItems,
  type MenuGlyphContext,
  type QuickMenuState
} from '#lib/keys/quick-menu.js';
import {
  defaultMenuGlyphContext,
  menuGlyphContext,
  provideMenuGlyphContext
} from '#lib/keys/menu-glyph-context.js';
import { get } from 'svelte/store';

/**
 * Owner review of #55: "the icons you see are not the icons you get. Badges
 * don't render in the editor." For every action that can be on the quick
 * menu, in every book the menu draws differently for, the settings row must
 * draw exactly the glyph the menu button draws: the same icon (same SVG), the
 * same badge.
 */

afterEach(() => {
  cleanup();
  provideMenuGlyphContext(null);
});

const ACTIONS = new Map(allActions().map((a) => [a.id, a]));
const ELIGIBLE = allActions().filter(menuEligible);

const CONTEXTS: MenuGlyphContext[] = [
  { forward: 'left', hasSecondPage: true },
  { forward: 'right', hasSecondPage: false },
  { forward: 'down', hasSecondPage: false }
];

/** What a glyph element draws: its icon, its badge, and the icon's actual SVG paths. */
function drawn(el: Element | null) {
  expect(el).not.toBeNull();
  const svg = el!.querySelector('svg');
  return {
    icon: el!.getAttribute('data-menu-glyph'),
    badge: el!.querySelector('[data-quick-action-badge]')?.textContent?.trim() ?? null,
    paths: [...(svg?.querySelectorAll('path') ?? [])].map((p) => p.getAttribute('d'))
  };
}

describe('the settings row draws the quick menu’s own glyph', () => {
  it.each(CONTEXTS)('for every menu-eligible action (%o)', (ctx) => {
    // The menu, with every eligible action on it.
    const state: QuickMenuState = {
      ...ctx,
      mode: 'paged',
      editing: true,
      ankiEnabled: true,
      hasLayers: true,
      toggleOn: () => undefined
    };
    const items = quickMenuItems(
      ELIGIBLE.map((a) => a.id),
      ACTIONS,
      state
    );
    const menu = render(QuickActions, { props: { items, open: true } });
    flushSync();

    // The section's rows, drawn for the same book.
    provideMenuGlyphContext(ctx);
    const section = render(RowsHarness, { props: { rows: ELIGIBLE } });
    flushSync();

    let compared = 0;
    for (const item of items) {
      const fromMenu = drawn(
        menu.container.querySelector(`[data-quick-action="${item.id}"] [data-menu-glyph]`)
      );
      const fromRow = drawn(
        section.container.querySelector(`[data-key-action="${item.id}"] [data-menu-glyph]`)
      );
      expect(fromRow, item.id).toEqual(fromMenu);
      expect(fromMenu.icon, item.id).toBe(item.icon);
      expect(fromMenu.badge, item.id).toBe(item.badge ?? null);
      compared++;
    }
    // Everything eligible was compared, bar "Add image 2" with one page on screen.
    expect(compared).toBe(ELIGIBLE.length - (ctx.hasSecondPage ? 0 : 1));
  });

  it('badges show in the settings rows (left/right, steps, options, the Anki pair)', () => {
    provideMenuGlyphContext({ forward: 'left', hasSecondPage: true });
    const ids = [
      'reader.ocr-layer',
      'reader.ocr-layer-prev',
      'reader.zoom-in',
      'set.brightness.reset',
      'set.zoom-paged.to.zoomFitToWidth',
      'reader.anki-image',
      'reader.anki-image-2'
    ];
    const { container } = render(RowsHarness, {
      props: { rows: ids.map((id) => ACTIONS.get(id)!) }
    });
    const badge = (id: string) =>
      container.querySelector(`[data-key-action="${id}"] [data-quick-action-badge]`)?.textContent;
    expect(ids.map(badge)).toEqual(['›', '‹', '+', '0', 'Fit', '1', '2']);
  });

  it('page turns point the way the open book turns', () => {
    for (const [forward, next, prev] of [
      ['left', 'ArrowLeftOutline', 'ArrowRightOutline'],
      ['right', 'ArrowRightOutline', 'ArrowLeftOutline'],
      ['down', 'ArrowDownOutline', 'ArrowUpOutline']
    ] as const) {
      provideMenuGlyphContext({ forward, hasSecondPage: true });
      const { container, unmount } = render(RowsHarness, {
        props: { rows: [ACTIONS.get('reader.page-next')!, ACTIONS.get('reader.page-prev')!] }
      });
      const icon = (id: string) =>
        container
          .querySelector(`[data-key-action="${id}"] [data-menu-glyph]`)
          ?.getAttribute('data-menu-glyph');
      expect([icon('reader.page-next'), icon('reader.page-prev')], forward).toEqual([next, prev]);
      unmount();
    }
  });
});

describe('the context outside the reader', () => {
  it('is the profile’s defaults: a right-to-left volume, its layout and page view', () => {
    const base = {
      continuousScroll: false,
      scrollMode: 'auto' as const,
      singlePageView: 'auto' as const,
      volumeDefaults: { rightToLeft: true, hasCover: false, singlePageView: 'auto' as const }
    };
    expect(defaultMenuGlyphContext(base as never, true)).toEqual({
      forward: 'left',
      hasSecondPage: true
    });
    expect(defaultMenuGlyphContext(base as never, false)).toEqual({
      forward: 'left',
      hasSecondPage: false
    });
    expect(
      defaultMenuGlyphContext(
        { ...base, volumeDefaults: { ...base.volumeDefaults, rightToLeft: false } } as never,
        true
      ).forward
    ).toBe('right');
    expect(
      defaultMenuGlyphContext(
        { ...base, continuousScroll: true, scrollMode: 'vertical' } as never,
        true
      )
    ).toEqual({ forward: 'down', hasSecondPage: false });
  });

  it('the reader’s own context wins while it is open, and the defaults return after', () => {
    const before = get(menuGlyphContext);
    provideMenuGlyphContext({ forward: 'down', hasSecondPage: false });
    expect(get(menuGlyphContext)).toEqual({ forward: 'down', hasSecondPage: false });
    provideMenuGlyphContext(null);
    expect(get(menuGlyphContext)).toEqual(before);
  });
});
