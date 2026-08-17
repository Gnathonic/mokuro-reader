import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/svelte';
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
    updateSeriesMetadata: vi.fn(async () => undefined)
  };
});

vi.mock('$lib/metadata/store', () => ({
  seriesMetadataMap: h.seriesMetadataMap,
  updateSeriesMetadata: h.updateSeriesMetadata
}));

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
    setMeta(meta({ titles: { native: 'ワンピース' } }));
    await tick();
    expect(native.value).toBe('ワンピース');
  });
});
