<script lang="ts">
  import { Accordion, Button, Drawer } from 'flowbite-svelte';
  import { UserSettingsSolid } from 'flowbite-svelte-icons';
  import { sineIn } from 'svelte/easing';
  import { resetSettings } from '$lib/settings';
  import { isReader, promptConfirmation } from '$lib/util';
  import AnkiConnectSettings from './AnkiConnectSettings.svelte';
  import ReaderSettings from './Reader/ReaderSettings.svelte';
  import Profiles from './Profiles/Profiles.svelte';
  import CatalogSettings from './CatalogSettings.svelte';
  import Stats from './Stats.svelte';
  import VolumeDefaults from './Volume/VolumeDefaults.svelte';
  import VolumeSettings from './Volume/VolumeSettings.svelte';
  import About from './About.svelte';
  import QuickAccess from './QuickAccess.svelte';
  import { beforeNavigate } from '$app/navigation';

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

  beforeNavigate((nav) => {
    if (open) {
      nav.cancel();
      open = false;
    }
  });
</script>

<Drawer
  placement="right"
  class="w-full md:w-1/2 lg:w-1/4"
  {transitionParams}
  bind:open
  id="settings"
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
      {#if isReader()}
        <VolumeSettings />
      {:else}
        <VolumeDefaults />
      {/if}
      <Profiles {onClose} />
      <ReaderSettings />
      <AnkiConnectSettings />
      <CatalogSettings />
      <Stats />
      <About />
    </Accordion>
    <div class="flex flex-col gap-2">
      <Button outline onclick={onReset}>Reset</Button>
      <Button outline onclick={onClose} color="light">Close</Button>
    </div>
  </div>
</Drawer>
