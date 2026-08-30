<script lang="ts">
  import { Card, Button, Input, Label, Select } from 'flowbite-svelte';
  import { ChartPieSolid, CheckCircleSolid, ExclamationCircleSolid } from 'flowbite-svelte-icons';
  import { nav } from '$lib/util/hash-router';
  import {
    activeGoalProgress,
    activeGoalSelection,
    customGoals,
    goalSnapshots,
    setActiveGoalSelection,
    setGoalTarget,
    updateCustomGoal,
    createCustomGoal,
    getRecentPeriods,
    getCurrentPeriodKey,
    buildGoalSnapshotKey,
    type GoalProgress,
    type GoalType
  } from '$lib/goals';
  import type { GoalRejection } from '$lib/goals/goals-data';
  import { showSnackbar } from '$lib/util/snackbar';

  const goalTypeOptions: { value: GoalType; name: string }[] = [
    { value: 'year', name: 'Year' },
    { value: 'season', name: 'Season' },
    { value: 'month', name: 'Month' },
    { value: 'today', name: 'Today' },
    { value: 'custom', name: 'Custom' }
  ];

  // Local state for editing the goal
  let isEditing = $state(false);
  let editValue = $state(52);
  let isCreatingCustom = $state(false);
  let customName = $state('');
  let customStart = $state('');
  let customEnd = $state('');
  let customTarget = $state(10);

  // Get current progress
  let progress: GoalProgress = $derived($activeGoalProgress);

  let selection = $derived($activeGoalSelection);
  let target = $derived(progress.targetVolumes);
  let availablePeriods = $derived.by(() => {
    if (selection.goalType === 'custom') return [];

    const periods = getRecentPeriods(selection.goalType, 8);
    const currentKey = getCurrentPeriodKey(selection.goalType);
    const snapshotKeys = new Set(Object.keys($goalSnapshots));

    return periods.filter((period) => {
      if (period.periodKey === currentKey) return true;
      if (period.periodKey === selection.periodKey) return true;
      const key = buildGoalSnapshotKey(selection.goalType, period.periodKey);
      return snapshotKeys.has(key);
    });
  });

  let periodOptions = $derived(
    availablePeriods.map((period) => ({ value: period.periodKey, name: period.label }))
  );

  // "Custom" with nothing created still needs one entry saying so — an empty Select is a
  // blank box with nothing to explain itself.
  let customGoalOptions = $derived(
    $customGoals.length === 0
      ? [{ value: 'none', name: 'No custom goals' }]
      : $customGoals.map((goal) => ({ value: goal.id, name: goal.name }))
  );

  // Status colors and icons
  const statusConfig = {
    ahead: {
      color: 'text-green-400',
      bgColor: 'bg-green-500',
      progressColor: 'green',
      label: 'Ahead of schedule!',
      description: 'Keep up the great work!'
    },
    'on-track': {
      color: 'text-blue-400',
      bgColor: 'bg-blue-500',
      progressColor: 'blue',
      label: 'On track',
      description: "You're right where you should be."
    },
    behind: {
      color: 'text-yellow-400',
      bgColor: 'bg-yellow-500',
      progressColor: 'yellow',
      label: 'Slightly behind',
      description: 'A little extra reading will catch you up!'
    },
    'far-behind': {
      color: 'text-red-400',
      bgColor: 'bg-red-500',
      progressColor: 'red',
      label: 'Behind schedule',
      description: 'Consider adjusting your goal or finding more reading time.'
    }
  };

  let config = $derived(statusConfig[progress.status]);

  function startEditing() {
    editValue = target || 0;
    isEditing = true;
  }

  function saveGoal() {
    if (editValue > 0) {
      if (selection.goalType === 'custom') {
        const currentCustom = $customGoals.find((goal) => goal.id === selection.customId);
        if (currentCustom) {
          updateCustomGoal({ ...currentCustom, targetVolumes: editValue });
        }
      } else {
        setGoalTarget(selection.goalType, selection.periodKey, editValue);
      }
    }
    isEditing = false;
  }

  function cancelEditing() {
    isEditing = false;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      saveGoal();
    } else if (e.key === 'Escape') {
      cancelEditing();
    }
  }

  function handleGoalTypeChange(goalType: GoalType) {
    if (goalType === 'custom') {
      const firstCustom = $customGoals[0];
      if (firstCustom) {
        setActiveGoalSelection({ goalType: 'custom', customId: firstCustom.id });
      } else {
        setActiveGoalSelection({ goalType: 'custom', customId: 'none' });
      }
      return;
    }

    const periodKey = getCurrentPeriodKey(goalType);
    setActiveGoalSelection({ goalType, periodKey });
  }

  function handlePeriodChange(periodKey: string) {
    if (selection.goalType === 'custom') return;
    setActiveGoalSelection({ goalType: selection.goalType, periodKey });
  }

  /** Why a save was refused, in the user's words. */
  const rejectionMessage: Record<GoalRejection, string> = {
    name: 'Give the goal a name.',
    target: 'The target must be a whole number of volumes, at least 1.',
    range: 'The end date must not be before the start date.',
    missing: 'That goal no longer exists.',
    locked: 'This period is already closed, so its dates cannot change.'
  };

  function handleCustomSelection(customId: string) {
    setActiveGoalSelection({ goalType: 'custom', customId });
  }

  function toggleCustomForm() {
    isCreatingCustom = !isCreatingCustom;
  }

  function saveCustomGoal() {
    // Only clear and close on SUCCESS. This used to reset every field
    // unconditionally, so transposing the start and end dates — or typing a
    // fractional target — silently threw the whole entry away with no message.
    const rejection = createCustomGoal({
      name: customName,
      startDate: customStart,
      endDate: customEnd,
      targetVolumes: customTarget,
      enabled: true
    });

    if (rejection) {
      showSnackbar(rejectionMessage[rejection]);
      return;
    }

    customName = '';
    customStart = '';
    customEnd = '';
    customTarget = 10;
    isCreatingCustom = false;
  }
