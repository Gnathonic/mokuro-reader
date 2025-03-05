<script lang="ts">
  import { Accordion, Button, CloseButton, Drawer } from 'flowbite-svelte';
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
    hidden?: boolean;
  }

  // In Svelte 5, we need to make sure the hidden prop is properly bindable
  let { hidden = $bindable(true) }: Props = $props();

  function onReset() {
    hidden = true;
    promptConfirmation('Restore default settings?', resetSettings);
  }

  function onClose() {
    hidden = true;
  }

  beforeNavigate((nav) => {
    if (!hidden) {
      nav.cancel();
      hidden = true;
    }
  });
</script>

<Drawer
  placement="right"
  transitionType="fly"
  width="lg:w-1/4 md:w-1/2 w-full"
  {transitionParams}
  bind:hidden
  id="settings"
>
  <div class="flex items-center">
    <h5 id="drawer-label" class="inline-flex items-center mb-4 text-base font-semibold">
      <UserSettingsSolid class="w-4 h-4 mr-2.5" />Settings
    </h5>
    <CloseButton on:click={onClose} class="mb-4 dark:text-white" />
  </div>
  <div class="flex flex-col gap-5">
    <Accordion flush>
      <QuickAccess bind:hidden />
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
      <Button outline on:click={onReset}>Reset</Button>
      <Button outline on:click={onClose} color="light">Close</Button>
    </div>
  </div>
</Drawer>
