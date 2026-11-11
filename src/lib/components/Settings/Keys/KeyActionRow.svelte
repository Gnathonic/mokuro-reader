<script lang="ts">
  import { tick } from 'svelte';
  import { ExclamationCircleSolid } from 'flowbite-svelte-icons';
  import { SCOPES, type ActionId, type KeyActionDef, type KeyScope } from '$lib/keys/actions';
  import { assessCapture } from '$lib/keys/capture';
  import { actionIcon } from '$lib/keys/icons';
  import { warningsFor } from '$lib/keys/reserved';
  import {
    MAX_CHORDS_PER_ACTION,
    addChord,
    editableChords,
    isModified,
    removeChord,
    replaceChord,
    resetAction,
    type KeyBindings
  } from '$lib/keys/keymap';
  import KeyChip from './KeyChip.svelte';
  import KeyCapture from './KeyCapture.svelte';

  interface Props {
    action: KeyActionDef;
    /** Every action the bindings apply to (the live keymap's list). */
    actions: ReadonlyMap<ActionId, KeyActionDef>;
    bindings: KeyBindings;
    /** Other actions this one shares a chord with (a synced or hand-edited map). */
    conflictsWith?: ReadonlySet<ActionId>;
    capturing: boolean;
    labelOf: (chord: string) => string;
    onCaptureChange: (capturing: boolean) => void;
    onSave: (next: KeyBindings) => void;
    /** The name the row shows: under its setting's row, "Next" for "Paged zoom: Next". */
    title?: string;
    /**
     * Is the action on the quick menu? `undefined` = it can never be there,
     * so the row has no switch. The section derives the selection ONCE and
     * hands each row its own answer.
     */
    menu?: boolean;
    /** The quick-menu choice differs from the default (the row's changed mark). */
    menuChanged?: boolean;
    onMenuChange?: (on: boolean) => void;
  }

  let {
    action,
    actions,
    bindings,
    conflictsWith,
    capturing,
    labelOf,
    onCaptureChange,
    onSave,
    title,
    menu,
    menuChanged = false,
    onMenuChange
  }: Props = $props();

  let Icon = $derived(actionIcon(action.icon));

  const MODE_LABEL = { paged: 'Paged', vertical: 'Vertical', horizontal: 'Horizontal' } as const;
  const PAGE_SCOPES: readonly KeyScope[] = [
    'library',
    'series',
    'tracker',
    'text',
    'series-editor'
  ];

  let locked = $derived(action.locked ?? []);
  let chords = $derived(editableChords(action, bindings));
  let total = $derived(locked.length + chords.length);
  let modified = $derived(isModified(action, bindings));
  let tags = $derived.by(() => {
    if (action.scope === 'edit') return ['Edit mode'];
    // A page outside the reader: say which one (a card's description already does).
    if (PAGE_SCOPES.includes(action.scope)) return [SCOPES[action.scope].label];
    if (!action.modes || action.modes.length === 3) return [];
    return action.modes.map((m) => MODE_LABEL[m]);
  });

  /** A chord waiting on Replace/Cancel. */
  let pending = $state<{ chord: string; others: ActionId[] } | null>(null);
  /** The line under the chips after a capture: refusal, warning or note. */
  let message = $state<{ tone: 'info' | 'warn'; text: string } | null>(null);
  let announce = $state('');

  function otherLabels(ids: readonly ActionId[]) {
    return ids.map((id) => `“${actions.get(id)?.label ?? id}”`).join(', ');
  }

  function captured(chord: string) {
    onCaptureChange(false);
    pending = null;
    message = null;
    const label = labelOf(chord);
    const verdict = assessCapture(action, chord, bindings, [...actions.values()]);
    switch (verdict.kind) {
      case 'refused':
        message = { tone: 'warn', text: `${label}: ${verdict.reason}` };
        announce = message.text;
        return;
      case 'duplicate':
        message = { tone: 'info', text: `${label} is already set here.` };
        announce = message.text;
        return;
      case 'full':
        message = { tone: 'info', text: `At most ${MAX_CHORDS_PER_ACTION} keys per action.` };
        announce = message.text;
        return;
      case 'conflict':
        pending = { chord, others: verdict.others };
        announce = `${label} is already ${otherLabels(verdict.others)}.`;
        return;
      case 'ok':
        onSave(addChord(bindings, action, chord));
        showNotes([...verdict.warnings, ...verdict.notes], verdict.warnings.length > 0);
        announce = `${label} added to ${action.label}.`;
    }
  }

  function showNotes(lines: string[], warn: boolean) {
    message = lines.length ? { tone: warn ? 'warn' : 'info', text: lines.join(' ') } : null;
  }

  function confirmReplace() {
    if (!pending) return;
    const { chord, others } = pending;
    pending = null;
    onSave(
      replaceChord(
        bindings,
        action,
        chord,
        others.flatMap((id) => actions.get(id) ?? [])
      )
    );
    const warnings = warningsFor(chord);
    showNotes(warnings, warnings.length > 0);
    announce = `${labelOf(chord)} moved to ${action.label}.`;
  }

  let rowEl: HTMLDivElement | undefined = $state();

  /**
   * A chip's × and Reset go away with what they did. When the press came
   * from inside the row, keep the keyboard there (on "+ Add") instead of
   * letting focus fall to the page behind the drawer.
   */
  async function keepFocus() {
    if (!rowEl?.contains(document.activeElement)) return;
    await tick();
    if (!rowEl || rowEl.contains(document.activeElement)) return;
    (
      rowEl.querySelector<HTMLElement>('[data-key-capture]') ??
      rowEl.querySelector<HTMLElement>('button')
    )?.focus();
  }

  function remove(chord: string) {
    message = null;
    void keepFocus();
    onSave(removeChord(bindings, action, chord));
    announce = `${labelOf(chord)} removed from ${action.label}.`;
  }

  function reset() {
    message = null;
    pending = null;
    void keepFocus();
    onSave(resetAction(bindings, action));
    announce = `${action.label} reset.`;
  }
