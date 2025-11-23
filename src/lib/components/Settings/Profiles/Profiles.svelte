<script lang="ts">
  import {
    changeProfile,
    currentProfile,
    profiles,
    profilesWithTrash,
    migrateProfiles
  } from '$lib/settings';
  import { AccordionItem, Button, Select } from 'flowbite-svelte';
  import ManageProfilesModal from './ManageProfilesModal.svelte';
  import { showSnackbar } from '$lib/util';

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();

  let items = $derived(
    Object.keys($profiles).map((id) => {
      return { value: id, name: id };
    })
  );

  let profile = $state($currentProfile);

  function onChange() {
    changeProfile(profile);
    onClose();
  }

  function exportProfiles() {
    const link = document.createElement('a');
    const json = localStorage.getItem('profiles') || '';
    link.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    link.download = 'profiles.json';
    link.click();
    showSnackbar('Profiles exported');
  }

  let files: FileList | undefined = $state(undefined);
  function importProfile() {
    if (!files) return;
    const [file] = files;
    const reader = new FileReader();

    reader.onloadend = () => {
      const imported = JSON.parse(reader.result?.toString() || '');
      // Migrate imported profiles to ensure all fields exist with defaults
      const migrated = migrateProfiles(imported);
      profilesWithTrash.update((prev) => {
        return {
          ...prev,
          ...migrated
        };
      });
      onClose();
      showSnackbar('Profiles imported');
    };

    if (file) {
      reader.readAsText(file);
    }
  }

  let manageModalOpen = $state(false);
</script>

<ManageProfilesModal bind:open={manageModalOpen} />

<AccordionItem>
  {#snippet header()}Profile{/snippet}
  <div class="flex flex-col gap-5">
    <div class="flex flex-col gap-2">
      <Select {items} bind:value={profile} onchange={onChange} placeholder="Select profile ..." />
      <Button size="sm" outline color="dark" onclick={() => (manageModalOpen = true)}
        >Manage profiles</Button
      >
    </div>
    <hr class="border-gray-100 opacity-10" />
    <div class="flex flex-col gap-2">
      <input
        class="rounded-lg border border-slate-700 text-gray-900 file:mr-4 file:rounded-md file:border-0 file:bg-gray-100 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-gray-700 hover:file:bg-gray-200 dark:text-white dark:file:bg-gray-700 dark:file:text-gray-200 dark:hover:file:bg-gray-600"
        type="file"
        accept=".json"
        bind:files
      />
      <Button onclick={importProfile} disabled={!files} size="sm" outline color="blue"
        >Import profiles</Button
      >
      <Button onclick={exportProfiles} size="sm" color="light">Export profiles</Button>
    </div>
  </div>
</AccordionItem>
