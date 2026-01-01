<script lang="ts">
  import { Card, Progressbar, Button, Input, Label } from 'flowbite-svelte';
  import { ChartPieSolid, CheckCircleSolid, ExclamationCircleSolid } from 'flowbite-svelte-icons';
  import {
    annualGoalProgress,
    currentAnnualGoal,
    setAnnualGoal,
    type AnnualGoalProgress
  } from '$lib/settings/goals';

  // Local state for editing the goal
  let isEditing = $state(false);
  let editValue = $state(52);

  // Get current progress
  let progress: AnnualGoalProgress = $derived($annualGoalProgress);

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
    editValue = $currentAnnualGoal;
    isEditing = true;
  }

  function saveGoal() {
    if (editValue > 0) {
      setAnnualGoal(editValue);
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
</script>

<Card class="mb-6 w-full max-w-none p-5">
  <div class="flex items-start justify-between">
    <div class="flex items-center gap-3">
      <ChartPieSolid class="h-8 w-8 text-primary-500" />
      <div>
        <h2 class="text-xl font-semibold text-gray-200">Annual Reading Goal</h2>
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
            Read {progress.targetVolumes} volumes in {new Date().getFullYear()}
            <button
              class="ml-2 text-primary-400 hover:text-primary-300 hover:underline"
              onclick={startEditing}
            >
              Edit
            </button>
          </p>
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
</Card>

<style>
  :root {
    text-align: center;
  }
</style>
