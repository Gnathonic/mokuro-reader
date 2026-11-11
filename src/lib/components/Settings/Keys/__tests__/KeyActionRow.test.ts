import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import RowHarness from './RowHarness.svelte';

afterEach(() => cleanup());

function chips(container: HTMLElement) {
  return [...container.querySelectorAll('[data-key-chip]')].map((el) =>
    el.getAttribute('data-key-chip')
  );
}

async function record(container: HTMLElement, init: KeyboardEventInit) {
  await fireEvent.click(container.querySelector('[data-key-capture]')!);
  await tick();
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  document.body.dispatchEvent(e);
  await tick();
  return e;
}

describe('KeyActionRow', () => {
  it('shows the defaults as chips; recording a free key adds it (the #55 case)', async () => {
    const saved = vi.fn();
    const { container, getByText } = render(RowHarness, {
      id: 'reader.page-right',
      onSaved: saved
    });
    expect(chips(container)).toEqual(['ArrowRight']);
    await fireEvent.click(container.querySelector('[data-key-capture]')!);
    expect(getByText('Press a key… (Esc cancels)')).toBeTruthy();
    const e = new KeyboardEvent('keydown', {
      code: 'KeyD',
      key: 'd',
      bubbles: true,
      cancelable: true
    });
    document.body.dispatchEvent(e);
    await tick();
    expect(e.defaultPrevented).toBe(true);
    expect(saved).toHaveBeenLastCalledWith({ 'reader.page-right': ['ArrowRight', 'KeyD'] });
    expect(chips(container)).toEqual(['ArrowRight', 'KeyD']);
    // A modified row offers Reset, which brings the default back.
    await fireEvent.click(getByText('Reset'));
    expect(saved).toHaveBeenLastCalledWith({});
    expect(chips(container)).toEqual(['ArrowRight']);
  });

  it('announces recording to screen readers, and its cancel', async () => {
    const { container } = render(RowHarness, { id: 'reader.page-right', onSaved: vi.fn() });
    const live = () => container.querySelector('[aria-live="polite"]')!.textContent;
    await fireEvent.click(container.querySelector('[data-key-capture]')!);
    await tick();
    expect(live()).toBe('Press a key. Escape cancels.');
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', {
        code: 'Escape',
        key: 'Escape',
        bubbles: true,
        cancelable: true
      })
    );
    await tick();
    expect(live()).toBe('Recording cancelled.');
  });

  it('Escape cancels recording without saving', async () => {
    const saved = vi.fn();
    const { container, queryByText } = render(RowHarness, {
      id: 'reader.page-right',
      onSaved: saved
    });
    await record(container, { code: 'Escape', key: 'Escape' });
    expect(saved).not.toHaveBeenCalled();
    expect(queryByText('Press a key… (Esc cancels)')).toBeNull();
  });

  it('removing every chip leaves the action Not set', async () => {
    const saved = vi.fn();
    const { container, getByLabelText, getByText } = render(RowHarness, {
      id: 'reader.fullscreen',
      onSaved: saved
    });
    await fireEvent.click(getByLabelText('Remove KeyF from Fullscreen'));
    expect(saved).toHaveBeenLastCalledWith({ 'reader.fullscreen': [] });
    expect(chips(container)).toEqual([]);
    expect(getByText('Not set')).toBeTruthy();
  });

  it('a removed chip’s × and Reset leave focus in the row, on "+ Add"', async () => {
    const { container, getByLabelText, getByText } = render(RowHarness, {
      id: 'reader.fullscreen',
      onSaved: vi.fn()
    });
    const add = () => container.querySelector('[data-key-capture]');
    const remove = getByLabelText('Remove KeyF from Fullscreen');
    remove.focus();
    await fireEvent.click(remove);
    await tick();
    await tick();
    expect(remove.isConnected).toBe(false);
    expect(document.activeElement).toBe(add());

    const reset = getByText('Reset');
    reset.focus();
    await fireEvent.click(reset);
    await tick();
    await tick();
    expect(reset.isConnected).toBe(false);
    expect(document.activeElement).toBe(add());
  });

  it('a press from outside the row (a touch, a script) does not pull focus into it', async () => {
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    outside.focus();
    const { getByLabelText } = render(RowHarness, { id: 'reader.fullscreen', onSaved: vi.fn() });
    await fireEvent.click(getByLabelText('Remove KeyF from Fullscreen'));
    await tick();
    await tick();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('a conflict asks Replace or Cancel; Replace moves the key', async () => {
    const saved = vi.fn();
    const { container, getByText, queryByText } = render(RowHarness, {
      id: 'reader.page-right',
      onSaved: saved
    });
    await record(container, { code: 'ArrowDown', key: 'ArrowDown' });
    expect(
      getByText(/ArrowDown is already “Scroll down”/, { selector: ':not(.sr-only)' })
    ).toBeTruthy();
    await fireEvent.click(getByText('Cancel'));
    expect(saved).not.toHaveBeenCalled();
    expect(queryByText(/is already/, { selector: ':not(.sr-only)' })).toBeNull();

    await record(container, { code: 'ArrowDown', key: 'ArrowDown' });
    await fireEvent.click(getByText('Replace'));
    expect(saved).toHaveBeenLastCalledWith({
      'reader.scroll-down': [],
      'reader.page-right': ['ArrowRight', 'ArrowDown']
    });
  });

  it('a refused key says why and saves nothing', async () => {
    const saved = vi.fn();
    const { container, getByText } = render(RowHarness, {
      id: 'reader.page-right',
      onSaved: saved
    });
    await record(container, { code: 'KeyW', key: 'w', ctrlKey: true });
    expect(getByText(/The browser keeps this chord/, { selector: ':not(.sr-only)' })).toBeTruthy();
    expect(saved).not.toHaveBeenCalled();
  });

  it('warns about a Shift chord but adds it', async () => {
    const saved = vi.fn();
    const { container, getByText } = render(RowHarness, {
      id: 'reader.page-right',
      onSaved: saved
    });
    await record(container, { code: 'KeyD', key: 'D', shiftKey: true });
    expect(saved).toHaveBeenLastCalledWith({ 'reader.page-right': ['ArrowRight', 'Shift+KeyD'] });
    expect(getByText(/Dictionary pop-ups often scan/)).toBeTruthy();
  });

  it('Back keeps a locked Escape with no remove button', async () => {
    const { container, queryByLabelText } = render(RowHarness, { id: 'app.back' });
    expect(chips(container)).toEqual(['Escape']);
    expect(queryByLabelText(/Remove Escape/)).toBeNull();
    expect(container.querySelector('[aria-label="Always on"]')).toBeTruthy();
  });

  it('a new action starts Not set', () => {
    const { getByText } = render(RowHarness, { id: 'reader.timer' });
    expect(getByText('Not set')).toBeTruthy();
  });
});
