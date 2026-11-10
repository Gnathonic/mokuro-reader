import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import ReaderNotification, {
  NOTICE_MS,
  NOTICE_WITH_ACTION_MS,
  type ReaderNotice
} from '../ReaderNotification.svelte';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

let seq = 0;
const notice = (over: Partial<ReaderNotice> = {}): ReaderNotice => ({
  message: 'Bold font: On',
  key: 'set-bold',
  seq: ++seq,
  ...over
});

const withButton = (run = vi.fn()) =>
  notice({
    message: 'Night Mode is on automatic schedule',
    key: 'set-night-scheduled',
    action: { label: 'Set to manual', run }
  });

describe('ReaderNotification', () => {
  it('shows nothing without a notice', () => {
    const { container } = render(ReaderNotification, { notice: null, onDone: vi.fn() });
    expect(container.querySelector('[data-reader-notification]')).toBeNull();
  });

  it('a plain message has no button and is done after 2 s', async () => {
    const onDone = vi.fn();
    const { container, getByText } = render(ReaderNotification, { notice: notice(), onDone });
    expect(getByText('Bold font: On')).toBeTruthy();
    expect(container.querySelector('button')).toBeNull();
    await vi.advanceTimersByTimeAsync(NOTICE_MS - 1);
    expect(onDone).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('a repeat of the same message restarts its time', async () => {
    const onDone = vi.fn();
    const { rerender } = render(ReaderNotification, { notice: notice(), onDone });
    await vi.advanceTimersByTimeAsync(NOTICE_MS - 100);
    await rerender({ notice: notice(), onDone });
    await vi.advanceTimersByTimeAsync(NOTICE_MS - 100);
    expect(onDone).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('a message with a button renders a real button and stays 5 s', async () => {
    const onDone = vi.fn();
    const { getByRole } = render(ReaderNotification, { notice: withButton(), onDone });
    const button = getByRole('button', { name: 'Set to manual' });
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    await vi.advanceTimersByTimeAsync(NOTICE_MS + 500);
    expect(onDone).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(NOTICE_WITH_ACTION_MS - NOTICE_MS - 500);
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('never takes focus, and a press on the button does not move it', async () => {
    const before = document.createElement('input');
    document.body.appendChild(before);
    before.focus();
    const { getByRole } = render(ReaderNotification, { notice: withButton(), onDone: vi.fn() });
    await tick();
    expect(document.activeElement).toBe(before);
    const button = getByRole('button', { name: 'Set to manual' });
    expect(button.hasAttribute('autofocus')).toBe(false);
    // The press that would move focus to the button is cancelled.
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    button.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(before);
    before.remove();
  });

  it('the button runs its action once and the notice is done', async () => {
    const run = vi.fn();
    const onDone = vi.fn();
    const { getByRole } = render(ReaderNotification, { notice: withButton(run), onDone });
    await fireEvent.click(getByRole('button', { name: 'Set to manual' }));
    expect(run).toHaveBeenCalledOnce();
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('stays while the pointer is on it, then takes its 5 s again', async () => {
    const onDone = vi.fn();
    const { container } = render(ReaderNotification, { notice: withButton(), onDone });
    const box = container.querySelector('[data-reader-notification]')!;
    await vi.advanceTimersByTimeAsync(NOTICE_WITH_ACTION_MS - 500);
    await fireEvent.pointerEnter(box);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onDone).not.toHaveBeenCalled();
    await fireEvent.pointerLeave(box);
    await vi.advanceTimersByTimeAsync(NOTICE_WITH_ACTION_MS - 1);
    expect(onDone).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('stays while keyboard focus is on its button', async () => {
    const onDone = vi.fn();
    const { getByRole } = render(ReaderNotification, { notice: withButton(), onDone });
    const button = getByRole('button', { name: 'Set to manual' });
    await fireEvent.focusIn(button);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onDone).not.toHaveBeenCalled();
    await fireEvent.focusOut(button);
    await vi.advanceTimersByTimeAsync(NOTICE_WITH_ACTION_MS);
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('a different notice replacing a held one does not inherit the hold', async () => {
    const onDone = vi.fn();
    const { container, rerender } = render(ReaderNotification, { notice: withButton(), onDone });
    await fireEvent.pointerEnter(container.querySelector('[data-reader-notification]')!);
    // A key press under the pointer: the element is replaced, no pointerleave fires.
    await rerender({ notice: notice({ message: 'Bold font: Off' }), onDone });
    expect(container.querySelector('[data-reader-notification]')?.textContent).toContain(
      'Bold font: Off'
    );
    await vi.advanceTimersByTimeAsync(NOTICE_MS);
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('a plain message is not held by the pointer', async () => {
    const onDone = vi.fn();
    const { container } = render(ReaderNotification, { notice: notice(), onDone });
    await fireEvent.pointerEnter(container.querySelector('[data-reader-notification]')!);
    await vi.advanceTimersByTimeAsync(NOTICE_MS);
    expect(onDone).toHaveBeenCalledOnce();
  });
});
