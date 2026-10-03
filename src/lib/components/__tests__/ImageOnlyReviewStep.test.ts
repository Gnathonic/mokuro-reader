import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { get } from 'svelte/store';

const { existingVolumeCount } = vi.hoisted(() => ({
  existingVolumeCount: vi.fn(async (_series: string, _exclude?: Iterable<string>) => 0)
}));
vi.mock('$lib/import/library-series', () => ({
  existingVolumeCount,
  listLibrarySeries: vi.fn(async () => [])
}));

import ImageOnlyReviewStep from '../ImageOnlyReviewStep.svelte';
import { groupCandidates, type ReviewGroup } from '$lib/import/image-only-review';
import { miscSettings } from '$lib/settings/misc';

const candidate = (id: string, path: string) => ({
  id,
  basePath: path,
  titlePath: path,
  source: `picked/${path}`
});

function chainedGroup(existingCount = 0, series = 'Chained Soldier (Semi-Color)'): ReviewGroup {
  const [group] = groupCandidates([
    candidate('c1', `${series}/01`),
    candidate('c2', `${series}/02`),
    candidate('c3', `${series}/03`)
  ]);
  return { ...group, existingCount };
}

function renderStep(props: Record<string, unknown> = {}) {
  const onDecide = vi.fn();
  const onSkipAll = vi.fn();
  const utils = render(ImageOnlyReviewStep, {
    props: {
      group: chainedGroup(),
      step: 1,
      total: 2,
      library: [],
      initialMode: 'cleaned',
      onDecide,
      onSkipAll,
      ...props
    }
  });
  const q = <T extends Element>(id: string) =>
    utils.container.querySelector<T>(`[data-testid="${id}"]`)!;
  const names = () =>
    [
      ...utils.container.querySelectorAll<HTMLInputElement>('[data-testid="review-volume-name"]')
    ].map((i) => i.value);
  const nameInputs = () => [
    ...utils.container.querySelectorAll<HTMLInputElement>('[data-testid="review-volume-name"]')
  ];
  return { ...utils, onDecide, onSkipAll, q, names, nameInputs };
}

