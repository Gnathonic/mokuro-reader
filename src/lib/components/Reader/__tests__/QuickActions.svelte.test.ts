import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { flushSync } from 'svelte';

vi.mock('$lib/catalog/db', () => ({ db: {} }));

import QuickActions from '../QuickActions.svelte';

afterEach(cleanup);

const layers = [
  { layer_id: 'english', name: 'English', kind: 'translation' as const, updated_at: 'x' }
];

/** Mounts QuickActions with `layersOpen` and `open` bound to parent-owned `$state`, as Reader does. */
function mount(initial: { visible?: boolean } = {}) {
  const parent = $state({ layersOpen: false, open: false, visible: initial.visible ?? true });
  const onZoomFit = vi.fn();
  const utils = render(QuickActions, {
    props: {
      left: vi.fn(),
      right: vi.fn(),
      layers,
      onZoomFit,
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
      },
      get open() {
        return parent.open;
      },
      set open(v: boolean) {
        parent.open = v;
      }
    }
  });
  return { parent, onZoomFit, ...utils };
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

describe('QuickActions — opened by a key (#55)', () => {
  it('publishes the menu open state, and a parent (the key) can open and close it', async () => {
    const utils = mount();
    expect(utils.queryByLabelText('Zoom to fit')).toBeNull();
    utils.parent.open = true;
    flushSync();
    expect(utils.queryByLabelText('Zoom to fit')).not.toBeNull();
    utils.parent.open = false;
    flushSync();
    expect(utils.queryByLabelText('Zoom to fit')).toBeNull();
    // The button toggles the same state.
    await fireEvent.click(utils.getByLabelText('Quick actions menu'));
    expect(utils.parent.open).toBe(true);
  });

  it('opens by key while its button is hidden, and brings the button along to close it', async () => {
    const utils = mount({ visible: false });
    expect(utils.queryByLabelText('Quick actions menu')).toBeNull();
    utils.parent.open = true;
    flushSync();
    expect(utils.queryByLabelText('Zoom to fit')).not.toBeNull();
    await fireEvent.click(utils.getByLabelText('Quick actions menu'));
    expect(utils.parent.open).toBe(false);
    expect(utils.queryByLabelText('Quick actions menu')).toBeNull();
  });

  it('renders the layer picker whenever it is open, not only while the menu button shows', () => {
    const utils = mount({ visible: false });
    utils.parent.layersOpen = true;
    flushSync();
    expect(utils.queryByRole('dialog', { name: 'OCR layers' })).not.toBeNull();
    // Nothing else of the menu came with it.
    expect(utils.queryByLabelText('Quick actions menu')).toBeNull();
    expect(utils.parent.layersOpen).toBe(true);
  });

  it('hiding the controls puts an open menu away too', () => {
    const utils = mount();
    utils.parent.open = true;
    flushSync();
    utils.parent.visible = false;
    flushSync();
    expect(utils.parent.open).toBe(false);
    expect(utils.queryByLabelText('Quick actions menu')).toBeNull();
  });

  it("Zoom to fit runs the reader's handler — the key's — and closes the menu", async () => {
    const utils = mount();
    utils.parent.open = true;
    flushSync();
    await fireEvent.click(utils.getByLabelText('Zoom to fit'));
    expect(utils.onZoomFit).toHaveBeenCalledOnce();
    expect(utils.parent.open).toBe(false);
  });
});
