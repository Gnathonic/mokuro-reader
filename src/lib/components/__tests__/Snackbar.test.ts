import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import Snackbar from '../Snackbar.svelte';
import { snackbarStore } from '$lib/util/snackbar';

describe('Snackbar', () => {
  afterEach(() => {
    snackbarStore.set(undefined);
    cleanup();
  });

  it('pins the toast to the viewport, not to the page', async () => {
    // flowbite's Toast `position` prop positions the toast ABSOLUTELY, against
    // the page. On a tracker or catalog scrolled a screen or more, a message
    // raised by a click rendered hundreds of pixels above the viewport and was
    // never seen. A toast is viewport furniture: it has to be fixed.
    snackbarStore.set({ visible: true, message: 'Volume 1 is not on this device.' });
    const { container } = render(Snackbar);
    await tick();

    const toast = container.querySelector('[role="alert"]')!;
    expect(toast).not.toBeNull();
    expect(toast.textContent).toContain('Volume 1 is not on this device.');
    const classes = toast.className.split(/\s+/);
    expect(classes).toContain('fixed');
    expect(classes).not.toContain('absolute');
  });
});
