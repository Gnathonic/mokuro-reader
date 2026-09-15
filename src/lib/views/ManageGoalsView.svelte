<script lang="ts">
  import { onMount } from 'svelte';
  import { Button, Card, Input, Label, Select } from 'flowbite-svelte';
  import { ArrowLeftOutline } from 'flowbite-svelte-icons';
  import { nav } from '$lib/util/hash-router';
  import { promptConfirmation } from '$lib/util';
  import {
    goalTargets,
    customGoals,
    isCustomGoalDateRangeLocked,
    setGoalTarget,
    removeGoalTarget,
    updateCustomGoal,
    removeCustomGoal,
    setActiveGoalSelection,
    getRecentPeriods,
    type GoalType,
    type GoalTarget,
    type CustomGoal,
    getCurrentPeriodKey,
    ensureCurrentYearTarget
  } from '$lib/goals';
  import type { GoalRejection } from '$lib/goals/goals-data';
  import { showSnackbar } from '$lib/util/snackbar';

  const goalTypes: Exclude<GoalType, 'custom'>[] = ['year', 'season', 'month', 'today'];
  const goalTypeOptions = goalTypes.map((type) => ({ value: type, name: type }));

  let selectedGoalType = $state<Exclude<GoalType, 'custom'>>('year');
  let selectedPeriodKey = $state(getCurrentPeriodKey('year'));
  let targetValue = $state(52);

  let periodOptions = $derived(
    getRecentPeriods(selectedGoalType, 8).map((period) => ({
      value: period.periodKey,
      name: period.label
    }))
  );

  let customEdits = $state<Record<string, CustomGoal>>({});

  function handleGoalTypeChange(value: Exclude<GoalType, 'custom'>) {
    selectedGoalType = value;
    selectedPeriodKey = getCurrentPeriodKey(value);
  }

  function saveTarget() {
    if (targetValue <= 0) return;
    setGoalTarget(selectedGoalType, selectedPeriodKey, targetValue);
    setActiveGoalSelection({ goalType: selectedGoalType, periodKey: selectedPeriodKey });
  }

  /** Why a save was refused, in the user's words. */
  const rejectionMessage: Record<GoalRejection, string> = {
    name: 'Give the goal a name.',
    target: 'The target must be a whole number of volumes, at least 1.',
    range: 'The end date must not be before the start date.',
    missing: 'That goal no longer exists.',
    locked: 'This period is already closed, so its dates cannot change.'
  };

  function startCustomEdit(goal: CustomGoal) {
    customEdits = { ...customEdits, [goal.id]: { ...goal } };
  }

  function updateCustomField(goalId: string, patch: Partial<CustomGoal>) {
    const current = customEdits[goalId];
    if (!current) return;
    customEdits = { ...customEdits, [goalId]: { ...current, ...patch } };
  }

  function saveCustom(goalId: string) {
    const updated = customEdits[goalId];
    if (!updated) return;

    // Keep the row open when the save is refused: closing it reverted the
    // user's typing as though the edit had never happened.
    const rejection = updateCustomGoal(updated);
    if (rejection) {
      showSnackbar(rejectionMessage[rejection]);
      return;
    }

    const { [goalId]: _, ...rest } = customEdits;
    customEdits = rest;
  }

  function cancelCustom(goalId: string) {
    const { [goalId]: _, ...rest } = customEdits;
    customEdits = rest;
  }

  function removeCustom(goalId: string) {
    removeCustomGoal(goalId);
    cancelCustom(goalId);
  }

  // Both removals are tombstoned and sync outwards — there is no undo and no snackbar to
  // undo from, so neither fires straight off its button. A custom goal takes its saved
  // progress history out of reach with it, which is what the wording has to say.
  function confirmRemoveTarget(target: GoalTarget) {
    promptConfirmation(`Remove the ${getTargetLabel(target)} target?`, () =>
      removeGoalTarget(target.goalType, target.periodKey)
    );
  }

  function confirmRemoveCustom(goal: CustomGoal) {
    promptConfirmation(
      `Remove the custom goal "${goal.name}"? Its saved progress history goes with it.`,
      () => removeCustom(goal.id)
    );
  }

  function getTargetLabel(target: GoalTarget): string {
    const period = getRecentPeriods(target.goalType, 1).find(
      (entry) => entry.periodKey === target.periodKey
    );
    if (period) return `${target.goalType.toUpperCase()} • ${period.label}`;

    return `${target.goalType.toUpperCase()} • ${target.periodKey}`;
  }

  // Mint this year's goal the first time the tracker is opened. Deliberately
  // not at app start: a persisted default would put a goals.json in the cloud
  // folder of every user who never opens this page.
  onMount(() => ensureCurrentYearTarget());
</script>

<svelte:head>
  <title>Manage Goals</title>
</svelte:head>

