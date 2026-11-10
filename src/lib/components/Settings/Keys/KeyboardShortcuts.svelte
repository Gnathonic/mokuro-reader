<script lang="ts">
  import { AccordionItem, Input } from 'flowbite-svelte';
  import {
    ChevronDownOutline,
    ChevronRightOutline,
    ExclamationCircleSolid
  } from 'flowbite-svelte-icons';
  import {
    copyKeyBindingsToAllProfiles,
    currentProfile,
    profiles,
    settings,
    updateSetting
  } from '$lib/settings';
  import { findSettingDef } from '$lib/settings/setting-defs';
  import { promptConfirmation, showSnackbar } from '$lib/util';
  import { FIXED_INPUTS, type ActionId, type KeyActionDef } from '$lib/keys/actions';
  import { chordLabel, keymap } from '$lib/keys/live';
  import { keyLabelsVersion } from '$lib/keys/key-labels';
  import { findConflicts, isModified, type KeyBindings } from '$lib/keys/keymap';
  import {
    isMenuChanged,
    menuEligible,
    quickMenuIds,
    withQuickMenu,
    type QuickMenuSelection
  } from '$lib/keys/quick-menu';
  import {
    buildTargets,
    groupTargets,
    isFiltering,
    labelWithin,
    type KeyTarget,
    type TargetFacts
  } from '$lib/keys/targets';
  import KeyActionRow from './KeyActionRow.svelte';
  import KeySettingRow from './KeySettingRow.svelte';

  /**
   * "Shortcuts and quick menu" (#55, spec 17.9). About 250 actions, listed as
   * about 130 TARGETS in the owner's list's areas: a group is a collapsed
   * disclosure that mounts no rows while closed, and a list or slider setting
   * is one row that opens to its actions.
   *
   * Everything that spans rows — the keymap, the conflict map, the quick-menu
   * selection, what is changed, what a search matches — is derived ONCE here
   * (`targets.ts`); a row derives only its own chords.
   */

  // `open` only for tests and deep links; the drawer opens it like any other section.
  let { open = false }: { open?: boolean } = $props();

  let query = $state('');
  let onlyWithKey = $state(false);
  let onlyChanged = $state(false);
  let onlyOnMenu = $state(false);
  /** Groups and settings the user opened; a search opens what matches by itself. */
  let openGroups = $state<Record<string, boolean>>({});
  let openSettings = $state<Record<string, boolean>>({});
  let capturingId = $state<string | null>(null);

  let bindings = $derived<KeyBindings>($settings.keyBindings ?? {});
  let quickMenu = $derived<QuickMenuSelection>($settings.quickMenu ?? {});
  // The live keymap's own list: the hand-registered actions, the ones
  // generated from the setting definitions and one "Set to" per profile.
  let actionMap = $derived($keymap.actions);
  let targets = $derived(buildTargets(actionMap.values(), (id) => findSettingDef(id)?.label));
  let conflicts = $derived(findConflicts($keymap));
  /** The profile's quick menu in every layout, top to bottom. */
  let menuIds = $derived(quickMenuIds(quickMenu, actionMap.values()));
  let profileCount = $derived(Object.keys($profiles).length);

  /** Device labels; recomputed when the layout map or a learned label arrives. */
  let labelOf = $derived.by(() => {
    void $keyLabelsVersion;
    return (chord: string) => chordLabel(chord);
  });

  // Both maps are sparse, so "what is changed" walks the stored entries, not the registry.
  let facts = $derived.by<TargetFacts>(() => {
    const keysChanged = new Set<string>();
    for (const id of Object.keys(bindings)) {
      const action = actionMap.get(id as ActionId);
      if (action && isModified(action, bindings)) keysChanged.add(id);
    }
    const menuChanged = new Set<string>();
    for (const id of Object.keys(quickMenu)) {
      const action = actionMap.get(id as ActionId);
      if (action && isMenuChanged(quickMenu, action)) menuChanged.add(id);
    }
    return {
      chords: $keymap.chords,
      labelOf,
      keysChanged,
      onMenu: new Set(menuIds),
      menuChanged,
      conflicts
    };
  });

  let filter = $derived({
    query,
    hasKey: onlyWithKey,
    changed: onlyChanged,
    onMenu: onlyOnMenu
  });
  let filtering = $derived(isFiltering(filter));
  let groups = $derived(groupTargets(targets, facts, filter));

  let keysCustomised = $derived(Object.keys(bindings).length > 0);
  let menuCustomised = $derived(facts.menuChanged.size > 0);

  // A phone or tablet without a keyboard has nothing to fire a binding.
  const touchOnly =
    typeof matchMedia !== 'undefined' &&
    matchMedia('(pointer: coarse)').matches &&
    !matchMedia('(any-pointer: fine)').matches;

  function save(next: KeyBindings) {
    updateSetting('keyBindings', next);
  }

  function setOnMenu(action: KeyActionDef, on: boolean) {
    updateSetting('quickMenu', withQuickMenu(quickMenu, action, on));
  }

  function resetAll() {
    capturingId = null;
    promptConfirmation('Reset every keyboard shortcut to its default?', () => save({}));
  }

  function resetMenu() {
    promptConfirmation('Reset the quick menu to its default actions?', () =>
      updateSetting('quickMenu', {})
    );
  }

  function copyToAll() {
    promptConfirmation(
      `Copy these shortcuts and this quick menu to all ${profileCount} profiles? Their own are replaced.`,
      () => {
        copyKeyBindingsToAllProfiles();
        showSnackbar('Shortcuts and quick menu copied to every profile');
      }
    );
  }

  const FILTERS = [
    { label: 'Has a key', get: () => onlyWithKey, set: (v: boolean) => (onlyWithKey = v) },
    { label: 'Changed', get: () => onlyChanged, set: (v: boolean) => (onlyChanged = v) },
    { label: 'On the quick menu', get: () => onlyOnMenu, set: (v: boolean) => (onlyOnMenu = v) }
  ];
