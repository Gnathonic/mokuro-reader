import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';

const { executeRenameSeries } = vi.hoisted(() => ({ executeRenameSeries: vi.fn() }));
vi.mock('$lib/util/series-rename', () => ({ executeRenameSeries }));

import SeriesRenameField from '../SeriesRenameField.svelte';

type RenameFieldProps = {
  seriesTitle: string;
  seriesUuid: string;
  onRenamed: (finalTitle: string) => void;
  canRename?: boolean;
};

function renderField(props: Partial<RenameFieldProps> = {}) {
  return render(SeriesRenameField, {
    props: {
      seriesTitle: 'Berserk',
      seriesUuid: 'series-berserk',
      onRenamed: vi.fn(),
      ...props
    }
  });
}

describe('SeriesRenameField', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    executeRenameSeries.mockReset();
  });

  it('treats a renamedCount-0/no-failures result as nothing to rename, not success', async () => {
    // A placeholder-only (cloud-only) series has no local row for executeRenameSeries to
    // touch, so it resolves with success-shaped zeros instead of throwing or reporting a
    // failure. The field must not treat that as a completed rename.
    executeRenameSeries.mockResolvedValue({
      finalTitle: 'Berserk Deluxe',
      renamedCount: 0,
      failures: []
    });
    const onRenamed = vi.fn();

    const { getByDisplayValue, getByText } = renderField({ onRenamed });

    await fireEvent.input(getByDisplayValue('Berserk'), { target: { value: 'Berserk Deluxe' } });
    await fireEvent.click(getByText('Save'));

    await waitFor(() => expect(executeRenameSeries).toHaveBeenCalled());
    await waitFor(() => expect(getByText('Nothing to rename')).toBeTruthy());
    expect(onRenamed).not.toHaveBeenCalled();
  });

  it('still reports success when at least one volume was renamed', async () => {
    executeRenameSeries.mockResolvedValue({
      finalTitle: 'Berserk Deluxe',
      renamedCount: 1,
      failures: []
    });
    const onRenamed = vi.fn();

    const { getByDisplayValue, getByText } = renderField({ onRenamed });

    await fireEvent.input(getByDisplayValue('Berserk'), { target: { value: 'Berserk Deluxe' } });
    await fireEvent.click(getByText('Save'));

    await waitFor(() => expect(onRenamed).toHaveBeenCalledWith('Berserk Deluxe'));
  });

  it('disables the input and buttons and shows a hint when canRename is false', async () => {
    const { getByDisplayValue, getByText } = renderField({ canRename: false });

    const input = getByDisplayValue('Berserk') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(getByText('Download a volume to rename')).toBeTruthy();

    await fireEvent.input(input, { target: { value: 'Berserk Deluxe' } });
    await fireEvent.click(getByText('Save'));

    expect(executeRenameSeries).not.toHaveBeenCalled();
  });
});
