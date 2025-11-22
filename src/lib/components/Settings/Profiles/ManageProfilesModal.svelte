<script lang="ts">
  import { preventDefault } from 'svelte/legacy';

  import {
    BUILT_IN_PROFILES,
    copyProfile,
    createProfile,
    deleteProfile,
    profiles,
    renameProfile,
    type BuiltInProfile
  } from '$lib/settings';
  import { promptConfirmation, showSnackbar } from '$lib/util';
  import { Input, Listgroup, ListgroupItem, Modal } from 'flowbite-svelte';
  import {
    CirclePlusSolid,
    EditOutline,
    FileCopySolid,
    TrashBinSolid,
    UserEditSolid
  } from 'flowbite-svelte-icons';

  interface Props {
    open?: boolean;
  }

  let { open = $bindable(false) }: Props = $props();

  let items = $derived(Object.keys($profiles));

  let newProfile: string = $state('');

  // Helper to check if a profile is built-in
  function isBuiltIn(profileName: string): boolean {
    return BUILT_IN_PROFILES.includes(profileName as BuiltInProfile);
  }

  function onSubmit() {
    if (!newProfile) {
      showSnackbar('Profile name cannot be empty');
      return;
    }

    if (items.includes(newProfile)) {
      showSnackbar('Profile already exists');
      return;
    }

    createProfile(newProfile);
    newProfile = '';
  }

  function onCopy(item: string) {
    let newCopy = `${item} copy`;

    while (items.includes(newCopy)) {
      newCopy += ` copy`;
    }

    copyProfile(item, newCopy);
  }

  function onDelete(item: string) {
    if (isBuiltIn(item)) {
      showSnackbar('Cannot delete built-in profile');
      return;
    }

    promptConfirmation(`Are you sure you would like to delete the [${item}] profile?`, () => {
      const success = deleteProfile(item);
      if (success) {
        showSnackbar('Profile deleted');
      }
    });
  }

  let profileToEdit: string = $state('');
  let newName: string = $state('');

  function onEditClicked(item: string) {
    if (isBuiltIn(item)) {
      showSnackbar('Cannot rename built-in profile');
      return;
    }

    if (profileToEdit) {
      profileToEdit = '';
    } else {
      newName = item;
      profileToEdit = item;
    }
  }

  function onEdit() {
    if (items.includes(newName)) {
      showSnackbar('Profile already exists');
      return;
    }

    const success = renameProfile(profileToEdit, newName);
    if (success) {
      profileToEdit = '';
      showSnackbar('Profile renamed');
    }
  }

  function onInputClick(this: any) {
    this.select();
  }
</script>

<Modal size="xs" bind:open outsideclose>
  <Listgroup {items} let:item>
    <ListgroupItem class="flex flex-row justify-between gap-6">
      <div class="flex-1 flex items-center gap-2">
        {#if profileToEdit === item}
          <form onsubmit={preventDefault(onEdit)}>
            <Input size="sm" bind:value={newName} autofocus onclick={onInputClick}>
              <EditOutline slot="right" size="sm" onclick={onEdit} class="hover:text-primary-700" />
            </Input>
          </form>
        {:else}
          <p class="line-clamp-1">{item}</p>
          {#if isBuiltIn(item)}
            <span class="text-xs px-2 py-0.5 bg-blue-500 text-white rounded-full">Built-in</span>
          {/if}
        {/if}
      </div>
      <div class="flex flex-row gap-2 items-center">
        <FileCopySolid size="sm" class="hover:text-primary-700" onclick={() => onCopy(item)} />
        {#if !isBuiltIn(item)}
          <UserEditSolid
            size="sm"
            class="hover:text-primary-700"
            onclick={() => onEditClicked(item)}
          />
          <TrashBinSolid size="sm" class="hover:text-primary-700" onclick={() => onDelete(item)} />
        {/if}
      </div>
    </ListgroupItem>
  </Listgroup>
  <form onsubmit={preventDefault(onSubmit)}>
    <Input type="text" placeholder="New profile..." bind:value={newProfile}>
      <CirclePlusSolid slot="right" class="hover:text-primary-700" onclick={onSubmit} />
    </Input>
  </form>
</Modal>
