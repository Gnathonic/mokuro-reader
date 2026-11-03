<script lang="ts">
  import { confirmationPopupStore } from '$lib/util';
  import { Button, Modal, Checkbox } from 'flowbite-svelte';
  import { ExclamationCircleOutline } from 'flowbite-svelte-icons';
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';

  let open = $state(false);
  let checkboxValue = $state(false);
  let checkboxValue2 = $state(false);
  // Did a button answer the popup on screen? Every other way out (Escape, a
  // click outside) is a "no", and the caller is told so — a caller waiting on
  // the answer (an import link, a layer action's promise) would otherwise wait
  // forever.
  let answered = false;
  let shown: object | undefined;

  function initialValue(option: { storageKey?: string; defaultValue: boolean }): boolean {
    if (!browser || !option.storageKey) return option.defaultValue;
    try {
      const saved = localStorage.getItem(option.storageKey);
      return saved !== null ? saved === 'true' : option.defaultValue;
    } catch {
      return option.defaultValue;
    }
  }

  function remember(option: { storageKey?: string } | undefined, value: boolean) {
    if (!browser || !option?.storageKey) return;
    try {
      localStorage.setItem(option.storageKey, value.toString());
    } catch {
      // A preference that cannot be saved is asked again next time.
    }
  }

  onMount(() => {
    return confirmationPopupStore.subscribe((value) => {
      if (value) {
        open = value.open;
        if (value.open && value !== shown) {
          shown = value;
          answered = false;
          // The user's previous answer when the box is remembered, else its default.
          if (value.checkboxOption) checkboxValue = initialValue(value.checkboxOption);
          if (value.checkboxOption2) checkboxValue2 = initialValue(value.checkboxOption2);
        }
      }
    });
  });

  function closePopup() {
    open = false;
    confirmationPopupStore.update((value) => (value ? { ...value, open: false } : value));
  }

  function onDialogClose() {
    const popup = $confirmationPopupStore;
    const dismissed = !answered;
    answered = true;
    closePopup();
    if (dismissed) popup?.onCancel?.();
  }

  function handleConfirm() {
    answered = true;
    const popup = $confirmationPopupStore;
    remember(popup?.checkboxOption, checkboxValue);
    remember(popup?.checkboxOption2, checkboxValue2);

    popup?.onConfirm?.(checkboxValue, checkboxValue2);

    // Always close the modal after confirmation. The STORE has to be flipped too, not just
    // the local `open`: other modals read `$confirmationPopupStore?.open` to know whether a
    // confirmation is on top of them, and a store left at `open: true` would strand them
    // forever. The object itself is kept so the fade-out still has its message.
    closePopup();
  }

  function handleCancel() {
    answered = true;
    $confirmationPopupStore?.onCancel?.();

    // Always close the modal after cancellation (see handleConfirm for why the store too).
    closePopup();
  }
</script>

<!-- onclose: outsideclose / Escape bypass the buttons; the store must still be marked
     closed so modals underneath stop treating a confirmation as being on top, and the
     caller hears a "no" (onDialogClose). -->
<Modal bind:open size="xs" autoclose outsideclose onclose={onDialogClose}>
  <div class="text-center" data-testid="confirmation-popup">
    <ExclamationCircleOutline class="mx-auto mb-4 h-12 w-12 text-gray-400 dark:text-gray-200" />
    <h3 class="mb-5 text-lg font-normal text-gray-500 dark:text-gray-400">
      {$confirmationPopupStore?.message}
    </h3>
    {#if $confirmationPopupStore?.source && $confirmationPopupStore.source.values.length > 0}
      <div class="mb-4" data-testid="confirmation-source">
        <div class="text-xs tracking-wide text-gray-500 uppercase dark:text-gray-400">
          {$confirmationPopupStore.source.label}
        </div>
        {#each $confirmationPopupStore.source.values as value, i (i)}
          <div class="font-mono text-lg font-semibold break-words text-gray-900 dark:text-white">
            {value}
          </div>
        {/each}
      </div>
    {/if}
    {#if $confirmationPopupStore?.warnings?.length}
      <ul
        class="mb-4 space-y-1 rounded-lg border border-amber-400 bg-amber-50 p-3 text-left text-sm text-amber-800 dark:border-amber-500 dark:bg-amber-900/30 dark:text-amber-200"
        data-testid="confirmation-warnings"
        role="alert"
      >
        {#each $confirmationPopupStore.warnings as warning, i (i)}
          <li>{warning}</li>
        {/each}
      </ul>
    {/if}
    {#if $confirmationPopupStore?.notes?.length}
      <ul
        class="mb-4 space-y-1 text-left text-sm text-gray-600 dark:text-gray-300"
        data-testid="confirmation-notes"
      >
        {#each $confirmationPopupStore.notes as note, i (i)}
          <li>{note}</li>
        {/each}
      </ul>
    {/if}
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
    <!-- relative z-10: night mode's filter on <dialog> resets stacking (see CLAUDE.md). -->
    <div class="relative z-10 flex justify-center gap-2">
      <Button color="red" onclick={handleConfirm}>
        {$confirmationPopupStore?.confirmLabel ?? 'Yes'}
      </Button>
      <Button
        color="alternative"
        onclick={handleCancel}
        data-autofocus={$confirmationPopupStore?.focusCancel ? true : undefined}
      >
        {$confirmationPopupStore?.cancelLabel ?? 'No'}
      </Button>
    </div>
  </div>
</Modal>
