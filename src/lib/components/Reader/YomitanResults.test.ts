import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import YomitanResults from './YomitanResults.svelte';

const rendererMocks = vi.hoisted(() => ({
  prepareHost: vi.fn(),
  renderTermEntries: vi.fn(),
  updateHost: vi.fn(),
  destroy: vi.fn()
}));

const coreMocks = vi.hoisted(() => ({
  createTermEntryRenderer: vi.fn()
}));

vi.mock('$lib/yomitan/core', () => coreMocks);

describe('YomitanResults', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    rendererMocks.renderTermEntries.mockImplementation((entries: unknown[]) => {
      return entries.map((entry, index) => {
        const entryNode = document.createElement('div');
        entryNode.textContent = `entry-${index}`;
        return {
          index,
          entry,
          entryNode
        };
      });
    });

    coreMocks.createTermEntryRenderer.mockReturnValue(rendererMocks);
  });

  it('creates term entry renderer and renders rows declaratively with Anki action', async () => {
    const entries = [{ id: 1 } as never];
    const dictionaryInfo = [{ title: 'JMdict', importDate: Date.now() } as never];
    const onAddToAnki = vi.fn();

    const { getByRole, getByText, container } = render(YomitanResults, {
      entries,
      dictionaryInfo,
      theme: 'dark',
      ankiEnabled: true,
      ankiButtonStates: [{ state: 'ready' }],
      ankiButtonChecked: [true],
      ankiButtonFadeIn: [false],
      onAddToAnki
    });

    await waitFor(() => {
      expect(coreMocks.createTermEntryRenderer).toHaveBeenCalledWith();
      expect(rendererMocks.prepareHost).toHaveBeenCalledTimes(1);
      expect(rendererMocks.renderTermEntries).toHaveBeenCalledWith(
        entries,
        dictionaryInfo,
        expect.objectContaining({ theme: 'dark' })
      );
    });

    expect(getByText('entry-0')).toBeTruthy();

    const button = getByRole('button', { name: 'Add to Anki' });
    await fireEvent.click(button);
    expect(onAddToAnki).toHaveBeenCalledWith(0);

    const icon = container.querySelector('img.yomitan-anki-action__icon');
    expect(icon?.getAttribute('src')).toBe('/brands/anki.svg');
  });

  it('re-renders entry rows and button visibility as state changes', async () => {
    const entries = [{ id: 1 } as never];
    const dictionaryInfo = [{ title: 'JMdict', importDate: Date.now() } as never];

    const view = render(YomitanResults, {
      entries,
      dictionaryInfo,
      ankiEnabled: true,
      ankiButtonStates: [{ state: 'ready' }],
      ankiButtonChecked: [false],
      ankiButtonFadeIn: [false]
    });

    await waitFor(() => {
      expect(rendererMocks.renderTermEntries).toHaveBeenCalled();
      expect(view.getByText('entry-0')).toBeTruthy();
    });

    expect(view.queryByRole('button', { name: 'Add to Anki' })).toBeNull();

    view.rerender({
      entries,
      dictionaryInfo,
      ankiEnabled: true,
      ankiButtonStates: [{ state: 'duplicate' }],
      ankiButtonChecked: [true],
      ankiButtonFadeIn: [true]
    });

    await waitFor(() => {
      expect(view.getByRole('button', { name: 'Add duplicate' })).toBeTruthy();
      expect(rendererMocks.updateHost).toHaveBeenCalled();
    });

    view.rerender({
      entries,
      dictionaryInfo,
      ankiEnabled: true,
      ankiButtonStates: [{ state: 'ready' }],
      ankiButtonChecked: [true],
      ankiButtonFadeIn: [false]
    });

    await waitFor(() => {
      expect(view.getByRole('button', { name: 'Add to Anki' })).toBeTruthy();
      expect(view.getAllByRole('button')).toHaveLength(1);
    });
  });
});
