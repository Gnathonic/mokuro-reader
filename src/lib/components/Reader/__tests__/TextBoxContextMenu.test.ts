import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import TextBoxContextMenu from '../TextBoxContextMenu.svelte';

afterEach(cleanup);

function mount(extra: Record<string, unknown> = {}) {
  const onEditText = vi.fn();
  const onClose = vi.fn();
  const utils = render(TextBoxContextMenu, {
    props: {
      x: 10,
      y: 10,
      lines: ['あい', 'うえ'],
      ankiEnabled: false,
      onCopy: vi.fn(),
      onCopyRaw: vi.fn(),
      onAddToAnki: vi.fn(),
      onClose,
      onEditText,
      ...extra
    }
  });
  return { ...utils, onEditText, onClose };
}

describe('TextBoxContextMenu — Edit this text', () => {
  it('offers the item when a handler is given and fires it, then closes', async () => {
    const { getByText, onEditText, onClose } = mount();
    const item = getByText('Edit this text');
    await fireEvent.pointerUp(item.closest('button')!);
    expect(onEditText).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  it('hides the item without a handler', () => {
    const { queryByText } = mount({ onEditText: undefined });
    expect(queryByText('Edit this text')).toBeNull();
  });
});
