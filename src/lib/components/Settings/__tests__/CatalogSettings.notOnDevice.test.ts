import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';

const { catalogSettings, updateCatalogSetting } = vi.hoisted(() => {
  const subs = new Set<(v: Record<string, unknown>) => void>();
  let current: Record<string, unknown> = { stackingPreset: 'default', notOnDeviceDisplay: 'mixed' };
  return {
    catalogSettings: {
      subscribe(fn: (v: Record<string, unknown>) => void) {
        subs.add(fn);
        fn(current);
        return () => subs.delete(fn);
      },
      set(v: Record<string, unknown>) {
        current = v;
        subs.forEach((fn) => fn(current));
      }
    },
    updateCatalogSetting: vi.fn()
  };
});

vi.mock('$lib/settings/settings', () => ({ catalogSettings, updateCatalogSetting }));
vi.mock('$lib/settings', () => ({ clearVolumes: vi.fn() }));
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: { clear: vi.fn() },
    volume_ocr: { clear: vi.fn() },
    volume_files: { clear: vi.fn() }
  }
}));
vi.mock('$lib/util', () => ({ promptConfirmation: vi.fn(), isCatalog: () => true }));
vi.mock('$lib/util/hash-router', () => ({ nav: { toCatalog: vi.fn(), toMergeSeries: vi.fn() } }));

import CatalogSettings from '../CatalogSettings.svelte';

/** The accordion renders its body only once expanded. */
async function open() {
  const utils = render(CatalogSettings);
  const header = utils.container.querySelector('button');
  if (!header) throw new Error('accordion header not found');
  await fireEvent.click(header);
  return utils;
}

/** The select whose options are the two not-on-device placements. */
function placementSelect(container: HTMLElement): HTMLSelectElement {
  const select = [...container.querySelectorAll('select')].find((el) =>
    [...el.options].some((option) => option.value === 'cloud-section')
  );
  if (!select) throw new Error('not-on-device placement select not found');
  return select;
}

describe('CatalogSettings not-on-device placement', () => {
  beforeEach(() => {
    updateCatalogSetting.mockClear();
  });

  afterEach(() => cleanup());

  it('offers both placements in plain words', async () => {
    const { container } = await open();
    // flowbite's Select prepends its own empty "Choose option ..." placeholder.
    const options = [...placementSelect(container).options]
      .filter((o) => o.value !== '')
      .map((o) => [o.value, o.text.trim()]);
    expect(options).toEqual([
      ['mixed', 'Mixed with library'],
      ['cloud-section', 'Grouped with cloud volumes']
    ]);
  });

  it('shows the stored placement', async () => {
    catalogSettings.set({ stackingPreset: 'default', notOnDeviceDisplay: 'cloud-section' });
    const { container } = await open();
    expect(placementSelect(container).value).toBe('cloud-section');
    catalogSettings.set({ stackingPreset: 'default', notOnDeviceDisplay: 'mixed' });
  });

  it('writes the choice straight to the setting — no other setting is touched', async () => {
    const { container } = await open();
    const select = placementSelect(container);

    select.value = 'cloud-section';
    await fireEvent.change(select);

    expect(updateCatalogSetting).toHaveBeenCalledTimes(1);
    expect(updateCatalogSetting).toHaveBeenCalledWith('notOnDeviceDisplay', 'cloud-section');
  });
});
