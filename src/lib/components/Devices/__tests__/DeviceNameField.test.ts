import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { deviceView } from './device-view';

const renameDevice = vi.hoisted(() => vi.fn());
vi.mock('$lib/settings/tracking-data', () => ({ renameDevice, DEVICE_NAME_MAX: 40 }));

import DeviceNameField from '../DeviceNameField.svelte';

beforeEach(() => renameDevice.mockClear());
afterEach(cleanup);

describe('DeviceNameField', () => {
  it('an unnamed device shows an empty field with its generated label as the placeholder', () => {
    const { getByLabelText } = render(DeviceNameField, { props: { device: deviceView('dev-a') } });
    const field = getByLabelText('Device name') as HTMLInputElement;
    expect(field.value).toBe('');
    expect(field.placeholder).toBe('Desktop · Linux · Firefox');
    expect(field.maxLength).toBe(40);
  });

  it('Enter saves the trimmed name and ends the edit', async () => {
    const onDone = vi.fn();
    const { getByLabelText } = render(DeviceNameField, {
      props: { device: deviceView('dev-a'), onDone }
    });
    const field = getByLabelText('Device name') as HTMLInputElement;
    await fireEvent.input(field, { target: { value: '  Pixel 8 ' } });
    await fireEvent.keyDown(field, { key: 'Enter' });
    expect(renameDevice).toHaveBeenCalledWith('dev-a', 'Pixel 8');
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('a named device shows its name; clearing it and saving goes back to the generated label', async () => {
    const device = deviceView('dev-a', { named: true, label: 'Pixel 8' });
    const { getByLabelText, getByRole } = render(DeviceNameField, { props: { device } });
    const field = getByLabelText('Device name') as HTMLInputElement;
    expect(field.value).toBe('Pixel 8');
    expect(field.placeholder).toBe('Desktop · Linux · Firefox');
    await fireEvent.input(field, { target: { value: '   ' } });
    await fireEvent.click(getByRole('button', { name: 'Save' }));
    expect(renameDevice).toHaveBeenCalledWith('dev-a', '');
  });

  it('Save on an unchanged name writes nothing but still ends the edit', async () => {
    const onDone = vi.fn();
    const device = deviceView('dev-a', { named: true, label: 'Pixel 8' });
    const { getByRole } = render(DeviceNameField, { props: { device, onDone } });
    await fireEvent.click(getByRole('button', { name: 'Save' }));
    expect(renameDevice).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('Escape reverts a draft and stops the key; on a clean field it ends the edit and lets the key through', async () => {
    const onDone = vi.fn();
    const device = deviceView('dev-a', { named: true, label: 'Pixel 8' });
    const { getByLabelText } = render(DeviceNameField, { props: { device, onDone } });
    const field = getByLabelText('Device name') as HTMLInputElement;
    expect(field.hasAttribute('data-escape-reverts')).toBe(false);
    await fireEvent.input(field, { target: { value: 'Pixel 9' } });
    expect(field.hasAttribute('data-escape-reverts')).toBe(true);
    // dispatchEvent returns false when the handler called preventDefault.
    expect(await fireEvent.keyDown(field, { key: 'Escape' })).toBe(false);
    expect(field.value).toBe('Pixel 8');
    expect(onDone).not.toHaveBeenCalled();
    expect(await fireEvent.keyDown(field, { key: 'Escape' })).toBe(true);
    expect(onDone).toHaveBeenCalledOnce();
    expect(renameDevice).not.toHaveBeenCalled();
  });

  it('a name arriving from sync replaces the shown name', async () => {
    const { getByLabelText, rerender } = render(DeviceNameField, {
      props: { device: deviceView('dev-a') }
    });
    await rerender({ device: deviceView('dev-a', { named: true, label: 'Kitchen tablet' }) });
    expect((getByLabelText('Device name') as HTMLInputElement).value).toBe('Kitchen tablet');
  });

  it('autofocus focuses the field on mount', () => {
    const { getByLabelText } = render(DeviceNameField, {
      props: { device: deviceView('dev-a'), autofocus: true }
    });
    expect(document.activeElement).toBe(getByLabelText('Device name'));
  });
});