</script>

{#snippet actionRow(target: KeyTarget, action: KeyActionDef)}
  <KeyActionRow
    {action}
    title={labelWithin(target, action)}
    actions={actionMap}
    {bindings}
    {labelOf}
    conflictsWith={conflicts.get(action.id as ActionId)}
    capturing={capturingId === action.id}
    onCaptureChange={(on) => (capturingId = on ? action.id : null)}
    onSave={save}
    menu={menuEligible(action) ? facts.onMenu.has(action.id) : undefined}
    menuChanged={facts.menuChanged.has(action.id)}
    onMenuChange={(on) => setOnMenu(action, on)}
  />
{/snippet}

<AccordionItem {open}>
  {#snippet header()}Shortcuts and quick menu{/snippet}
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
        data-touch-note
      >
        Keys need a hardware keyboard. The quick menu works by touch.
      </p>
    {/if}
    <Input
      size="sm"
      type="search"
      placeholder="Search actions, settings, options, keys"
      aria-label="Search shortcuts"
      bind:value={query}
    />
    <div class="flex flex-wrap gap-1.5" role="group" aria-label="Show only">
      {#each FILTERS as f (f.label)}
        <button
          type="button"
          aria-pressed={f.get()}
          class="rounded-full border px-2 py-0.5 text-xs {f.get()
            ? 'border-primary-600 bg-primary-600 text-white'
            : 'border-gray-300 text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700'}"
          onclick={() => f.set(!f.get())}>{f.label}</button
        >
      {/each}
    </div>
    <p
      class="relative z-10 flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300"
      data-quick-menu-count
    >
      <span>Quick menu: {menuIds.length} {menuIds.length === 1 ? 'action' : 'actions'}</span>
      {#if menuCustomised}
        <button
          type="button"
          class="text-primary-600 hover:underline dark:text-primary-500"
          onclick={resetMenu}>Reset quick menu</button
        >
      {/if}
    </p>

    {#each groups as group (group.group)}
      {@const groupOpen = filtering || !!openGroups[group.group]}
      <section data-key-group={group.group}>
        <h4>
          <button
            type="button"
            class="flex w-full items-center gap-2 border-b border-gray-200 py-1.5 pr-1 pl-1 text-left text-[11px] tracking-wider text-gray-600 uppercase hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-700/50"
            aria-expanded={groupOpen}
            disabled={filtering}
            onclick={() => (openGroups[group.group] = !openGroups[group.group])}
          >
            {#if groupOpen}
              <ChevronDownOutline class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {:else}
              <ChevronRightOutline class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {/if}
            <span data-key-group-label>{group.label}</span>
            {#if group.conflict}
              <span
                class="inline-flex text-amber-500"
                role="img"
                aria-label="Holds a key shared with another action"
                title="An action here shares a key with another action"
              >
                <ExclamationCircleSolid class="h-3.5 w-3.5" />
              </span>
            {/if}
            <span class="flex-1"></span>
            {#if group.changed > 0}
              <span
                class="text-primary-600 normal-case dark:text-primary-500"
                data-key-group-changed>{group.changed} changed</span
              >
            {/if}
            <span class="tabular-nums" data-key-group-count>{group.count}</span>
          </button>
        </h4>
        <!-- A closed group mounts no rows. -->
        {#if groupOpen}
          <div class="divide-y divide-gray-200 dark:divide-gray-700/60">
            {#each group.rows as row (row.target.key)}
              {#if row.target.folded}
                {@const settingOpen = filtering || !!openSettings[row.target.key]}
                <KeySettingRow
                  id={row.target.key}
                  label={row.target.label}
                  icon={row.target.icon}
                  summary={row.summary}
                  open={settingOpen}
                  changed={row.changed}
                  conflict={row.conflict}
                  onToggle={() => {
                    if (!filtering) openSettings[row.target.key] = !openSettings[row.target.key];
                  }}
                >
                  {#each row.actions as action (action.id)}
                    {@render actionRow(row.target, action)}
                  {/each}
                </KeySettingRow>
              {:else}
                {@render actionRow(row.target, row.actions[0])}
              {/if}
            {/each}
          </div>
        {/if}
      </section>
    {:else}
      <p class="text-xs text-gray-500 dark:text-gray-400" data-key-no-match>
        {#if query.trim()}No action matches “{query.trim()}”.{:else}No action matches these filters.{/if}
      </p>
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

    {#if keysCustomised}
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
