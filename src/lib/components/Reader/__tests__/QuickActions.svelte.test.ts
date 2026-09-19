import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { flushSync } from 'svelte';

vi.mock('$lib/catalog/db', () => ({ db: {} }));

import QuickActions from '../QuickActions.svelte';

afterEach(cleanup);

const layers = [
  { layer_id: 'english', name: 'English', kind: 'translation' as const, updated_at: 'x' }
];

/** Mounts QuickActions with `layersOpen` bound to a parent-owned `$state`, as Reader does. */
function mount() {
  const parent = $state({ layersOpen: false, visible: true });
  const utils = render(QuickActions, {
    props: {
      left: vi.fn(),
      right: vi.fn(),
      src1: undefined,
      src2: undefined,
      volumeUuid: 'v1',
      layers,
      onSelectLayer: vi.fn(),
      onLayerAction: vi.fn(),
      get visible() {
        return parent.visible;
      },
      get layersOpen() {
        return parent.layersOpen;
      },
      set layersOpen(v: boolean) {
        parent.layersOpen = v;
      }
    }
  });
  return { parent, ...utils };
}

async function openPicker(utils: ReturnType<typeof mount>) {
  await fireEvent.click(utils.getByLabelText('Quick actions menu'));
  await fireEvent.click(utils.getByLabelText('OCR layers'));
  expect(utils.parent.layersOpen).toBe(true);
}

describe('QuickActions — layer picker open state', () => {
  it('publishes the picker open state to the parent, which can close it (Escape path)', async () => {
    const utils = mount();
    await openPicker(utils);
    expect(utils.queryByRole('dialog', { name: 'OCR layers' })).not.toBeNull();

    utils.parent.layersOpen = false;
    flushSync();
    expect(utils.queryByRole('dialog', { name: 'OCR layers' })).toBeNull();
  });

  it('reports closed once the picker is no longer rendered (overlays hidden)', async () => {
    // Otherwise the reader would keep swallowing its shortcuts for a picker
    // nobody can see.
    const utils = mount();
    await openPicker(utils);
    utils.parent.visible = false;
    flushSync();
    expect(utils.parent.layersOpen).toBe(false);
  });

  it('reports closed when it unmounts with the picker open (volume switch)', async () => {
    const utils = mount();
    await openPicker(utils);
    utils.unmount();
    expect(utils.parent.layersOpen).toBe(false);
  });
});
