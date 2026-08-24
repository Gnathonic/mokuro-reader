import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { createEmptySeriesMetadata, type SeriesMetadata } from '$lib/metadata/types';

// vi.hoisted: `vi.mock` factories are hoisted above every other top-level statement
// (including this file's own imports), so the store the factory closes over must be
// built here with a minimal hand-rolled Svelte store contract — same pattern as
// SeriesMetadataBar.test.ts / SeriesTrackingPanel.test.ts.
const h = vi.hoisted(() => {
  function createStore<T>(initial: T) {
    let value = initial;
    const subs = new Set<(v: T) => void>();
    return {
      subscribe(fn: (v: T) => void) {
        subs.add(fn);
        fn(value);
        return () => {
          subs.delete(fn);
        };
      },
      set(v: T) {
        value = v;
        subs.forEach((fn) => fn(value));
      }
    };
  }

  return {
    seriesMetadataMap: createStore(new Map<string, SeriesMetadata>()),
    updateSeriesMetadata: vi.fn(async () => undefined),
    // No active provider by default — every existing test in this file relies on the
    // fields staying enabled, which is `canEditSeriesMetadata`'s default in that state.
    providerStatus: createStore({
      providers: {} as Record<string, { metadataPermissions?: unknown } | null>,
      currentProviderType: null as string | null
    })
  };
});

vi.mock('$lib/metadata/store', () => ({
  seriesMetadataMap: h.seriesMetadataMap,
  updateSeriesMetadata: h.updateSeriesMetadata
}));
vi.mock('$lib/util/sync', () => ({ providerManager: { status: h.providerStatus } }));

import SeriesTitlesEditor from '../SeriesTitlesEditor.svelte';

function meta(overrides: Partial<SeriesMetadata> = {}): SeriesMetadata {
  return { ...createEmptySeriesMetadata('One Piece'), ...overrides };
}

function setMeta(record: SeriesMetadata | undefined) {
  h.seriesMetadataMap.set(record ? new Map([['one piece', record]]) : new Map());
}

function renderEditor(seriesTitle = 'One Piece') {
  return render(SeriesTitlesEditor, { props: { seriesTitle } });
}