<div class="min-h-[90svh] w-full p-4">
  <div class="mb-6 flex items-center justify-between">
    <h1 class="text-3xl font-bold">Manage Goals</h1>
    <Button size="sm" color="alternative" onclick={() => nav.toProgressTracker()}>
      <ArrowLeftOutline class="mr-2 h-3.5 w-3.5" />
      Back to Progress
    </Button>
  </div>

  <Card class="mb-6 w-full max-w-none p-6">
    <h2 class="mb-3 text-xl font-semibold">Period Goals</h2>
    <div class="grid gap-3 sm:grid-cols-4">
      <div>
        <Label class="text-xs text-gray-400">Goal type</Label>
        <Select
          size="sm"
          items={goalTypeOptions}
          placeholder=""
          value={selectedGoalType}
          aria-label="Goal type"
          onchange={(e) =>
            handleGoalTypeChange(e.currentTarget.value as Exclude<GoalType, 'custom'>)}
        />
      </div>
      <div>
        <Label class="text-xs text-gray-400">Period</Label>
        <Select
          size="sm"
          items={periodOptions}
          placeholder=""
          value={selectedPeriodKey}
          aria-label="Period"
          onchange={(e) => (selectedPeriodKey = e.currentTarget.value)}
        />
      </div>
      <div>
        <Label class="text-xs text-gray-400">Target volumes</Label>
        <Input type="number" min="1" bind:value={targetValue} size="sm" />
      </div>
      <div class="flex items-end">
        <Button size="sm" color="primary" onclick={saveTarget}>Save target</Button>
      </div>
    </div>

    <div class="mt-4">
      <h3 class="mb-2 text-sm font-semibold text-gray-300">Existing period targets</h3>
      {#if $goalTargets.length === 0}
        <p class="text-sm text-gray-400">No period targets yet.</p>
      {:else}
        <div class="flex flex-wrap gap-2">
          <!-- Keyed on the target's own identity: removing one shifts every later index,
               so index-keyed chips would each re-render into their neighbour's slot. -->
          {#each $goalTargets as target (`${target.goalType}:${target.periodKey}`)}
            <div class="flex items-center gap-2 rounded-lg bg-gray-800 px-3 py-2 text-sm">
              <span>{getTargetLabel(target)}</span>
              <span class="text-primary-300">{target.targetVolumes}</span>
              <Button size="xs" color="red" onclick={() => confirmRemoveTarget(target)}>
                Remove
              </Button>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </Card>

  <Card class="w-full max-w-none p-6">
    <h2 class="mb-3 text-xl font-semibold">Custom Goals</h2>
    {#if $customGoals.length === 0}
      <p class="text-sm text-gray-400">No custom goals yet. Create one from the goal card.</p>
    {:else}
      <div class="space-y-3">
        <!-- Keyed on the goal id: the edit rows below feed one-way `value={...}` into their
             Inputs, so an unkeyed remove would leave the surviving row wearing the removed
             goal's rendered name and dates until the next keystroke. -->
        {#each $customGoals as goal (goal.id)}
          {#if customEdits[goal.id]}
            {@const edit = customEdits[goal.id]}
            {@const isDateRangeLocked = isCustomGoalDateRangeLocked(goal)}
            <div class="rounded-lg border border-gray-700 bg-gray-900 p-3">
              <div class="grid gap-2 sm:grid-cols-4">
                <div>
                  <Label class="text-xs text-gray-400">Name</Label>
                  <Input
                    value={edit.name}
                    size="sm"
                    oninput={(e) =>
                      updateCustomField(goal.id, {
                        name: (e.target as HTMLInputElement).value
                      })}
                  />
                </div>
                <div>
                  <Label class="text-xs text-gray-400">Target</Label>
                  <Input
                    type="number"
                    min="1"
                    value={edit.targetVolumes}
                    size="sm"
                    oninput={(e) =>
                      updateCustomField(goal.id, {
                        targetVolumes: Number((e.target as HTMLInputElement).value)
                      })}
                  />
                </div>
                <div>
                  <Label class="text-xs text-gray-400">Start</Label>
                  <Input
                    type="date"
                    value={edit.startDate}
                    size="sm"
                    disabled={isDateRangeLocked}
                    oninput={(e) =>
                      updateCustomField(goal.id, {
                        startDate: (e.target as HTMLInputElement).value
                      })}
                  />
                </div>
                <div>
                  <Label class="text-xs text-gray-400">End</Label>
                  <Input
                    type="date"
                    value={edit.endDate}
                    size="sm"
                    disabled={isDateRangeLocked}
                    oninput={(e) =>
                      updateCustomField(goal.id, {
                        endDate: (e.target as HTMLInputElement).value
                      })}
                  />
                </div>
              </div>
              {#if isDateRangeLocked}
                <p class="mt-2 text-xs text-gray-400">
                  Closed custom goals keep their original date range so saved snapshots stay
                  accurate.
                </p>
              {/if}
              <div class="mt-2 flex gap-2">
                <Button size="xs" color="primary" onclick={() => saveCustom(goal.id)}>Save</Button>
                <Button size="xs" color="alternative" onclick={() => cancelCustom(goal.id)}>
                  Cancel
                </Button>
                <Button size="xs" color="red" onclick={() => confirmRemoveCustom(goal)}>
                  Remove
                </Button>
              </div>
            </div>
          {:else}
            <div
              class="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-gray-800 px-3 py-2"
            >
              <div>
                <div class="text-sm font-semibold">{goal.name}</div>
                <div class="text-xs text-gray-400">
                  {goal.startDate} → {goal.endDate} • {goal.targetVolumes} volumes
                </div>
              </div>
              <div class="flex gap-2">
                <Button size="xs" color="alternative" onclick={() => startCustomEdit(goal)}>
                  Edit
                </Button>
                <Button size="xs" color="red" onclick={() => confirmRemoveCustom(goal)}>
                  Remove
                </Button>
              </div>
            </div>
          {/if}
        {/each}
      </div>
    {/if}
  </Card>
</div>
