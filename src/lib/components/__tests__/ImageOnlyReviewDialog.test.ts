import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { get } from 'svelte/store';

vi.mock('$lib/import/library-series', () => ({
  listLibrarySeries: vi.fn(async () => [{ title: 'Killing Bites', count: 2 }]),
  existingVolumeCount: vi.fn(async () => 0)
}));

import ImageOnlyReviewDialog from '../ImageOnlyReviewDialog.svelte';
import { appendReviewGroups, reviewSession } from '$lib/import/review-session';
import { groupCandidates } from '$lib/import/image-only-review';

const groupOf = (series: string) =>
  groupCandidates([
    {
      id: `${series}-1`,
      basePath: `${series}/01`,
      titlePath: `${series}/01`,
      source: `${series}/01`
    }
  ])[0];
const stepText = () => document.querySelector('[data-testid="review-step"]')?.textContent?.trim();
const dialog = () => document.querySelector('[data-testid="image-only-review"]') as HTMLElement;

describe('ImageOnlyReviewDialog (#285)', () => {
  beforeEach(() => reviewSession.set({ pending: [], decided: 0 }));
  afterEach(() => cleanup());

  it('shows nothing while no review is pending', () => {
    render(ImageOnlyReviewDialog);
    expect(document.querySelector('[data-testid="review-step"]')).toBeNull();
  });

  it('steps through the series, one decision each — closing after the last decides nothing more', async () => {
    const onDecision = vi.fn();
    appendReviewGroups([groupOf('Alpha'), groupOf('Beta')], onDecision);
    const { getByText } = render(ImageOnlyReviewDialog);
    await waitFor(() => expect(stepText()).toBe('Series 1 of 2'));
    await fireEvent.click(getByText('Skip'));
    await waitFor(() => expect(stepText()).toBe('Series 2 of 2'));
    // A double click on Skip lands on the new step's Import: ignored.
    await fireEvent.click(getByText('Import'));
    expect(stepText()).toBe('Series 2 of 2');
    await waitFor(() =>
      expect(
        document.querySelector<HTMLElement>('[data-testid="review-step-body"]')?.dataset.armed
      ).toBe('true')
    );
    await fireEvent.click(getByText('Import'));
    await waitFor(() => expect(document.querySelector('[data-testid="review-step"]')).toBeNull());
    await new Promise((r) => setTimeout(r, 50));
    expect(onDecision.mock.calls.map(([, d]) => d.action)).toEqual(['skip', 'import']);
  });

  it('Escape skips everything still pending', async () => {
    const onDecision = vi.fn();
    appendReviewGroups([groupOf('Alpha'), groupOf('Beta')], onDecision);
    render(ImageOnlyReviewDialog);
    await waitFor(() => expect(stepText()).toBe('Series 1 of 2'));
    dialog().dispatchEvent(new Event('cancel', { cancelable: true }));
    await waitFor(() => expect(get(reviewSession).pending).toHaveLength(0));
    expect(onDecision.mock.calls.map(([, d]) => d.action)).toEqual(['skip', 'skip']);
  });

  it('a tap outside the dialog skips nothing', async () => {
    const onDecision = vi.fn();
    appendReviewGroups([groupOf('Alpha')], onDecision);
    render(ImageOnlyReviewDialog);
    await waitFor(() => expect(stepText()).toBe('Series 1 of 1'));
    await fireEvent.click(dialog(), { clientX: 0, clientY: 0 });
    expect(onDecision).not.toHaveBeenCalled();
    expect(stepText()).toBe('Series 1 of 1');
  });

  it('a review appended while it is open extends the count', async () => {
    appendReviewGroups([groupOf('Alpha')], vi.fn());
    render(ImageOnlyReviewDialog);
    await waitFor(() => expect(stepText()).toBe('Series 1 of 1'));
    appendReviewGroups([groupOf('Beta')], vi.fn());
    await waitFor(() => expect(stepText()).toBe('Series 1 of 2'));
  });

  it('first focus goes to Import, never the close button (Enter must not skip everything)', async () => {
    appendReviewGroups([groupOf('Alpha'), groupOf('Beta')], vi.fn());
    render(ImageOnlyReviewDialog);
    await waitFor(() => expect(document.activeElement?.textContent?.trim()).toBe('Import'));
  });

  it('each new step takes focus on its Import, not the skip-all close button', async () => {
    appendReviewGroups([groupOf('Alpha'), groupOf('Beta')], vi.fn());
    const { getByText } = render(ImageOnlyReviewDialog);
    await waitFor(() => expect(document.activeElement?.textContent?.trim()).toBe('Import'));
    await fireEvent.click(getByText('Skip'));
    await waitFor(() => expect(stepText()).toBe('Series 2 of 2'));
    await waitFor(() => expect(document.activeElement?.textContent?.trim()).toBe('Import'));
    expect(dialog().contains(document.activeElement)).toBe(true);
  });

  it('Escape that ends an IME composition skips nothing', async () => {
    const onDecision = vi.fn();
    appendReviewGroups([groupOf('Alpha'), groupOf('Beta')], onDecision);
    render(ImageOnlyReviewDialog);
    await waitFor(() => expect(stepText()).toBe('Series 1 of 2'));
    const field = document.querySelector('[data-testid="review-series"]')!;
    field.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const composingCancel = new Event('cancel', { cancelable: true });
    dialog().dispatchEvent(composingCancel);
    expect(composingCancel.defaultPrevented).toBe(true);
    field.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    // The same Escape may reach the dialog right after the composition ends.
    dialog().dispatchEvent(new Event('cancel', { cancelable: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(onDecision).not.toHaveBeenCalled();
    expect(stepText()).toBe('Series 1 of 2');
    // A later, plain Escape still skips everything.
    dialog().dispatchEvent(new Event('cancel', { cancelable: true }));
    await waitFor(() => expect(get(reviewSession).pending).toHaveLength(0));
    expect(onDecision.mock.calls.map(([, d]) => d.action)).toEqual(['skip', 'skip']);
  });

  it('an Escape keydown flagged as composing (isComposing / keyCode 229) skips nothing', async () => {
    const onDecision = vi.fn();
    appendReviewGroups([groupOf('Alpha')], onDecision);
    render(ImageOnlyReviewDialog);
    await waitFor(() => expect(stepText()).toBe('Series 1 of 1'));
    const name = document.querySelector('[data-testid="review-volume-name"]')!;
    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, ...init }));
      dialog().dispatchEvent(new Event('cancel', { cancelable: true }));
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(onDecision).not.toHaveBeenCalled();
    expect(stepText()).toBe('Series 1 of 1');
  });

  it('offers the library series to the series field', async () => {
    appendReviewGroups([groupOf('Alpha')], vi.fn());
    render(ImageOnlyReviewDialog);
    await waitFor(() =>
      expect(document.querySelector('datalist option')?.getAttribute('value')).toBe('Killing Bites')
    );
  });
});
