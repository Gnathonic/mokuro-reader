<script lang="ts">
  import { confirmationPopupStore } from '$lib/util';
  import { Button, Modal, Checkbox } from 'flowbite-svelte';
  import { ExclamationCircleOutline } from 'flowbite-svelte-icons';
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';

  let open = $state(false);
  let checkboxValue = $state(false);
  let checkboxValue2 = $state(false);

  onMount(() => {
    confirmationPopupStore.subscribe((value) => {
      if (value) {
        open = value.open;

        // Load the user's previous selection from localStorage if checkbox option is provided
        if (browser && value.checkboxOption) {
          const { storageKey, defaultValue } = value.checkboxOption;
          const savedPreference = localStorage.getItem(storageKey);
          checkboxValue = savedPreference !== null ? savedPreference === 'true' : defaultValue;
        }

        // Load the second checkbox value if provided
        if (browser && value.checkboxOption2) {
          const { storageKey, defaultValue } = value.checkboxOption2;
          const savedPreference = localStorage.getItem(storageKey);
          checkboxValue2 = savedPreference !== null ? savedPreference === 'true' : defaultValue;
        }
      }
    });
  });

  function closePopup() {
    open = false;
    confirmationPopupStore.update((value) => (value ? { ...value, open: false } : value));
  }

  function handleConfirm() {
    // Save the user's preference if checkbox option is provided
    if (browser && $confirmationPopupStore?.checkboxOption) {
      const { storageKey } = $confirmationPopupStore.checkboxOption;
      localStorage.setItem(storageKey, checkboxValue.toString());
    }

    // Save the second checkbox preference if provided
    if (browser && $confirmationPopupStore?.checkboxOption2) {
      const { storageKey } = $confirmationPopupStore.checkboxOption2;
      localStorage.setItem(storageKey, checkboxValue2.toString());
    }

    if ($confirmationPopupStore?.onConfirm) {
      $confirmationPopupStore.onConfirm(checkboxValue, checkboxValue2);
    }

    // Always close the modal after confirmation. The STORE has to be flipped too, not just
    // the local `open`: other modals read `$confirmationPopupStore?.open` to know whether a
    // confirmation is on top of them, and a store left at `open: true` would strand them
    // forever. The object itself is kept so the fade-out still has its message.
    closePopup();
  }

  function handleCancel() {
    if ($confirmationPopupStore?.onCancel) {
      $confirmationPopupStore.onCancel();
    }

    // Always close the modal after cancellation (see handleConfirm for why the store too).
    closePopup();
  }
</script>

<!-- onclose: outsideclose / the header X bypass the buttons, and the store must still be
     marked closed so modals underneath stop treating a confirmation as being on top. -->
<Modal bind:open size="xs" autoclose outsideclose onclose={closePopup}>
  <div class="text-center">
    <ExclamationCircleOutline class="mx-auto mb-4 h-12 w-12 text-gray-400 dark:text-gray-200" />
    <h3 class="mb-5 text-lg font-normal text-gray-500 dark:text-gray-400">
      {$confirmationPopupStore?.message}
    </h3>
    {#if $confirmationPopupStore?.checkboxOption}
      <div class="mb-4 flex items-center justify-center">
        <Checkbox bind:checked={checkboxValue} id="confirmation-checkbox" />
        <label
          for="confirmation-checkbox"
          class="ml-2 text-sm font-medium text-gray-500 dark:text-gray-400"
        >
          {$confirmationPopupStore.checkboxOption.label}
        </label>
      </div>
    {/if}
    {#if $confirmationPopupStore?.checkboxOption2}
      <div class="mb-4 flex items-center justify-center">
        <Checkbox bind:checked={checkboxValue2} id="confirmation-checkbox-2" />
        <label
          for="confirmation-checkbox-2"
          class="ml-2 text-sm font-medium text-gray-500 dark:text-gray-400"
        >
          {$confirmationPopupStore.checkboxOption2.label}
        </label>
      </div>
    {/if}
    <Button color="red" class="mr-2" onclick={handleConfirm}>Yes</Button>
    <Button color="alternative" onclick={handleCancel}>No</Button>
  </div>
</Modal>