describe('ImageOnlyReviewStep (#285)', () => {
  beforeEach(() => {
    existingVolumeCount.mockReset();
    existingVolumeCount.mockImplementation(async () => 0);
    miscSettings.set({ ...get(miscSettings), keepFolderNamesAsTitles: false });
  });
  afterEach(() => cleanup());

  it('shows the step, the series and each volume with its source', () => {
    const { q, names, container } = renderStep();
    expect(q('review-step').textContent?.trim()).toBe('Series 1 of 2');
    expect(q<HTMLInputElement>('review-series').value).toBe('Chained Soldier (Semi-Color)');
    expect(names()).toEqual([
      'Chained Soldier (Semi-Color) 01',
      'Chained Soldier (Semi-Color) 02',
      'Chained Soldier (Semi-Color) 03'
    ]);
    expect(
      [...container.querySelectorAll('[data-testid="review-volume-source"]')].map(
        (s) => s.textContent
      )
    ).toEqual([
      'picked/Chained Soldier (Semi-Color)/01',
      'picked/Chained Soldier (Semi-Color)/02',
      'picked/Chained Soldier (Semi-Color)/03'
    ]);
  });

  it('starts numbering after the volumes the series already has', () => {
    const { names } = renderStep({ group: chainedGroup(4) });
    expect(names()[0]).toBe('Chained Soldier (Semi-Color) 05');
  });

  it('folder names: literal names, and no start number', async () => {
    const { names, getByText, container } = renderStep();
    await fireEvent.click(getByText('Folder names'));
    expect(names()).toEqual(['01', '02', '03']);
    expect(container.querySelector('[data-testid="review-start"]')).toBeNull();
  });

  it('a renamed volume keeps its name through mode, start and series changes', async () => {
    const { names, nameInputs, getByText, q } = renderStep();
    await fireEvent.input(nameInputs()[2], { target: { value: 'Extra' } });
    await fireEvent.click(getByText('Folder names'));
    expect(names()).toEqual(['01', '02', 'Extra']);
    await fireEvent.click(getByText('Cleaned up'));
    await fireEvent.input(q('review-start'), { target: { value: '5' } });
    expect(names()).toEqual([
      'Chained Soldier (Semi-Color) 05',
      'Chained Soldier (Semi-Color) 06',
      'Extra'
    ]);
    await fireEvent.input(q('review-series'), { target: { value: 'Chained' } });
    expect(names()).toEqual(['Chained 05', 'Chained 06', 'Extra']);
  });

  it('choosing an existing series continues after its volumes', async () => {
    existingVolumeCount.mockImplementation(async (series: string) =>
      series === 'Killing Bites' ? 7 : 0
    );
    const { names, q } = renderStep();
    await fireEvent.input(q('review-series'), { target: { value: 'Killing Bites' } });
    await waitFor(() => expect(names()[0]).toBe('Killing Bites 08'));
    expect(existingVolumeCount).toHaveBeenLastCalledWith('Killing Bites', chainedGroup().ownUuids);
  });

  it('a start number the user typed survives a series change', async () => {
    existingVolumeCount.mockImplementation(async () => 7);
    const { names, q } = renderStep();
    await fireEvent.input(q('review-start'), { target: { value: '3' } });
    await fireEvent.input(q('review-series'), { target: { value: 'Killing Bites' } });
    await new Promise((r) => setTimeout(r, 300));
    expect(names()[0]).toBe('Killing Bites 03');
  });

  it("a series typed in another case snaps to the library's spelling on blur", async () => {
    const { q } = renderStep({ library: [{ title: 'Killing Bites', count: 2 }] });
    await fireEvent.input(q('review-series'), { target: { value: 'killing bites' } });
    await fireEvent.blur(q('review-series'));
    expect(q<HTMLInputElement>('review-series').value).toBe('Killing Bites');
  });

  it("an untouched series folder named in another case takes the library's spelling", async () => {
    const { q } = renderStep({
      group: chainedGroup(0, 'killing bites'),
      library: [{ title: 'Killing Bites', count: 2 }]
    });
    await waitFor(() => expect(q<HTMLInputElement>('review-series').value).toBe('Killing Bites'));
  });

  it('Import right after a case-variant series (blur, then click) continues the library series', async () => {
    existingVolumeCount.mockImplementation(async (series: string) =>
      series === 'Killing Bites' ? 7 : 0
    );
    const { q, getByText, onDecide } = renderStep({
      library: [{ title: 'Killing Bites', count: 7 }]
    });
    await fireEvent.input(q('review-series'), { target: { value: 'killing bites' } });
    // The debounced lookup for the case variant lands first (exact match: 0 → start 1)…
    await new Promise((r) => setTimeout(r, 300));
    // …then a click on Import: its mousedown blurs the field, the click follows at once.
    await fireEvent.blur(q('review-series'));
    await fireEvent.click(getByText('Import'));
    await waitFor(() => expect(onDecide).toHaveBeenCalledTimes(1));
    expect(onDecide.mock.calls[0][0].naming).toMatchObject({ series: 'Killing Bites', start: 8 });
  });

  it('Import before any lookup ran canonicalizes and counts the series it imports', async () => {
    existingVolumeCount.mockImplementation(async (series: string) =>
      series === 'Killing Bites' ? 7 : 0
    );
    const { q, getByText, onDecide } = renderStep({
      library: [{ title: 'Killing Bites', count: 7 }]
    });
    await fireEvent.input(q('review-series'), { target: { value: 'killing bites' } });
    await fireEvent.click(getByText('Import'));
    await waitFor(() => expect(onDecide).toHaveBeenCalledTimes(1));
    expect(onDecide.mock.calls[0][0].naming).toMatchObject({ series: 'Killing Bites', start: 8 });
  });

  it('a typed start is never replaced by the lookup Import waits on', async () => {
    existingVolumeCount.mockImplementation(async () => 7);
    const { q, getByText, onDecide } = renderStep();
    await fireEvent.input(q('review-start'), { target: { value: '3' } });
    await fireEvent.input(q('review-series'), { target: { value: 'Killing Bites' } });
    await fireEvent.click(getByText('Import'));
    await waitFor(() => expect(onDecide).toHaveBeenCalledTimes(1));
    expect(onDecide.mock.calls[0][0].naming.start).toBe(3);
  });

  it('a step torn down while Import waits on its count decides nothing', async () => {
    let release!: (n: number) => void;
    existingVolumeCount.mockImplementation(() => new Promise<number>((r) => (release = r)));
    const { q, getByText, onDecide, unmount } = renderStep();
    await fireEvent.input(q('review-series'), { target: { value: 'Killing Bites' } });
    await fireEvent.click(getByText('Import'));
    unmount();
    release(7);
    await new Promise((r) => setTimeout(r, 300));
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('Import clicked twice while waiting decides once', async () => {
    existingVolumeCount.mockImplementation(async () => 7);
    const { q, getByText, onDecide } = renderStep();
    await fireEvent.input(q('review-series'), { target: { value: 'Killing Bites' } });
    await fireEvent.click(getByText('Import'));
    await fireEvent.click(getByText('Import'));
    await fireEvent.click(getByText('Skip'));
    await new Promise((r) => setTimeout(r, 50));
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide.mock.calls[0][0].action).toBe('import');
  });

  it('offers the library series as suggestions', () => {
    const { container } = renderStep({ library: [{ title: 'Killing Bites', count: 2 }] });
    const option = container.querySelector('datalist option') as HTMLOptionElement;
    expect(option.value).toBe('Killing Bites');
    expect(option.textContent).toContain('2 volumes');
  });

  it('a cleared volume name falls back to the generated one, never an empty title', async () => {
    const { names, nameInputs, getByText, onDecide } = renderStep();
    await fireEvent.input(nameInputs()[0], { target: { value: '' } });
    await fireEvent.blur(nameInputs()[0]);
    expect(names()[0]).toBe('Chained Soldier (Semi-Color) 01');
    await fireEvent.click(getByText('Import'));
    expect(onDecide.mock.calls[0][0].naming.overrides).toEqual({});
  });

  it('Import hands over the choices and remembers the mode', async () => {
    const { getByText, nameInputs, onDecide } = renderStep();
    await fireEvent.click(getByText('Folder names'));
    await fireEvent.input(nameInputs()[1], { target: { value: 'Two' } });
    await fireEvent.click(getByText('Import'));
    expect(onDecide).toHaveBeenCalledWith({
      action: 'import',
      naming: {
        series: 'Chained Soldier (Semi-Color)',
        mode: 'folder',
        start: 1,
        overrides: { c2: 'Two' }
      }
    });
    expect(get(miscSettings).keepFolderNamesAsTitles).toBe(true);
  });

  it('starts in the last mode used', () => {
    miscSettings.set({ ...get(miscSettings), keepFolderNamesAsTitles: true });
    const { names } = renderStep({ initialMode: 'folder' });
    expect(names()).toEqual(['01', '02', '03']);
  });

  it('cannot import with no series name', async () => {
    const { q, getByText, onDecide } = renderStep();
    await fireEvent.input(q('review-series'), { target: { value: '   ' } });
    expect((getByText('Import') as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.click(getByText('Import'));
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('Skip skips this series; Skip all remaining and close skip everything left', async () => {
    const { getByText, q, onDecide, onSkipAll } = renderStep();
    await fireEvent.click(getByText('Skip'));
    expect(onDecide).toHaveBeenCalledWith({ action: 'skip' });
    await fireEvent.click(getByText('Skip all remaining'));
    await fireEvent.click(q('review-close'));
    expect(onSkipAll).toHaveBeenCalledTimes(2);
  });

  it('offers "Skip all remaining" only while more series follow', () => {
    const { queryByText } = renderStep({ step: 2, total: 2 });
    expect(queryByText('Skip all remaining')).toBeNull();
  });

  it('keeps the buttons in a stacking context above the dialog body (night mode)', () => {
    const { getByText } = renderStep();
    const row = getByText('Import').closest('div.relative')!;
    expect(row.className).toContain('z-10');
  });

  it('lays the volumes out in one scrolling column', () => {
    const { q } = renderStep();
    expect(q('review-volumes').className).toContain('overflow-y-auto');
  });
});
