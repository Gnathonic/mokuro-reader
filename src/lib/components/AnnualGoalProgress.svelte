<script lang="ts">
  import { Card, Button, Input, Label } from 'flowbite-svelte';
  import { ChartPieSolid, CheckCircleSolid, ExclamationCircleSolid } from 'flowbite-svelte-icons';
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
  } from '$lib/settings/goals';

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

  function handleCustomSelection(customId: string) {
    setActiveGoalSelection({ goalType: 'custom', customId });
  }

  function toggleCustomForm() {
    isCreatingCustom = !isCreatingCustom;
  }

  function saveCustomGoal() {
    if (!customName || !customStart || !customEnd || customTarget <= 0) return;
    createCustomGoal({
      name: customName,
      startDate: customStart,
      endDate: customEnd,
      targetVolumes: customTarget,
      enabled: true
    });
    customName = '';
    customStart = '';
    customEnd = '';
    customTarget = 10;
    isCreatingCustom = false;
  }
</script>

<Card class="mb-6 w-full max-w-none p-5">
  <div class="flex items-start justify-between">
    <div class="flex items-center gap-3">
      <ChartPieSolid class="h-8 w-8 text-primary-500" />
      <div>
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-xl font-semibold text-gray-200">Reading Goal</h2>
          <select
            class="h-9 w-36 rounded-lg border border-gray-700 bg-gray-900 px-2 text-sm text-gray-200"
            value={selection.goalType}
            onchange={(e) =>
              handleGoalTypeChange((e.target as HTMLSelectElement).value as GoalType)}
          >
            <option value="year">Year</option>
            <option value="season">Season</option>
            <option value="month">Month</option>
            <option value="today">Today</option>
            <option value="custom">Custom</option>
          </select>
          {#if selection.goalType !== 'custom'}
            <select
              class="h-9 w-44 rounded-lg border border-gray-700 bg-gray-900 px-2 text-sm text-gray-200"
              value={selection.periodKey}
              onchange={(e) => handlePeriodChange((e.target as HTMLSelectElement).value)}
            >
              {#each availablePeriods as period}
                <option value={period.periodKey}>{period.label}</option>
              {/each}
            </select>
          {:else}
            <select
              class="h-9 w-48 rounded-lg border border-gray-700 bg-gray-900 px-2 text-sm text-gray-200"
              value={selection.customId}
              onchange={(e) => handleCustomSelection((e.target as HTMLSelectElement).value)}
            >
              {#if $customGoals.length === 0}
                <option value="none">No custom goals</option>
              {:else}
                {#each $customGoals as goal}
                  <option value={goal.id}>{goal.name}</option>
                {/each}
              {/if}
            </select>
            <Button size="xs" color="alternative" onclick={toggleCustomForm}>
              {isCreatingCustom ? 'Cancel' : 'New'}
            </Button>
          {/if}
        </div>
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
            Read {progress.targetVolumes} volumes in {progress.periodLabel}
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

    <div class="text-right">
      <span class="text-2xl font-bold {config.color}">
        {progress.progressPercent.toFixed(1)}%
      </span>
      <p class="text-xs text-gray-500">
        of {progress.expectedProgressPercent.toFixed(1)}% expected
      </p>
    </div>
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

  <!-- Stats row -->
  <div class="mt-4 grid grid-cols-2 gap-4 text-center sm:grid-cols-4">
    <div>
      <p class="text-2xl font-bold text-gray-200">{progress.completedVolumes}</p>
      <p class="text-xs text-gray-500">Completed</p>
    </div>
    <div>
      <p class="text-2xl font-bold text-gray-200">{progress.inProgressVolumes}</p>
      <p class="text-xs text-gray-500">In Progress</p>
    </div>
    <div>
      <p class="text-2xl font-bold text-gray-200">{progress.totalProgress.toFixed(1)}</p>
      <p class="text-xs text-gray-500">Total Progress</p>
    </div>
    <div>
      <p class="text-2xl font-bold text-gray-200">{progress.daysRemaining}</p>
      <p class="text-xs text-gray-500">Days Left</p>
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
      <span class="text-sm text-gray-400"> — {config.description}</span>
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

<style>
  :root {
    text-align: center;
  }
</style>
