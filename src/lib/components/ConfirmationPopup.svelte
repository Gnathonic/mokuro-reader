<script lang="ts">
  import { confirmationPopupStore } from '$lib/util';
  import { Button, Modal, Checkbox } from 'flowbite-svelte';
  import { ExclamationCircleOutline } from 'flowbite-svelte-icons';
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';

  let open = $state(false);
  let checkboxValue = $state(false);

  onMount(() => {
    confirmationPopupStore.subscribe((value) => {
      if (value) {
        open = value.open;
        
        // Load the user's previous selection from localStorage if checkbox option is provided
        if (browser && value.checkboxOption) {
          const { storageKey, defaultValue } = value.checkboxOption;
          const savedPreference = localStorage.getItem(storageKey);
          checkboxValue = savedPreference !== null 
            ? savedPreference === 'true' 
            : defaultValue;
        }
      }
    });
  });

  function handleConfirm() {
    // Save the user's preference if checkbox option is provided
    if (browser && $confirmationPopupStore?.checkboxOption) {
      const { storageKey } = $confirmationPopupStore.checkboxOption;
      localStorage.setItem(storageKey, checkboxValue.toString());
    }
    
    if ($confirmationPopupStore?.onConfirm) {
      $confirmationPopupStore.onConfirm(checkboxValue);
    }
    
    // Always close the modal after confirmation
    open = false;
  }
  
  function handleCancel() {
    if ($confirmationPopupStore?.onCancel) {
      $confirmationPopupStore.onCancel();
    }
    
    // Always close the modal after cancellation
    open = false;
  }
</script>

<Modal bind:open size="xs" autoclose outsideclose>
  <div class="text-center">
    <ExclamationCircleOutline class="mx-auto mb-4 text-gray-400 w-12 h-12 dark:text-gray-200" />
    <h3 class="mb-5 text-lg font-normal text-gray-500 dark:text-gray-400">
      {$confirmationPopupStore?.message}
    </h3>
    {#if $confirmationPopupStore?.checkboxOption}
      <div class="flex items-center justify-center mb-4">
        <Checkbox bind:checked={checkboxValue} id="confirmation-checkbox" />
        <label for="confirmation-checkbox" class="ml-2 text-sm font-medium text-gray-500 dark:text-gray-400">
          {$confirmationPopupStore.checkboxOption.label}
        </label>
      </div>
    {/if}
    <Button color="red" class="mr-2" on:click={handleConfirm}>Yes</Button>
    <Button color="alternative" on:click={handleCancel}>No</Button>
  </div>
</Modal>