</script>

<Card class="mb-6 w-full max-w-none p-5">
  <div class="flex flex-wrap items-start justify-between gap-2">
    <div class="flex items-center gap-3">
      <ChartPieSolid class="h-8 w-8 text-primary-500" />
      <div>
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-xl font-semibold text-gray-200">Reading Goal</h2>
          <Select
            size="sm"
            class="w-36"
            items={goalTypeOptions}
            placeholder=""
            value={selection.goalType}
            aria-label="Goal period type"
            onchange={(e) => handleGoalTypeChange(e.currentTarget.value as GoalType)}
          />
          {#if selection.goalType !== 'custom'}
            <Select
              size="sm"
              class="w-44"
              items={periodOptions}
              placeholder=""
              value={selection.periodKey}
              aria-label="Goal period"
              onchange={(e) => handlePeriodChange(e.currentTarget.value)}
            />
          {:else}
            <Select
              size="sm"
              class="w-48"
              items={customGoalOptions}
              placeholder=""
              value={selection.customId}
              aria-label="Custom goal"
              onchange={(e) => handleCustomSelection(e.currentTarget.value)}
            />
            <Button size="xs" color="alternative" onclick={toggleCustomForm}>
              {isCreatingCustom ? 'Cancel' : 'New'}
            </Button>
          {/if}
          {#if isEditing}
            <div class="mt-2 flex items-center gap-2">
              <Label class="text-sm text-gray-400">Target volumes:</Label>
              <Input
                type="number"
                min="1"
                max="500"
                bind:value={editValue}
                class="w-24"
                size="sm"
                onkeydown={handleKeydown}
              />
              <Button size="xs" color="primary" onclick={saveGoal}>Save</Button>
              <Button size="xs" color="alternative" onclick={cancelEditing}>Cancel</Button>
            </div>
          {:else}
            <p class="text-sm text-gray-400">
              <!-- Keyed: the target is rewritten in place by Migaku/Yomitan, which then holds
                   the old number after an edit or a period switch (CLAUDE.md). -->
              Read {#key progress.targetVolumes}<span>{progress.targetVolumes}</span>{/key} volumes in
              {progress.periodLabel}
              <button
                class="ml-2 text-primary-400 hover:text-primary-300 hover:underline"
                onclick={startEditing}
              >
                Edit
              </button>
            </p>
            {#if selection.goalType === 'custom' && $customGoals.length === 0}
              <p class="mt-1 text-xs text-gray-500">Create a custom goal to get started.</p>
            {/if}
          {/if}
        </div>
      </div>
    </div>
    <Button size="xs" color="alternative" onclick={() => nav.toManageGoals()}>Manage Goals</Button>
  </div>

  <!-- Progress bar -->
  <div class="mt-4">
    <div class="relative">
      <!-- Background bar -->
      <div class="h-4 w-full overflow-hidden rounded-full bg-gray-700">
        <!-- Actual progress -->
        <div
          class="{config.bgColor} h-full transition-all duration-500 ease-out"
          style="width: {Math.min(100, progress.progressPercent)}%"
        ></div>
      </div>
      <!-- Expected progress marker -->
      <div
        class="absolute top-0 h-4 w-0.5 bg-white opacity-75"
        style="left: {Math.min(100, progress.expectedProgressPercent)}%"
        title="Where you should be today"
      ></div>
    </div>
  </div>

  <!-- Stats row. Every figure is keyed on its own value: these counters are exactly the
       text Migaku/Yomitan rewrite in place and then hold stale (CLAUDE.md), and one
       number changing must not rebuild the other four. -->
  <div class="mt-4 grid grid-cols-2 gap-4 text-center sm:grid-cols-5">
    <div>
      {#key progress.completedVolumes}
        <p class="text-2xl font-bold text-gray-200">{progress.completedVolumes}</p>
      {/key}
      <p class="text-xs text-gray-500">Volumes Completed</p>
    </div>
    <div>
      {#key progress.inProgressVolumes}
        <p class="text-2xl font-bold text-gray-200">{progress.inProgressVolumes}</p>
      {/key}
      <p class="text-xs text-gray-500">In Progress</p>
    </div>
    <div>
      {#key progress.totalProgress}
        <p class="text-2xl font-bold text-gray-200">{progress.totalProgress.toFixed(1)}</p>
      {/key}
      <p class="text-xs text-gray-500">Total Progress</p>
    </div>
    <div>
      {#key progress.daysRemaining}
        <p class="text-2xl font-bold text-gray-200">{progress.daysRemaining}</p>
      {/key}
      <p class="text-xs text-gray-500">Days Left</p>
    </div>
    <div>
      {#key progress.progressPercent}
        <span class="text-2xl font-bold {config.color}">
          {progress.progressPercent.toFixed(1)}%
        </span>
      {/key}
      {#key progress.expectedProgressPercent}
        <p class="text-xs text-gray-500">
          of {progress.expectedProgressPercent.toFixed(1)}% expected
        </p>
      {/key}
    </div>
  </div>

  <!-- Status message -->
  <div class="mt-4 flex items-center gap-2 rounded-lg bg-gray-800 px-3">
    {#if progress.status === 'ahead' || progress.status === 'on-track'}
      <CheckCircleSolid class="h-5 w-5 {config.color}" />
    {:else}
      <ExclamationCircleSolid class="h-5 w-5 {config.color}" />
    {/if}
    <div>
      <span class="font-medium {config.color} mr-[0.25em]">{config.label}</span>
      <span class="text-sm text-gray-400"> {config.description}</span>
    </div>
  </div>

  {#if isCreatingCustom}
    <div class="mt-4 rounded-lg bg-gray-900 p-3">
      <div class="mb-2 text-sm font-medium text-gray-300">New Custom Goal</div>
      <div class="grid gap-2 sm:grid-cols-2">
        <div>
          <Label class="text-xs text-gray-400">Name</Label>
          <Input bind:value={customName} size="sm" placeholder="My goal" />
        </div>
        <div>
          <Label class="text-xs text-gray-400">Target</Label>
          <Input type="number" min="1" bind:value={customTarget} size="sm" />
        </div>
        <div>
          <Label class="text-xs text-gray-400">Start</Label>
          <Input type="date" bind:value={customStart} size="sm" />
        </div>
        <div>
          <Label class="text-xs text-gray-400">End</Label>
          <Input type="date" bind:value={customEnd} size="sm" />
        </div>
      </div>
      <div class="mt-3 flex gap-2">
        <Button size="xs" color="primary" onclick={saveCustomGoal}>Save</Button>
        <Button size="xs" color="alternative" onclick={toggleCustomForm}>Cancel</Button>
      </div>
    </div>
  {/if}
</Card>
