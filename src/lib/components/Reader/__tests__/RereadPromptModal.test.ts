import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import type { VolumeMetadata } from '$lib/types';

const restartSeries = vi.fn();
const dismissRereadForSession = vi.fn();
const suppressRereadPrompt = vi.fn();
vi.mock('$lib/metadata/reread', () => ({
  restartSeries: (...args: unknown[]) => restartSeries(...args),
  dismissRereadForSession: (...args: unknown[]) => dismissRereadForSession(...args),
  suppressRereadPrompt: (...args: unknown[]) => suppressRereadPrompt(...args)
}));

const showSnackbar = vi.fn();
vi.mock('$lib/util', () => ({ showSnackbar: (...args: unknown[]) => showSnackbar(...args) }));

import RereadPromptModal from '../RereadPromptModal.svelte';

const seriesVolumes: VolumeMetadata[] = [
  { volume_uuid: 'a', volume_title: 'Vol 01', series_title: 'One Piece', series_uuid: 's' } as any
];

const baseProps = {
  open: true,
  seriesTitle: 'One Piece',
  seriesKey: 'one piece',
  seriesVolumes,
  displayTitle: 'One Piece'
};

describe('RereadPromptModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restartSeries.mockResolvedValue(undefined);
    // `suppressRereadPrompt` returns void: it writes the flag to the
    // reading-state store synchronously, with no promise to await.
    suppressRereadPrompt.mockImplementation(() => {});
  });

  it('shows the display title and all three actions', () => {
    const { getByText } = render(RereadPromptModal, { props: { ...baseProps } });
    expect(getByText('One Piece', { exact: false })).toBeTruthy();
    expect(getByText('Restart series')).toBeTruthy();
    expect(getByText('Not now')).toBeTruthy();
    expect(getByText("Don't ask for this series")).toBeTruthy();
  });

  it('"Restart series" calls restartSeries with the series title and local volumes, then closes', async () => {
    const { getByText } = render(RereadPromptModal, { props: { ...baseProps } });

    await fireEvent.click(getByText('Restart series'));

    await waitFor(() => expect(restartSeries).toHaveBeenCalledWith('One Piece', seriesVolumes));
    expect(dismissRereadForSession).not.toHaveBeenCalled();
    expect(suppressRereadPrompt).not.toHaveBeenCalled();
  });

  it('"Not now" dismisses for the session without restarting or suppressing', async () => {
    const { getByText } = render(RereadPromptModal, { props: { ...baseProps } });

    await fireEvent.click(getByText('Not now'));

    expect(dismissRereadForSession).toHaveBeenCalledWith('one piece');
    expect(restartSeries).not.toHaveBeenCalled();
    expect(suppressRereadPrompt).not.toHaveBeenCalled();
  });

  it('"Don\'t ask for this series" dismisses the session AND persists the suppression', async () => {
    const { getByText } = render(RereadPromptModal, { props: { ...baseProps } });

    await fireEvent.click(getByText("Don't ask for this series"));

    expect(dismissRereadForSession).toHaveBeenCalledWith('one piece');
    // Synchronous: by the time the click handler returns, the flag is written.
    expect(suppressRereadPrompt).toHaveBeenCalledWith('One Piece');
    expect(restartSeries).not.toHaveBeenCalled();
  });

  it('keeps the action buttons in a stacking context above the dialog body (night-mode filter)', () => {
    const { getByText } = render(RereadPromptModal, { props: { ...baseProps } });
    const row = getByText('Not now').closest('div.flex')!;
    expect(row.className).toContain('relative');
    expect(row.className).toContain('z-10');
  });

  it('autofocuses "Not now", not the first button (Escape/Enter reflex must not silently suppress the series)', () => {
    const { getByText } = render(RereadPromptModal, { props: { ...baseProps } });
    expect(getByText('Not now').hasAttribute('data-autofocus')).toBe(true);
    expect(getByText("Don't ask for this series").hasAttribute('data-autofocus')).toBe(false);
    expect(getByText('Restart series').hasAttribute('data-autofocus')).toBe(false);
  });

  it('blocks page-turn/scroll keys (e.g. ArrowRight) from reaching bubble-phase window listeners while open', () => {
    // Reader.svelte's own shortcut handler AND VerticalScrollReader/
    // HorizontalScrollReader's `<svelte:window onkeydown>` listeners are all
    // bubble-phase window listeners underneath this modal. The modal's guard
    // is a capture-phase window listener that calls stopPropagation() for
    // these keys, so a real keydown bubbling up from inside the dialog must
    // never reach any bubble-phase listener on window.
    const bubbleListener = vi.fn();
    window.addEventListener('keydown', bubbleListener);
    render(RereadPromptModal, { props: { ...baseProps } });

    const event = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true
    });
    document.body.dispatchEvent(event);

    expect(bubbleListener).not.toHaveBeenCalled();
    window.removeEventListener('keydown', bubbleListener);
  });
});
