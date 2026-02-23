import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import YomitanDrawer from './YomitanDrawer.svelte';

const rendererMocks = vi.hoisted(() => ({
  prepareHost: vi.fn(),
  renderTermEntries: vi.fn(),
  updateHost: vi.fn(),
  destroy: vi.fn()
}));

const coreMocks = vi.hoisted(() => ({
  getInstalledDictionaries: vi.fn(),
  buildEnabledDictionaryMap: vi.fn(),
  tokenizeText: vi.fn(),
  lookupTerm: vi.fn(),
  createTermEntryRenderer: vi.fn()
}));

const preferenceMocks = vi.hoisted(() => ({
  loadDictionaryPreferences: vi.fn(),
  normalizeDictionaryPreferences: vi.fn(),
  saveDictionaryPreferences: vi.fn()
}));

const ankiNoteMocks = vi.hoisted(() => ({
  addPopupAnkiNote: vi.fn(),
  getPopupAnkiButtonStates: vi.fn()
}));

vi.mock('$lib/yomitan/core', () => coreMocks);
vi.mock('$lib/yomitan/preferences', () => preferenceMocks);
vi.mock('$lib/yomitan/anki-note', () => ankiNoteMocks);

describe('YomitanDrawer', () => {
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
    coreMocks.getInstalledDictionaries.mockResolvedValue([
      { title: 'JMdict', importDate: Date.now() }
    ]);
    preferenceMocks.loadDictionaryPreferences.mockReturnValue([{ title: 'JMdict', enabled: true }]);
    preferenceMocks.normalizeDictionaryPreferences.mockReturnValue([
      { title: 'JMdict', enabled: true }
    ]);
    coreMocks.buildEnabledDictionaryMap.mockReturnValue(
      new Map([['JMdict', { index: 0, priority: 0 }]])
    );
    ankiNoteMocks.addPopupAnkiNote.mockResolvedValue({ noteId: 123, errors: [] });
    ankiNoteMocks.getPopupAnkiButtonStates.mockResolvedValue({
      buttonStates: [],
      hadConnectionError: false
    });
  });

  it('renders token buttons and mounts yomitan results renderer after token click', async () => {
    coreMocks.tokenizeText.mockResolvedValue([
      { text: '日本語', reading: 'にほんご', term: '日本語', selectable: true, kind: 'word' }
    ]);
    coreMocks.lookupTerm.mockResolvedValue({ entries: [{ id: 1 }], originalTextLength: 3 });

    const { getByText, queryByTitle, getByTestId } = render(YomitanDrawer, {
      open: true,
      sourceText: '日本語'
    });

    await waitFor(() => expect(getByText('日本語')).toBeTruthy());
    await fireEvent.click(getByText('日本語'));

    await waitFor(() => {
      expect(coreMocks.createTermEntryRenderer).toHaveBeenCalled();
      expect(rendererMocks.renderTermEntries).toHaveBeenCalled();
      expect(getByTestId('yomitan-results')).toBeTruthy();
      expect(queryByTitle('Yomitan dictionary results')).toBeNull();
    });
  });

  it('shows no entries message when lookup returns empty entries', async () => {
    coreMocks.tokenizeText.mockResolvedValue([
      { text: '猫', reading: 'ねこ', term: '猫', selectable: true, kind: 'word' }
    ]);
    coreMocks.lookupTerm.mockResolvedValue({ entries: [], originalTextLength: 1 });

    const { getByText } = render(YomitanDrawer, {
      open: true,
      sourceText: '猫'
    });

    await waitFor(() => expect(getByText('猫')).toBeTruthy());
    await fireEvent.click(getByText('猫'));

    await waitFor(() =>
      expect(getByText('No dictionary entries found for this token.')).toBeTruthy()
    );
  });

  it('renders punctuation tokens as non-clickable text', async () => {
    coreMocks.tokenizeText.mockResolvedValue([
      { text: '猫', reading: 'ねこ', term: '猫', selectable: true, kind: 'word' },
      { text: '、', reading: '', term: '、', selectable: false, kind: 'other' }
    ]);
    coreMocks.lookupTerm.mockResolvedValue({ entries: [{ id: 1 }], originalTextLength: 1 });

    const { getByText, getAllByRole } = render(YomitanDrawer, {
      open: true,
      sourceText: '猫、'
    });

    await waitFor(() => {
      expect(coreMocks.createTermEntryRenderer).toHaveBeenCalled();
    });

    const punctuation = getByText('、');
    expect(punctuation.tagName.toLowerCase()).toBe('span');

    const wordButtons = getAllByRole('button').filter(
      (button) => button.textContent?.trim() === '猫'
    );
    expect(wordButtons).toHaveLength(1);
  });

  it('closes from close button and emits onClose once', async () => {
    coreMocks.tokenizeText.mockResolvedValue([
      { text: '猫', reading: 'ねこ', term: '猫', selectable: true, kind: 'word' }
    ]);
    coreMocks.lookupTerm.mockResolvedValue({ entries: [{ id: 1 }], originalTextLength: 1 });
    const onClose = vi.fn();

    const { getByLabelText } = render(YomitanDrawer, {
      open: true,
      sourceText: '猫',
      onClose
    });

    await waitFor(() => expect(getByLabelText('Close')).toBeTruthy());
    await fireEvent.click(getByLabelText('Close'));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('keeps token taps working', async () => {
    coreMocks.tokenizeText.mockResolvedValue([
      { text: '猫', reading: 'ねこ', term: '猫', selectable: true, kind: 'word' },
      { text: '犬', reading: 'いぬ', term: '犬', selectable: true, kind: 'word' }
    ]);
    coreMocks.lookupTerm.mockImplementation(async (term: string) => ({
      entries: [{ id: term }],
      originalTextLength: 1
    }));

    const { getByText } = render(YomitanDrawer, {
      open: true,
      sourceText: '猫犬'
    });

    const secondToken = await waitFor(() => getByText('犬'));
    await fireEvent.pointerDown(secondToken, {
      pointerId: 2,
      clientX: 100,
      clientY: 100,
      pointerType: 'touch',
      isPrimary: true
    });
    await fireEvent.pointerMove(secondToken, {
      pointerId: 2,
      clientX: 101,
      clientY: 105,
      pointerType: 'touch',
      isPrimary: true
    });
    await fireEvent.pointerUp(secondToken, {
      pointerId: 2,
      clientX: 101,
      clientY: 105,
      pointerType: 'touch',
      isPrimary: true
    });
    await fireEvent.click(secondToken);

    await waitFor(() => {
      expect(coreMocks.lookupTerm).toHaveBeenCalledTimes(2);
      expect(coreMocks.lookupTerm).toHaveBeenLastCalledWith('犬', expect.any(Map));
    });
  });

  it('hides button until precheck completes, then shows duplicate state', async () => {
    coreMocks.tokenizeText.mockResolvedValue([
      { text: '猫', reading: 'ねこ', term: '猫', selectable: true, kind: 'word' }
    ]);
    coreMocks.lookupTerm.mockResolvedValue({ entries: [{ id: 1 }], originalTextLength: 1 });

    let resolvePrecheck: ((value: unknown) => void) | null = null;
    ankiNoteMocks.getPopupAnkiButtonStates.mockReturnValue(
      new Promise<unknown>((resolve) => {
        resolvePrecheck = resolve;
      })
    );

    const view = render(YomitanDrawer, {
      open: true,
      sourceText: '猫',
      ankiEnabled: true
    });

    await waitFor(() => {
      expect(view.queryByRole('button', { name: 'Add duplicate' })).toBeNull();
      expect(view.queryByRole('button', { name: 'Add to Anki' })).toBeNull();
    });

    if (!resolvePrecheck) {
      throw new Error('Expected precheck resolver to be set');
    }
    (resolvePrecheck as (value: unknown) => void)({
      buttonStates: [{ state: 'duplicate' }],
      hadConnectionError: false
    });

    await waitFor(() => {
      expect(view.getByRole('button', { name: 'Add duplicate' })).toBeTruthy();
    });
  });

  it('transitions adding to added when Add to Anki succeeds', async () => {
    coreMocks.tokenizeText.mockResolvedValue([
      { text: '猫', reading: 'ねこ', term: '猫', selectable: true, kind: 'word' }
    ]);
    coreMocks.lookupTerm.mockResolvedValue({ entries: [{ id: 1 }], originalTextLength: 1 });
    ankiNoteMocks.getPopupAnkiButtonStates.mockResolvedValue({
      buttonStates: [{ state: 'ready' }],
      hadConnectionError: false
    });
    ankiNoteMocks.addPopupAnkiNote.mockResolvedValue({ noteId: 42, errors: [] });

    const view = render(YomitanDrawer, {
      open: true,
      sourceText: '猫',
      ankiEnabled: true
    });

    const addButton = await waitFor(() => view.getByRole('button', { name: 'Add to Anki' }));
    await fireEvent.click(addButton);

    await waitFor(() => {
      expect(ankiNoteMocks.addPopupAnkiNote).toHaveBeenCalled();
      expect(view.getByRole('button', { name: 'Added ✓' })).toBeTruthy();
    });
  });

  it('ignores stale precheck results after switching tokens', async () => {
    coreMocks.tokenizeText.mockResolvedValue([
      { text: '猫', reading: 'ねこ', term: '猫', selectable: true, kind: 'word' },
      { text: '犬', reading: 'いぬ', term: '犬', selectable: true, kind: 'word' }
    ]);
    coreMocks.lookupTerm.mockImplementation(async (term: string) => ({
      entries: [{ id: term }],
      originalTextLength: 1
    }));

    let resolveCat: ((value: unknown) => void) | null = null;
    let resolveDog: ((value: unknown) => void) | null = null;
    ankiNoteMocks.getPopupAnkiButtonStates.mockImplementation(
      async (_entries: unknown[], source: string) => {
        return await new Promise<unknown>((resolve) => {
          if (source === '猫') {
            resolveCat = resolve;
          } else {
            resolveDog = resolve;
          }
        });
      }
    );

    const { getByText, queryByRole, getByRole } = render(YomitanDrawer, {
      open: true,
      sourceText: '猫犬',
      ankiEnabled: true
    });

    await waitFor(() => expect(getByText('犬')).toBeTruthy());
    await fireEvent.click(getByText('犬'));

    await waitFor(() => expect(ankiNoteMocks.getPopupAnkiButtonStates).toHaveBeenCalledTimes(2));
    if (!resolveCat || !resolveDog) {
      throw new Error('Expected precheck resolvers to be set');
    }

    (resolveCat as (value: unknown) => void)({
      buttonStates: [{ state: 'duplicate' }],
      hadConnectionError: false
    });
    (resolveDog as (value: unknown) => void)({
      buttonStates: [{ state: 'ready' }],
      hadConnectionError: false
    });

    await waitFor(() => {
      expect(getByRole('button', { name: 'Add to Anki' })).toBeTruthy();
      expect(queryByRole('button', { name: 'Add duplicate' })).toBeNull();
    });
  });

  it('respects outsideClose for backdrop interactions', async () => {
    coreMocks.tokenizeText.mockResolvedValue([
      { text: '猫', reading: 'ねこ', term: '猫', selectable: true, kind: 'word' }
    ]);
    coreMocks.lookupTerm.mockResolvedValue({ entries: [{ id: 1 }], originalTextLength: 1 });

    const onCloseAllowed = vi.fn();
    const first = render(YomitanDrawer, {
      open: true,
      sourceText: '猫',
      outsideClose: true,
      onClose: onCloseAllowed
    });
    await waitFor(() => expect(first.container.querySelector('dialog')).toBeTruthy());
    await fireEvent.mouseDown(first.container.querySelector('dialog') as HTMLDialogElement, {
      clientX: 999,
      clientY: 1
    });
    await waitFor(() => expect(onCloseAllowed).toHaveBeenCalledTimes(1));

    first.unmount();

    const onCloseBlocked = vi.fn();
    const second = render(YomitanDrawer, {
      open: true,
      sourceText: '猫',
      outsideClose: false,
      onClose: onCloseBlocked
    });
    await waitFor(() => expect(second.container.querySelector('dialog')).toBeTruthy());
    await fireEvent.mouseDown(second.container.querySelector('dialog') as HTMLDialogElement, {
      clientX: 999,
      clientY: 1
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onCloseBlocked).not.toHaveBeenCalled();
  });
});
