import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { writable } from 'svelte/store';

const h = vi.hoisted(() => ({ run: null as unknown }));
vi.mock('$lib/engines/engine-runs', async () => {
  const { writable } = await import('svelte/store');
  const store = writable<unknown>(null);
  h.run = store;
  return { activeEngineRun: { subscribe: store.subscribe } };
});

import EngineRunBanner from '../EngineRunBanner.svelte';

afterEach(cleanup);

describe('EngineRunBanner', () => {
  it('renders nothing without a run, then progress and a Cancel that aborts', async () => {
    const store = h.run as ReturnType<typeof writable<unknown>>;
    const { queryByRole, getByText, getByLabelText } = render(EngineRunBanner);
    expect(queryByRole('status')).toBeNull();
    const cancel = vi.fn();
    store.set({ kind: 'ocr', volumeUuid: 'v', done: 3, total: 198, cancel });
    await new Promise((r) => setTimeout(r, 0));
    expect(getByText(/OCR 3 \/ 198/)).toBeTruthy();
    await fireEvent.click(getByLabelText('Cancel engine run'));
    expect(cancel).toHaveBeenCalled();
  });
});
