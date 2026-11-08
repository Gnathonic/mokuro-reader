<script lang="ts">
  import { AccordionItem, Input } from 'flowbite-svelte';
  import {
    copyKeyBindingsToAllProfiles,
    currentProfile,
    profiles,
    settings,
    updateSetting
  } from '$lib/settings';
  import { promptConfirmation, showSnackbar } from '$lib/util';
  import {
    FIXED_INPUTS,
    GROUP_LABELS,
    GROUP_ORDER,
    KEY_ACTIONS,
    type ActionId,
    type KeyActionDef
  } from '$lib/keys/actions';
  import { chordLabel, keymap } from '$lib/keys/live';
  import { keyLabelsVersion } from '$lib/keys/key-labels';
  import { findConflicts, type KeyBindings } from '$lib/keys/keymap';
  import KeyActionRow from './KeyActionRow.svelte';

  // `open` only for tests and deep links; the drawer opens it like any other section.
  let { open = false }: { open?: boolean } = $props();

  const actions = KEY_ACTIONS as readonly KeyActionDef[];

  let filter = $state('');
  let capturingId = $state<string | null>(null);

  let bindings = $derived<KeyBindings>($settings.keyBindings ?? {});
  let conflicts = $derived(findConflicts($keymap));
  let customised = $derived(Object.keys(bindings).length > 0);
  let profileCount = $derived(Object.keys($profiles).length);

  /** Device labels; recomputed when the layout map or a learned label arrives. */
  let labelOf = $derived.by(() => {
    void $keyLabelsVersion;
    return (chord: string) => chordLabel(chord);
  });

  let groups = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    return GROUP_ORDER.map((group) => ({
      group,
      actions: actions.filter((a) => a.group === group && (!q || a.label.toLowerCase().includes(q)))
    })).filter((g) => g.actions.length > 0);
  });

  // A phone or tablet without a keyboard has nothing to fire a binding.
  const touchOnly =
    typeof matchMedia !== 'undefined' &&
    matchMedia('(pointer: coarse)').matches &&
    !matchMedia('(any-pointer: fine)').matches;

  function save(next: KeyBindings) {
    updateSetting('keyBindings', next);
  }

  function resetAll() {
    capturingId = null;
    promptConfirmation('Reset every keyboard shortcut to its default?', () => save({}));
  }

  function copyToAll() {
    promptConfirmation(
      `Copy these shortcuts to all ${profileCount} profiles? Their own shortcuts are replaced.`,
      () => {
        copyKeyBindingsToAllProfiles();
        showSnackbar('Shortcuts copied to every profile');
      }
    );
  }
</script>

<AccordionItem {open}>
  {#snippet header()}Keyboard shortcuts{/snippet}
  <div class="flex flex-col gap-2 text-sm" data-keyboard-shortcuts>
    <p class="text-xs text-gray-500 dark:text-gray-400">
      Saved in profile <b class="text-gray-900 dark:text-white">{$currentProfile}</b>
      {#if profileCount > 1}
        ·
        <button
          type="button"
          class="text-primary-600 hover:underline dark:text-primary-500"
          onclick={copyToAll}>Copy to all profiles</button
        >
      {/if}
    </p>
    {#if touchOnly}
      <p
        class="rounded-md border border-dashed border-gray-300 px-2 py-1 text-xs text-gray-500 dark:border-gray-600 dark:text-gray-400"
      >
        Shortcuts need a hardware keyboard.
      </p>
    {/if}
    <Input size="sm" type="search" placeholder="Filter actions" bind:value={filter} />

    {#each groups as { group, actions: list } (group)}
      <section class="mt-2">
        <h4
          class="border-b border-gray-200 pb-1 pl-2 text-[11px] tracking-wider text-gray-500 uppercase dark:border-gray-700 dark:text-gray-400"
        >
          {GROUP_LABELS[group]}
        </h4>
        <div class="divide-y divide-gray-200 dark:divide-gray-700/60">
          {#each list as action (action.id)}
            <KeyActionRow
              {action}
              {bindings}
              {labelOf}
              conflictsWith={conflicts.get(action.id as ActionId)}
              capturing={capturingId === action.id}
              onCaptureChange={(on) => (capturingId = on ? action.id : null)}
              onSave={save}
            />
          {/each}
        </div>
      </section>
    {:else}
      <p class="text-xs text-gray-500 dark:text-gray-400">No action matches “{filter}”.</p>
    {/each}

    <details class="mt-2 text-xs text-gray-600 dark:text-gray-400">
      <summary class="cursor-pointer select-none">Not changeable</summary>
      <ul class="mt-1 flex flex-col gap-1">
        {#each FIXED_INPUTS as fixed (fixed.input)}
          <li>
            <span class="text-gray-900 dark:text-gray-200">{fixed.input}</span> — {fixed.does}
          </li>
        {/each}
      </ul>
    </details>

    {#if customised}
      <div class="relative z-10 mt-2">
        <button
          type="button"
          class="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          onclick={resetAll}>Reset all shortcuts</button
        >
      </div>
    {/if}
  </div>
</AccordionItem>
