<script lang="ts">
  import { Button, Card, Input, Label } from 'flowbite-svelte';
  import { nav } from '$lib/util/hash-router';
  import {
    goalTargets,
    customGoals,
    setGoalTarget,
    removeGoalTarget,
    updateCustomGoal,
    removeCustomGoal,
    setActiveGoalSelection,
    getRecentPeriods,
    type GoalType,
    type GoalTarget,
    type CustomGoal,
    getCurrentPeriodKey
  } from '$lib/settings/goals';

  const goalTypes: Exclude<GoalType, 'custom'>[] = ['year', 'season', 'month', 'today'];

  let selectedGoalType = $state<Exclude<GoalType, 'custom'>>('year');
  let selectedPeriodKey = $state(getCurrentPeriodKey('year'));
  let targetValue = $state(52);

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
    if (!updated.name || !updated.startDate || !updated.endDate || updated.targetVolumes <= 0)
      return;
    updateCustomGoal(updated);
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

  function getTargetLabel(target: GoalTarget): string {
    const period = getRecentPeriods(target.goalType, 1).find(
      (entry) => entry.periodKey === target.periodKey
    );
    if (period) return `${target.goalType.toUpperCase()} • ${period.label}`;

    return `${target.goalType.toUpperCase()} • ${target.periodKey}`;
  }
</script>

<svelte:head>
  <title>Manage Goals</title>
</svelte:head>

<div class="min-h-[90svh] w-full p-4">
  <div class="mb-6 flex items-center justify-between">
    <h1 class="text-3xl font-bold">Manage Goals</h1>
    <Button size="sm" color="alternative" onclick={() => nav.toProgressTracker()}>
      Back to Progress
    </Button>
  </div>

  <Card class="mb-6 w-full max-w-none p-6">
    <h2 class="mb-3 text-xl font-semibold">Period Goals</h2>
    <div class="grid gap-3 sm:grid-cols-4">
      <div>
        <Label class="text-xs text-gray-400">Goal type</Label>
        <select
          class="h-9 w-full rounded-lg border border-gray-700 bg-gray-900 px-2 text-sm text-gray-200"
          value={selectedGoalType}
          onchange={(e) =>
            handleGoalTypeChange(
              (e.target as HTMLSelectElement).value as Exclude<GoalType, 'custom'>
            )}
        >
          {#each goalTypes as type}
            <option value={type}>{type}</option>
          {/each}
        </select>
      </div>
      <div>
        <Label class="text-xs text-gray-400">Period</Label>
        <select
          class="h-9 w-full rounded-lg border border-gray-700 bg-gray-900 px-2 text-sm text-gray-200"
          value={selectedPeriodKey}
          onchange={(e) => (selectedPeriodKey = (e.target as HTMLSelectElement).value)}
        >
          {#each getRecentPeriods(selectedGoalType, 8) as period}
            <option value={period.periodKey}>{period.label}</option>
          {/each}
        </select>
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
          {#each $goalTargets as target}
            <div class="flex items-center gap-2 rounded-lg bg-gray-800 px-3 py-2 text-sm">
              <span>{getTargetLabel(target)}</span>
              <span class="text-primary-300">{target.targetVolumes}</span>
              <Button
                size="xs"
                color="alternative"
                onclick={() => removeGoalTarget(target.goalType, target.periodKey)}
              >
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
        {#each $customGoals as goal}
          {#if customEdits[goal.id]}
            {@const edit = customEdits[goal.id]}
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
                    oninput={(e) =>
                      updateCustomField(goal.id, {
                        endDate: (e.target as HTMLInputElement).value
                      })}
                  />
                </div>
              </div>
              <div class="mt-2 flex gap-2">
                <Button size="xs" color="primary" onclick={() => saveCustom(goal.id)}>Save</Button>
                <Button size="xs" color="alternative" onclick={() => cancelCustom(goal.id)}>
                  Cancel
                </Button>
                <Button size="xs" color="alternative" onclick={() => removeCustom(goal.id)}>
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
                <Button size="xs" color="alternative" onclick={() => removeCustom(goal.id)}>
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
