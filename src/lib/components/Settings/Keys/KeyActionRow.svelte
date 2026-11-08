<script lang="ts">
  import { ExclamationCircleSolid } from 'flowbite-svelte-icons';
  import { ACTIONS_BY_ID, type ActionId, type KeyActionDef } from '$lib/keys/actions';
  import { assessCapture } from '$lib/keys/capture';
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
    bindings: KeyBindings;
    /** Other actions this one shares a chord with (a synced or hand-edited map). */
    conflictsWith?: ReadonlySet<ActionId>;
    capturing: boolean;
    labelOf: (chord: string) => string;
    onCaptureChange: (capturing: boolean) => void;
    onSave: (next: KeyBindings) => void;
  }

  let { action, bindings, conflictsWith, capturing, labelOf, onCaptureChange, onSave }: Props =
    $props();

  const MODE_LABEL = { paged: 'Paged', vertical: 'Vertical', horizontal: 'Horizontal' } as const;

  let locked = $derived(action.locked ?? []);
  let chords = $derived(editableChords(action, bindings));
  let total = $derived(locked.length + chords.length);
  let modified = $derived(isModified(action, bindings));
  let tags = $derived.by(() => {
    if (action.scope === 'edit') return ['Edit mode'];
    if (!action.modes || action.modes.length === 3) return [];
    return action.modes.map((m) => MODE_LABEL[m]);
  });

  /** A chord waiting on Replace/Cancel. */
  let pending = $state<{ chord: string; others: ActionId[] } | null>(null);
  /** The line under the chips after a capture: refusal, warning or note. */
  let message = $state<{ tone: 'info' | 'warn'; text: string } | null>(null);
  let announce = $state('');

  function otherLabels(ids: readonly ActionId[]) {
    return ids.map((id) => `“${ACTIONS_BY_ID.get(id)?.label ?? id}”`).join(', ');
  }

  function captured(chord: string) {
    onCaptureChange(false);
    pending = null;
    message = null;
    const label = labelOf(chord);
    const verdict = assessCapture(action, chord, bindings);
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
    onSave(replaceChord(bindings, action, chord, others));
    const warnings = warningsFor(chord);
    showNotes(warnings, warnings.length > 0);
    announce = `${labelOf(chord)} moved to ${action.label}.`;
  }

  function remove(chord: string) {
    message = null;
    onSave(removeChord(bindings, action, chord));
    announce = `${labelOf(chord)} removed from ${action.label}.`;
  }

  function reset() {
    message = null;
    pending = null;
    onSave(resetAction(bindings, action));
    announce = `${action.label} reset.`;
  }
</script>

<div
  class="border-l-[3px] py-2 pr-1 pl-2 {modified ? 'border-primary-600' : 'border-transparent'}"
  data-key-action={action.id}
>
  <div class="flex items-center gap-2">
    <span class="font-medium text-gray-900 dark:text-white">{action.label}</span>
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
          onCaptureChange(true);
        }}
        onCancel={() => onCaptureChange(false)}
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
