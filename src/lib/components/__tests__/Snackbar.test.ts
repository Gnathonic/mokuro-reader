import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import Snackbar from '../Snackbar.svelte';
import ProgressTracker from '../ProgressTracker.svelte';
import { snackbarStore } from '$lib/util/snackbar';
import { progressTrackerStore } from '$lib/util/progress-tracker';

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

  it('stacks above the progress tray, which shares its corner', async () => {
    // Both are fixed bottom-right. At equal z-index the tray, later in the
    // layout, covered every toast raised while anything was in progress —
    // an upload failure's notice included (seen live: elementFromPoint at the
    // toast's centre hit the tray's progress row).
    const zOf = (el: Element) => {
      const z = el.className.split(/\s+/).find((c) => /^z-(\d+|\[\d+\])$/.test(c));
      return z ? Number(z.replace(/^z-\[?|\]$/g, '')) : 0;
    };
    progressTrackerStore.addProcess({ id: 'p', description: 'Backing up Vol 2', progress: 40 });
    snackbarStore.set({ visible: true, message: 'Upload failed: Vol 2 — bad CRC' });
    const tray = render(ProgressTracker).container.querySelector('div.fixed')!;
    const toast = render(Snackbar).container.querySelector('[role="alert"]')!;
    await tick();
    expect(zOf(toast)).toBeGreaterThan(zOf(tray));
    progressTrackerStore.removeProcess('p');
  });
});
