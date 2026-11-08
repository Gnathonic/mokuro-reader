<script lang="ts" module>
  // Where the drawer was scrolled to, per context (the reader's drawer holds
  // other sections than the catalog's), for this page session (#363: the page
  // image controls sit at the bottom of the reader section, and the drawer is
  // rebuilt — scrolled to the top — every time it opens).
  const savedScrollTop = new Map<string, number>();
</script>

<script lang="ts">
  import { Accordion, Button, Drawer } from 'flowbite-svelte';
  import { UserSettingsSolid } from 'flowbite-svelte-icons';
  import { sineIn } from 'svelte/easing';
  import { resetSettings } from '$lib/settings';
  import { isReader, promptConfirmation } from '$lib/util';
  import { currentView } from '$lib/util/hash-router';
  import AnkiConnectSettings from './AnkiConnectSettings.svelte';
  import ReaderSettings from './Reader/ReaderSettings.svelte';
  import Profiles from './Profiles/Profiles.svelte';
  import CatalogSettings from './CatalogSettings.svelte';
  import MetadataSettings from './MetadataSettings.svelte';
  import Stats from './Stats.svelte';
  import VolumeDefaults from './Volume/VolumeDefaults.svelte';
  import About from './About.svelte';
  import QuickAccess from './QuickAccess.svelte';
  import AppearanceSettings from './AppearanceSettings.svelte';
  import { pageAdjustPreviewing } from '$lib/reader/page-adjust-preview';

  let transitionParams = {
    x: 320,
    duration: 200,
    easing: sineIn
  };

  interface Props {
    open?: boolean;
  }

  // In Svelte 5, we need to make sure the open prop is properly bindable
  let { open = $bindable(false) }: Props = $props();

  function onReset() {
    open = false;
    promptConfirmation('Restore default settings?', resetSettings);
  }

  function onClose() {
    open = false;
  }

  // Handle backdrop mousedown - dismiss on mousedown outside content, not mouseup
  function handleBackdropMousedown(ev: MouseEvent & { currentTarget: HTMLDialogElement }) {
    const dlg = ev.currentTarget;
    if (ev.target === dlg) {
      // Click is on the backdrop (dialog element itself, not content)
      const rect = dlg.getBoundingClientRect();
      const clickedInContent =
        ev.clientX >= rect.left &&
        ev.clientX <= rect.right &&
        ev.clientY >= rect.top &&
        ev.clientY <= rect.bottom;

      if (!clickedInContent) {
        open = false;
      }
    }
  }

  // Reopen where the user left off. The dialog focuses its first control on
  // open (a microtask, which scrolls that control into view), so the restore
  // waits a frame to land after it.
  function rememberScroll(dlg: HTMLElement) {
    const key = isReader() ? 'reader' : 'app';
    const saved = savedScrollTop.get(key) ?? 0;
    const raf = saved > 0 ? requestAnimationFrame(() => (dlg.scrollTop = saved)) : 0;
    const onScroll = () => savedScrollTop.set(key, dlg.scrollTop);
    dlg.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      dlg.removeEventListener('scroll', onScroll);
    };
  }

  // Close drawer on navigation (hash route change)
  let previousViewType = $state($currentView.type);
  $effect(() => {
    const viewType = $currentView.type;
    if (viewType !== previousViewType) {
      previousViewType = viewType;
      if (open) {
        open = false;
      }
    }
  });
</script>

<Drawer
  placement="right"
  class="w-full md:w-1/2 lg:w-1/4"
  {transitionParams}
  bind:open
  id="settings"
  outsideclose={false}
  onmousedown={handleBackdropMousedown}
  data-page-preview={$pageAdjustPreviewing ? '' : undefined}
  {@attach rememberScroll}
>
  <h5
    id="drawer-label"
    class="mb-4 inline-flex items-center text-base font-semibold text-gray-900 dark:text-white"
  >
    <UserSettingsSolid class="mr-2.5 h-4 w-4" />Settings
  </h5>
  <div class="flex flex-col gap-5">
    <Accordion flush>
      <QuickAccess bind:open />
      <ReaderSettings />
      {#if !isReader()}
        <VolumeDefaults />
      {/if}
      <Profiles {onClose} />
      <AnkiConnectSettings />
      <CatalogSettings />
      <MetadataSettings />
      <AppearanceSettings />
      <Stats />
      <About />
    </Accordion>
    <div class="flex flex-col gap-2">
      <Button outline onclick={onReset}>Reset</Button>
      <Button outline onclick={onClose} color="light">Close</Button>
    </div>
  </div>
</Drawer>

<style>
  /* While a page image slider is being adjusted (#363) the page behind the
     drawer is what the user is judging: no dimming. Colour only — nothing
     moves, the drawer stays where it is. */
  :global(dialog#settings[data-page-preview]::backdrop) {
    background-color: transparent;
  }
</style>
