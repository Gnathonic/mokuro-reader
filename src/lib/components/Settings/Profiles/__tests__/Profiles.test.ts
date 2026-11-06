import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { get } from 'svelte/store';

vi.mock('$app/environment', () => ({ browser: true }));
const ui = vi.hoisted(() => ({ promptConfirmation: vi.fn(), showSnackbar: vi.fn() }));
vi.mock('$lib/util', () => ui);

import { profiles, profilesWithTrash } from '$lib/settings';
import { resetAnkiUrlTrustForTest } from '$lib/anki-connect/url-trust';
import Profiles from '../Profiles.svelte';

/**
 * jsdom's FileReader only reads its own Blob class, and the test setup's File
 * is not that one: read through the file's own text() instead.
 */
class TextFileReader {
  result: string | null = null;
  onloadend: (() => void) | null = null;
  readAsText(file: Blob) {
    void file.text().then((text) => {
      this.result = text;
      this.onloadend?.();
    });
  }
}

/** Pick `content` as the profiles file and press Import. */
async function importFile(content: unknown) {
  const view = render(Profiles, { props: { onClose: vi.fn() } });
  // The section is an accordion: open it to reach the file picker.
  await fireEvent.click(view.getByText('Profile'));
  const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([JSON.stringify(content)], 'profiles.json', {
    type: 'application/json'
  });
  // jsdom cannot set a real FileList; bind:files also writes the property back.
  const picked = [file];
  Object.defineProperty(input, 'files', { configurable: true, get: () => picked, set: () => {} });
  await fireEvent.change(input);
  await fireEvent.click(view.getByText('Import profiles'));
  return view;
}

function mine(fontSize: number, url = 'http://127.0.0.1:8765') {
  return { fontSize, ankiConnectSettings: { url }, lastUpdated: '2026-10-01T00:00:00.000Z' };
}

beforeEach(() => {
  vi.stubGlobal('FileReader', TextFileReader);
  ui.promptConfirmation.mockReset();
  ui.showSnackbar.mockReset();
  localStorage.removeItem('anki_connect_confirmed_urls');
  resetAnkiUrlTrustForTest();
  profilesWithTrash.update((all) => {
    const next = { ...all };
    delete next['Imported'];
    delete next['Mine'];
    return next;
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('Import profiles', () => {
  it('warns before replacing a profile of the same name, and changes nothing until confirmed', async () => {
    profilesWithTrash.update((all) => ({ ...all, Mine: { ...all.Default, fontSize: 12 } as any }));

    await importFile({ Mine: mine(40) });

    await waitFor(() => expect(ui.promptConfirmation).toHaveBeenCalledTimes(1));
    expect(ui.promptConfirmation.mock.calls[0][0]).toContain('"Mine"');
    expect((get(profiles).Mine as any).fontSize).toBe(12);

    // The user confirms.
    ui.promptConfirmation.mock.calls[0][1]();
    expect((get(profiles).Mine as any).fontSize).toBe(40);
    expect(ui.showSnackbar).toHaveBeenCalledWith('Profiles imported');
  });

  it('a new profile name imports without asking', async () => {
    await importFile({ Imported: mine(33) });

    await waitFor(() => expect(ui.showSnackbar).toHaveBeenCalledWith('Profiles imported'));
    expect(ui.promptConfirmation).not.toHaveBeenCalled();
    expect((get(profiles).Imported as any).fontSize).toBe(33);
  });

  it('says an imported AnkiConnect URL needs confirming before it is used', async () => {
    await importFile({ Imported: mine(33, 'https://anki.example.com') });

    await waitFor(() =>
      expect(ui.showSnackbar).toHaveBeenCalledWith(
        expect.stringContaining('Confirm the AnkiConnect URL https://anki.example.com')
      )
    );
    // Stored as it came; the client refuses to send to it until confirmed.
    expect(get(profiles).Imported.ankiConnectSettings.url).toBe('https://anki.example.com');
  });

  it('names every unconfirmed AnkiConnect URL the file brings', async () => {
    await importFile({
      Imported: mine(33, 'https://anki.example.com'),
      Mine: mine(20, 'http://192.168.1.5:8765')
    });

    await waitFor(() => expect(ui.showSnackbar).toHaveBeenCalledTimes(1));
    const [notice] = ui.showSnackbar.mock.calls[0];
    expect(notice).toContain('https://anki.example.com');
    expect(notice).toContain('http://192.168.1.5:8765');
  });

  it('a file that is not a profiles export changes nothing', async () => {
    const before = JSON.stringify(get(profilesWithTrash));
    await importFile(['not', 'profiles']);

    await waitFor(() =>
      expect(ui.showSnackbar).toHaveBeenCalledWith('That file is not a profiles export')
    );
    expect(JSON.stringify(get(profilesWithTrash))).toBe(before);
  });
});