</script>

<div
  bind:this={rowEl}
  class="border-l-[3px] py-2 pr-1 pl-2 {modified || menuChanged
    ? 'border-l-primary-600'
    : 'border-l-transparent'}"
  data-key-action={action.id}
>
  <div class="flex items-center gap-2">
    <Icon class="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" aria-hidden="true" />
    <span class="font-medium text-gray-900 dark:text-white">{title ?? action.label}</span>
    {#if conflictsWith && conflictsWith.size > 0}
      <span
        class="inline-flex text-amber-500"
        role="img"
        aria-label="Shares a key with another action"
        title={`Also bound to ${otherLabels([...conflictsWith])} — the first in this list runs`}
      >
        <ExclamationCircleSolid class="h-4 w-4" />
      </span>
    {/if}
    <span class="flex-1"></span>
    {#if modified}
      <button
        type="button"
        class="text-xs text-primary-600 hover:underline dark:text-primary-500"
        onclick={reset}>Reset</button
      >
    {/if}
    {#if menu !== undefined}
      <!-- A real switch, so it works by touch and without a keyboard. -->
      <button
        type="button"
        role="switch"
        aria-checked={menu}
        aria-label={`Show ${action.label} on the quick menu`}
        title="Show on quick menu"
        data-quick-menu-switch
        class="flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[10px] tracking-wide text-gray-500 uppercase hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-gray-700"
        onclick={() => onMenuChange?.(!menu)}
      >
        Menu
        <span
          class="relative inline-block h-3.5 w-6 rounded-full transition-colors {menu
            ? 'bg-primary-600'
            : 'bg-gray-300 dark:bg-gray-600'}"
        >
          <span
            class="absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white transition-[left] {menu
              ? 'left-3'
              : 'left-0.5'}"
          ></span>
        </span>
      </button>
    {/if}
  </div>
  <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
    {action.description}
    {#each tags as tag (tag)}
      <span
        class="ml-1 rounded bg-gray-200 px-1 py-px text-[10px] text-gray-600 dark:bg-gray-700 dark:text-gray-300"
        >{tag}</span
      >
    {/each}
  </p>
  <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
    {#each locked as chord (chord)}
      <KeyChip label={labelOf(chord)} locked actionLabel={action.label} />
    {/each}
    {#each chords as chord (chord)}
      <KeyChip label={labelOf(chord)} actionLabel={action.label} onRemove={() => remove(chord)} />
    {/each}
    {#if total === 0}
      <span
        class="rounded-md border border-dashed border-gray-300 px-2 py-0.5 text-xs text-gray-400 dark:border-gray-600"
        >Not set</span
      >
    {/if}
    {#if total < MAX_CHORDS_PER_ACTION}
      <KeyCapture
        {capturing}
        actionLabel={action.label}
        onStart={() => {
          message = null;
          pending = null;
          announce = 'Press a key. Escape cancels.';
          onCaptureChange(true);
        }}
        onCancel={() => {
          announce = 'Recording cancelled.';
          onCaptureChange(false);
        }}
        onChord={captured}
      />
    {/if}
  </div>
  {#if pending}
    <div class="relative z-10 mt-1.5 flex flex-wrap items-center gap-2 text-xs" role="alert">
      <span class="text-amber-600 dark:text-amber-400">
        {labelOf(pending.chord)} is already {otherLabels(pending.others)}.
      </span>
      <button
        type="button"
        class="rounded bg-primary-600 px-2 py-0.5 text-white hover:bg-primary-700"
        onclick={confirmReplace}>Replace</button
      >
      <button
        type="button"
        class="rounded px-2 py-0.5 text-gray-600 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700"
        onclick={() => (pending = null)}>Cancel</button
      >
    </div>
  {/if}
  {#if message}
    <p
      class="mt-1 text-xs {message.tone === 'warn'
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-gray-500 dark:text-gray-400'}"
    >
      {message.text}
    </p>
  {/if}
  <span class="sr-only" aria-live="polite">{announce}</span>
</div>