describe('SeriesTitlesEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setMeta(undefined);
    h.providerStatus.set({ providers: {}, currentProviderType: null });
  });

  describe('per-series metadata edit gating', () => {
    it('leaves every field enabled when the active provider reports no metadata scope', () => {
      h.providerStatus.set({
        providers: { webdav: { metadataPermissions: undefined } },
        currentProviderType: 'webdav'
      });
      const { getByLabelText, getByText } = renderEditor();
      expect((getByLabelText('Native') as HTMLInputElement).disabled).toBe(false);
      expect((getByLabelText('Romaji') as HTMLInputElement).disabled).toBe(false);
      expect((getByLabelText('English') as HTMLInputElement).disabled).toBe(false);
      expect((getByLabelText('Synonyms') as HTMLTextAreaElement).disabled).toBe(false);
      expect(getByText('Linking to AniList replaces these.')).toBeTruthy();
    });

    it('disables every field and shows the reason under scope "none"', () => {
      h.providerStatus.set({
        providers: { webdav: { metadataPermissions: { scope: 'none' } } },
        currentProviderType: 'webdav'
      });
      const { getByLabelText, getByText } = renderEditor();
      expect((getByLabelText('Native') as HTMLInputElement).disabled).toBe(true);
      expect((getByLabelText('Romaji') as HTMLInputElement).disabled).toBe(true);
      expect((getByLabelText('English') as HTMLInputElement).disabled).toBe(true);
      expect((getByLabelText('Synonyms') as HTMLTextAreaElement).disabled).toBe(true);
      expect(getByText("This account can't edit series details on this server")).toBeTruthy();
    });

    it('refuses to write even if a change reaches the save path (defense in depth beyond the disabled attribute)', async () => {
      h.providerStatus.set({
        providers: { webdav: { metadataPermissions: { scope: 'none' } } },
        currentProviderType: 'webdav'
      });
      const { getByLabelText } = renderEditor();
      const native = getByLabelText('Native') as HTMLInputElement;
      // fireEvent bypasses the disabled attribute the way a real user can't — this proves
      // the save function's own gate check is what refuses the write, not just the
      // attribute a browser would normally enforce.
      await fireEvent.input(native, { target: { value: 'ワンピース' } });
      await fireEvent.blur(native);
      expect(h.updateSeriesMetadata).not.toHaveBeenCalled();
    });
  });

  it('prefills the fields from meta.titles and meta.synonyms', () => {
    setMeta(
      meta({
        titles: { native: 'ワンピース', romaji: 'Wan Pisu', english: 'One Piece' },
        synonyms: ['OP', 'Wanpiisu']
      })
    );
    const { getByLabelText } = renderEditor();
    expect((getByLabelText('Native') as HTMLInputElement).value).toBe('ワンピース');
    expect((getByLabelText('Romaji') as HTMLInputElement).value).toBe('Wan Pisu');
    expect((getByLabelText('English') as HTMLInputElement).value).toBe('One Piece');
    expect((getByLabelText('Synonyms') as HTMLTextAreaElement).value).toBe('OP\nWanpiisu');
  });

  it('renders blank fields for an unlinked series with no metadata record at all', () => {
    const { getByLabelText } = renderEditor('Brand New Series');
    expect((getByLabelText('Native') as HTMLInputElement).value).toBe('');
    expect((getByLabelText('Romaji') as HTMLInputElement).value).toBe('');
    expect((getByLabelText('English') as HTMLInputElement).value).toBe('');
    expect((getByLabelText('Synonyms') as HTMLTextAreaElement).value).toBe('');
  });

  it('shows the AniList-replacement helper line', () => {
    const { getByText } = renderEditor();
    expect(getByText('Linking to AniList replaces these.')).toBeTruthy();
  });

  it('saves the titles patch on blur with blank keys omitted', async () => {
    const { getByLabelText } = renderEditor();
    const native = getByLabelText('Native') as HTMLInputElement;
    await fireEvent.input(native, { target: { value: 'ワンピース' } });
    await fireEvent.blur(native);
    expect(h.updateSeriesMetadata).toHaveBeenCalledWith('One Piece', {
      titles: { native: 'ワンピース' }
    });
  });

  it('keeps the other title fields in the patch when only one field changes', async () => {
    setMeta(meta({ titles: { native: 'ワンピース', english: 'One Piece' } }));
    const { getByLabelText } = renderEditor();
    const romaji = getByLabelText('Romaji') as HTMLInputElement;
    await fireEvent.input(romaji, { target: { value: 'Wan Pisu' } });
    await fireEvent.blur(romaji);
    expect(h.updateSeriesMetadata).toHaveBeenCalledWith('One Piece', {
      titles: { native: 'ワンピース', romaji: 'Wan Pisu', english: 'One Piece' }
    });
  });

  it('writes titles: {} when every title field is cleared', async () => {
    setMeta(meta({ titles: { native: 'X', romaji: 'Y', english: 'Z' } }));
    const { getByLabelText } = renderEditor();
    const native = getByLabelText('Native') as HTMLInputElement;
    const romaji = getByLabelText('Romaji') as HTMLInputElement;
    const english = getByLabelText('English') as HTMLInputElement;
    await fireEvent.input(native, { target: { value: '' } });
    await fireEvent.input(romaji, { target: { value: '' } });
    await fireEvent.input(english, { target: { value: '' } });
    await fireEvent.blur(english);
    expect(h.updateSeriesMetadata).toHaveBeenCalledWith('One Piece', { titles: {} });
  });

  it('does not write when a title field is blurred without changing', async () => {
    setMeta(meta({ titles: { native: 'ワンピース' } }));
    const { getByLabelText } = renderEditor();
    const native = getByLabelText('Native') as HTMLInputElement;
    await fireEvent.focus(native);
    await fireEvent.blur(native);
    expect(h.updateSeriesMetadata).not.toHaveBeenCalled();
  });

  it('saves on Enter (and blurs, rather than doing anything else)', async () => {
    const { getByLabelText } = renderEditor();
    const romaji = getByLabelText('Romaji') as HTMLInputElement;
    // .blur() is a no-op on an element that was never focused, so give it focus first —
    // same as a real user clicking into the field before typing.
    romaji.focus();
    await fireEvent.input(romaji, { target: { value: 'Wan Pisu' } });
    await fireEvent.keyDown(romaji, { key: 'Enter' });
    expect(h.updateSeriesMetadata).toHaveBeenCalledTimes(1);
    expect(h.updateSeriesMetadata).toHaveBeenCalledWith('One Piece', {
      titles: { romaji: 'Wan Pisu' }
    });
    expect(document.activeElement).not.toBe(romaji);
  });

  it('parses comma- and newline-separated synonyms, trims, dedupes and drops blanks', async () => {
    const { getByLabelText } = renderEditor();
    const synonyms = getByLabelText('Synonyms') as HTMLTextAreaElement;
    await fireEvent.input(synonyms, {
      target: { value: ' OP, Wanpiisu\nOP\n , \nMugiwara ' }
    });
    await fireEvent.blur(synonyms);
    expect(h.updateSeriesMetadata).toHaveBeenCalledWith('One Piece', {
      synonyms: ['OP', 'Wanpiisu', 'Mugiwara']
    });
  });

  it('also splits synonyms on full-width Japanese commas (\u3001 and \uff0c)', async () => {
    const { getByLabelText } = renderEditor();
    const synonyms = getByLabelText('Synonyms') as HTMLTextAreaElement;
    await fireEvent.input(synonyms, {
      target: { value: '\u30ef\u30f3\u30d4\u30fc\u30b9\u3001OP\uff0cMugiwara' }
    });
    await fireEvent.blur(synonyms);
    expect(h.updateSeriesMetadata).toHaveBeenCalledWith('One Piece', {
      synonyms: ['\u30ef\u30f3\u30d4\u30fc\u30b9', 'OP', 'Mugiwara']
    });
  });

  it('does not write synonyms on an unchanged blur', async () => {
    setMeta(meta({ synonyms: ['OP', 'Mugiwara'] }));
    const { getByLabelText } = renderEditor();
    const synonyms = getByLabelText('Synonyms') as HTMLTextAreaElement;
    await fireEvent.focus(synonyms);
    await fireEvent.blur(synonyms);
    expect(h.updateSeriesMetadata).not.toHaveBeenCalled();
  });

  it('does not clobber a dirty draft when the metadata store emits externally, but still syncs untouched fields', async () => {
    setMeta(meta({ titles: { native: 'ワンピース', english: 'One Piece' } }));
    const { getByLabelText } = renderEditor();
    const native = getByLabelText('Native') as HTMLInputElement;
    const english = getByLabelText('English') as HTMLInputElement;
    await fireEvent.input(native, { target: { value: 'Draft in progress' } });

    // Some other write to the record lands (e.g. the tag field, or another device via
    // sync) while the native field is still mid-edit.
    setMeta(meta({ titles: { native: 'ワンピース', english: 'One Piece (updated)' } }));
    await tick();

    expect(native.value).toBe('Draft in progress');
    expect(english.value).toBe('One Piece (updated)');
  });

  it('resets an in-progress draft to the freshly-saved value once its own save lands', async () => {
    const { getByLabelText } = renderEditor();
    const native = getByLabelText('Native') as HTMLInputElement;
    await fireEvent.input(native, { target: { value: 'ワンピース' } });
    await fireEvent.blur(native);
    await waitFor(() => expect(h.updateSeriesMetadata).toHaveBeenCalled());
    setMeta(meta({ titles: { native: 'ワンピース' } }));
    await waitFor(() => expect(native.value).toBe('ワンピース'));
  });

  it('keeps the NEW value in a title field while its write is still in flight, instead of reverting to the old value first', async () => {
    // Regression: `nativeDirty` used to clear BEFORE the `await updateSeriesMetadata(...)`,
    // so the resync effect fired immediately and snapped the field back to the OLD stored
    // value the instant the write started, then jumped to the new value once the write's
    // own echo landed. The dirty flag must stay set for the whole time the write is pending.
    setMeta(meta({ titles: { native: 'Old' } }));
    let resolveWrite!: () => void;
    h.updateSeriesMetadata.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          resolveWrite = () => resolve(undefined);
        })
    );
    const { getByLabelText } = renderEditor();
    const native = getByLabelText('Native') as HTMLInputElement;
    await fireEvent.input(native, { target: { value: 'New' } });
    await fireEvent.blur(native);

    // The write is still pending here — must NOT have reverted to 'Old'.
    expect(native.value).toBe('New');

    // The write lands and the liveQuery echoes the new value back.
    resolveWrite();
    setMeta(meta({ titles: { native: 'New' } }));
    await waitFor(() => expect(native.value).toBe('New'));
  });

  it('keeps the NEW value in the synonyms field while its write is still in flight', async () => {
    setMeta(meta({ synonyms: ['Old'] }));
    let resolveWrite!: () => void;
    h.updateSeriesMetadata.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          resolveWrite = () => resolve(undefined);
        })
    );
    const { getByLabelText } = renderEditor();
    const synonyms = getByLabelText('Synonyms') as HTMLTextAreaElement;
    await fireEvent.input(synonyms, { target: { value: 'New' } });
    await fireEvent.blur(synonyms);

    expect(synonyms.value).toBe('New');

    resolveWrite();
    setMeta(meta({ synonyms: ['New'] }));
    await waitFor(() => expect(synonyms.value).toBe('New'));
  });

  it('leaves a title field dirty (draft preserved) when the write rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      setMeta(meta({ titles: { native: 'Old' } }));
      h.updateSeriesMetadata.mockRejectedValueOnce(new Error('dexie is out'));
      const { getByLabelText } = renderEditor();
      const native = getByLabelText('Native') as HTMLInputElement;
      await fireEvent.input(native, { target: { value: 'New' } });
      await fireEvent.blur(native);
      await waitFor(() => expect(consoleError).toHaveBeenCalled());

      // Still 'New': the failed write must not have cleared nativeDirty and let the resync
      // effect fall back to the stored 'Old' value.
      expect(native.value).toBe('New');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('D1: does not wipe a sibling field being edited while another field save is in flight', async () => {
    // Regression: `titles` is one wholesale-replaced object, so ANY field's blur re-saves
    // the whole group. The old code cleared ALL THREE dirty flags once that write landed,
    // even for fields that were never part of it — wiping an in-progress edit on a sibling
    // field the instant the unrelated write resolved.
    setMeta(meta({ titles: {} }));
    let resolveNativeWrite!: () => void;
    h.updateSeriesMetadata.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          resolveNativeWrite = () => resolve(undefined);
        })
    );
    const { getByLabelText } = renderEditor();
    const native = getByLabelText('Native') as HTMLInputElement;
    const romaji = getByLabelText('Romaji') as HTMLInputElement;

    await fireEvent.input(native, { target: { value: 'Native Title' } });
    await fireEvent.blur(native); // kicks off the delayed write for { native: 'Native Title' }
    await waitFor(() => expect(h.updateSeriesMetadata).toHaveBeenCalledTimes(1));

    // While that write is still pending, the user starts typing into Romaji.
    await fireEvent.input(romaji, { target: { value: 'Romaji Title' } });

    // Native's write lands, and the liveQuery echoes the committed value back.
    resolveNativeWrite();
    setMeta(meta({ titles: { native: 'Native Title' } }));
    await waitFor(() => expect(native.value).toBe('Native Title'));

    // The Romaji draft must have survived settling Native's write.
    expect(romaji.value).toBe('Romaji Title');

    // Blurring Romaji now persists BOTH fields together — the second write.
    await fireEvent.blur(romaji);
    await waitFor(() => expect(h.updateSeriesMetadata).toHaveBeenCalledTimes(2));
    expect(h.updateSeriesMetadata).toHaveBeenNthCalledWith(2, 'One Piece', {
      titles: { native: 'Native Title', romaji: 'Romaji Title' }
    });
  });

  it('D2: does not write once seriesTitle has gone blank by the time the field is blurred', async () => {
    // Regression: the host modal's Escape-close clears `seriesTitle` in its store before a
    // still-focused field's blur fires, so the save used to run as `updateSeriesMetadata('',
    // ...)` — a junk record keyed `""`, and the edit lost.
    const { getByLabelText, rerender } = renderEditor();
    const native = getByLabelText('Native') as HTMLInputElement;
    await fireEvent.input(native, { target: { value: 'New Title' } });

    await rerender({ seriesTitle: '' });
    await fireEvent.blur(native);

    expect(h.updateSeriesMetadata).not.toHaveBeenCalled();
  });

  it('D2: does not write once seriesTitle has changed to a different series by the time the field is blurred', async () => {
    const { getByLabelText, rerender } = renderEditor();
    const native = getByLabelText('Native') as HTMLInputElement;
    await fireEvent.input(native, { target: { value: 'New Title' } });

    await rerender({ seriesTitle: 'Some Other Series' });
    await fireEvent.blur(native);

    expect(h.updateSeriesMetadata).not.toHaveBeenCalled();
  });
});
