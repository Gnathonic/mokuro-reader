import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { get } from 'svelte/store';
import ConfirmationPopup from '../ConfirmationPopup.svelte';
import {
  confirmationPopupStore,
  promptConfirmation,
  promptConfirmationWith
} from '$lib/util/modals';

beforeEach(() => {
  localStorage.clear();
  confirmationPopupStore.set(undefined);
});
afterEach(() => cleanup());

async function open(show: () => void) {
  const view = render(ConfirmationPopup);
  show();
  await tick();
  await waitFor(() => expect(view.getByTestId('confirmation-popup')).toBeTruthy());
  return view;
}

describe('ConfirmationPopup', () => {
  it('keeps the plain Yes / No question as it was', async () => {
    const onConfirm = vi.fn();
    const view = await open(() => promptConfirmation('Delete Volume 9 from WebDAV?', onConfirm));
    expect(view.getByText('Delete Volume 9 from WebDAV?')).toBeTruthy();
    expect(view.queryByTestId('confirmation-source')).toBeNull();
    expect(view.queryByTestId('confirmation-warnings')).toBeNull();
    await fireEvent.click(view.getByRole('button', { name: 'Yes' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(get(confirmationPopupStore)?.open).toBe(false);
  });

  it('shows the source host large, the warnings and notes, and its own button labels', async () => {
    const view = await open(() =>
      promptConfirmationWith({
        message: 'Import Dr Stone 01 into your catalog?',
        source: { label: 'Downloads from', values: ['192.168.1.20:8080'] },
        warnings: ['192.168.1.20:8080 does not use a secure connection (https).'],
        notes: ['Only continue if you trust this site.'],
        confirmLabel: 'Import',
        cancelLabel: 'Cancel'
      })
    );
    const source = view.getByTestId('confirmation-source');
    expect(source.textContent).toContain('Downloads from');
    expect(source.textContent).toContain('192.168.1.20:8080');
    expect(view.getByTestId('confirmation-warnings').textContent).toContain(
      'does not use a secure connection'
    );
    expect(view.getByRole('alert')).toBeTruthy();
    expect(view.getByTestId('confirmation-notes').textContent).toContain('trust this site');
    expect(view.getByRole('button', { name: 'Import' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('puts the buttons above the dialog’s stacking context (relative z-10)', async () => {
    const view = await open(() => promptConfirmation('Sure?'));
    const container = view.getByRole('button', { name: 'Yes' }).parentElement!;
    expect(container.className).toContain('relative');
    expect(container.className).toContain('z-10');
  });

  it('marks the cancel button for focus when asked, so a stray Enter declines', async () => {
    const view = await open(() =>
      promptConfirmationWith({ message: 'Import?', focusCancel: true })
    );
    expect(view.getByRole('button', { name: 'No' }).hasAttribute('data-autofocus')).toBe(true);
    expect(view.getByRole('button', { name: 'Yes' }).hasAttribute('data-autofocus')).toBe(false);
  });

  it('an unremembered checkbox starts at its default every time and is never stored', async () => {
    const setItem = vi.spyOn(localStorage, 'setItem');
    const onConfirm = vi.fn();
    const show = () =>
      promptConfirmationWith({
        message: 'Import?',
        checkboxOption: { label: 'Let this link update the series info', defaultValue: false },
        onConfirm
      });
    const view = await open(show);
    const box = view.getByLabelText('Let this link update the series info') as HTMLInputElement;
    expect(box.checked).toBe(false);
    await fireEvent.click(box);
    await fireEvent.click(view.getByRole('button', { name: 'Yes' }));
    expect(onConfirm).toHaveBeenCalledWith(true, false);
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();

    show();
    await tick();
    await waitFor(() =>
      expect(
        (view.getByLabelText('Let this link update the series info') as HTMLInputElement).checked
      ).toBe(false)
    );
  });

  it('a remembered checkbox still loads and saves its answer', async () => {
    localStorage.setItem('deleteCloudPreference', 'true');
    const onConfirm = vi.fn();
    const view = await open(() =>
      promptConfirmation('Remove?', onConfirm, undefined, {
        label: 'Also delete from WebDAV?',
        storageKey: 'deleteCloudPreference',
        defaultValue: false
      })
    );
    const box = view.getByLabelText('Also delete from WebDAV?') as HTMLInputElement;
    expect(box.checked).toBe(true);
    await fireEvent.click(box);
    await fireEvent.click(view.getByRole('button', { name: 'Yes' }));
    expect(onConfirm).toHaveBeenCalledWith(false, false);
    expect(localStorage.getItem('deleteCloudPreference')).toBe('false');
  });

  it('No calls onCancel once, and never onConfirm', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const view = await open(() => promptConfirmation('Import?', onConfirm, onCancel));
    await fireEvent.click(view.getByRole('button', { name: 'No' }));
    await tick();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('dismissing it any other way (Escape, a click outside) is a no, and the caller hears it', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const view = await open(() => promptConfirmation('Import?', onConfirm, onCancel));
    const dialog = view.container.ownerDocument.querySelector('dialog')!;
    dialog.close();
    await tick();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(get(confirmationPopupStore)?.open).toBe(false);
  });

  it('Yes is not followed by a phantom cancel when the dialog closes', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const view = await open(() => promptConfirmation('Import?', onConfirm, onCancel));
    await fireEvent.click(view.getByRole('button', { name: 'Yes' }));
    await tick();
    await tick();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });
});
