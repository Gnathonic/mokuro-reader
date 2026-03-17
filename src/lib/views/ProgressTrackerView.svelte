<script lang="ts">
  import { Button, Card } from 'flowbite-svelte';
  import { BookSolid, SortOutline, CogOutline } from 'flowbite-svelte-icons';
  import {
    volumes,
    VolumeData,
    progress,
    calculatePagesReadInPeriod
  } from '$lib/settings/volume-data';
  import { volumes as catalogVolumes } from '$lib/catalog';
  import {
    miscSettings,
    updateMiscSetting,
    type ProgressTrackerSorting,
    type ProgressTargetMode
  } from '$lib/settings';
  import {
    volumeDeadlines,
    calculatePeriodPageTargetTotal,
    getCurrentPeriodStart,
    getNextResetTime,
    formatRelativeResetTime,
    dateUtils,
    activeGoalPeriod,
    activeGoalSnapshot,
    completedAtMap,
    isDateWithinRange
  } from '$lib/goals';
  import { nav } from '$lib/util/hash-router';
  import AnnualGoalProgress from '$lib/components/AnnualGoalProgress.svelte';
  import VolumeCard from '$lib/components/VolumeCard.svelte';
  import ProgressTargetSettingsModal from '$lib/components/ProgressTargetSettingsModal.svelte';

  // Check if volumes is empty
  let hasVolumes = $derived($volumes && Object.keys($volumes).length > 0);

  // Create typed entries for iteration
  let volumeEntries = $derived(Object.entries($volumes) as [string, VolumeData][]);

  // Settings modal state
  let settingsModalOpen = $state(false);

  // Calculate current period start for progress tracking
  let currentPeriodStart = $derived(
    getCurrentPeriodStart(
      $miscSettings.progressTargetMode ?? 'daily',
      $miscSettings.progressResetHour ?? 0,
      $miscSettings.progressResetDay ?? 1
    )
  );

  // Calculate next reset time and format for display
  let nextResetTimestamp = $derived(
    getNextResetTime(
      $miscSettings.progressTargetMode ?? 'daily',
      $miscSettings.progressResetHour ?? 0,
      $miscSettings.progressResetDay ?? 1
    )
  );

  let relativeResetTime = $derived(formatRelativeResetTime(nextResetTimestamp));

  // Format reset display with day name for weekly mode
  let resetTimeDisplay = $derived.by(() => {
    const resetDate = new Date(nextResetTimestamp);
    const hour12 =
      resetDate.getHours() === 0
        ? 12
        : resetDate.getHours() > 12
          ? resetDate.getHours() - 12
          : resetDate.getHours();
    const period = resetDate.getHours() < 12 ? 'AM' : 'PM';
    const timeStr = `${hour12}:00 ${period}`;

    if (($miscSettings.progressTargetMode ?? 'daily') === 'weekly') {
      const dayNames = [
        'Sunday',
        'Monday',
        'Tuesday',
        'Wednesday',
        'Thursday',
        'Friday',
        'Saturday'
      ];
      const dayName = dayNames[resetDate.getDay()];
      return `Resets ${dayName} at ${timeStr} in ${relativeResetTime}`;
    }
    return `Resets in ${relativeResetTime}`;
  });

  // Store blob URLs for thumbnails
  let thumbnailUrls = $state<Map<string, string>>(new Map());

  // Create blob URLs for thumbnails
  $effect(() => {
    const newUrls = new Map<string, string>();
    const urlsToRevoke: string[] = [];

    volumeEntries.forEach(([volumeId]) => {
      const catalogVolume = $catalogVolumes[volumeId];
      if (catalogVolume?.thumbnail) {
        const url = URL.createObjectURL(catalogVolume.thumbnail);
        urlsToRevoke.push(url);
        newUrls.set(volumeId, url);
      }
    });

    thumbnailUrls = newUrls;

    // Cleanup: revoke all blob URLs when effect is destroyed
    return () => {
      urlsToRevoke.forEach((url) => URL.revokeObjectURL(url));
    };
  });

  // Precompute progress stats for each volume
  let volumeStats = $derived.by(() => {
    const stats = new Map<
      string,
      {
        progressPercent: number;
        progressPercentString: string;
        remainingPages: number;
        currentPage: number;
        totalPages: number;
        //isCompleted: boolean;
      }
    >();

    for (const [volume_uuid, volumeData] of volumeEntries) {
      const totalPages = $catalogVolumes[volume_uuid]?.page_count ?? 0;
      let currentPage = $progress[volume_uuid] ?? 0;
      // Typically a user won't stop reading on the first page, so count this as 0% progress
      if (currentPage === 1) {
        currentPage = 0;
      }

      const progressPercent = totalPages > 0 ? (currentPage / totalPages) * 100 : 0;

      stats.set(volume_uuid, {
        progressPercent,
        progressPercentString: progressPercent.toFixed(0) + '%',
        remainingPages: totalPages - currentPage,
        currentPage,
        totalPages
        //isCompleted: currentPage >= totalPages
      });
    }

    return stats;
  });

  // Track hover state for each volume
  let hoveredVolume = $state<string | null>(null);

  // Sorting configuration
  const sortOrder: ProgressTrackerSorting[] = [
    'last-read',
    'pages-per-period',
    'pages-to-goal',
    'fewest-pages',
    'deadline'
  ];

  const sortLabels: Record<ProgressTrackerSorting, string> = {
    'last-read': 'Last Read',
    'pages-per-period': 'Pages/Day',
    'pages-to-goal': 'Pages to Goal',
    'fewest-pages': 'Fewest Pages',
    deadline: 'Deadline'
  };

  const sortTitles: Record<ProgressTrackerSorting, string> = {
    'last-read': 'Sorted by most recently read',
    'pages-per-period': 'Sorted by highest pages per day needed to reach deadline',
    'pages-to-goal': 'Sorted by most pages remaining to reach period goal',
    'fewest-pages': 'Sorted by fewest pages remaining',
    deadline: 'Sorted by soonest deadline'
  };

  function cycleSorting() {
    const currentIndex = sortOrder.indexOf($miscSettings.progressTrackerSorting);
    const nextIndex = (currentIndex + 1) % sortOrder.length;
    updateMiscSetting('progressTrackerSorting', sortOrder[nextIndex]);
  }

  function cycleTargetMode() {
    const newMode = ($miscSettings.progressTargetMode ?? 'daily') === 'daily' ? 'weekly' : 'daily';
    updateMiscSetting('progressTargetMode', newMode);
  }

  function openSettings() {
    settingsModalOpen = true;
  }

  // Helper function to create entries with sort data
  function createEntriesWithSortData(
    entries: [string, VolumeData][],
    deadlines: Record<string, string>,
    mode: ProgressTargetMode,
    periodStart: number
  ) {
    return entries.map(([volumeId, volumeData]) => {
      const stats = volumeStats.get(volumeId);
      const remainingPages = stats?.remainingPages ?? 0;
      const deadline = deadlines[volumeId] || null;

      // Calculate pages read in current period
      const pagesReadInPeriod = calculatePagesReadInPeriod(volumeData.recentPageTurns, periodStart);

      // Fixed total target for this period. This value includes pages already
      // read this period; subtract `pagesReadInPeriod` to get the remainder.
      const targetPagesPerPeriod = calculatePeriodPageTargetTotal(
        remainingPages,
        deadline,
        mode,
        pagesReadInPeriod,
        periodStart
      );
      const pagesToGoal =
        targetPagesPerPeriod !== null ? targetPagesPerPeriod - pagesReadInPeriod : null;
      const daysUntilDeadline = deadline ? dateUtils.calculateDaysRemaining(deadline) : null;
      const lastProgressUpdate = new Date(volumeData.lastProgressUpdate || 0).getTime();

      return {
        volumeId,
        volumeData,
        remainingPages,
        targetPagesPerPeriod,
        pagesReadInPeriod,
        pagesToGoal,
        daysUntilDeadline,
        lastProgressUpdate,
        hasDeadline: deadline !== null
      };
    });
  }

  // Helper function to sort Future Reads by added date (newest first)
  function sortByAddedDate(entriesWithSortData: ReturnType<typeof createEntriesWithSortData>) {
    return [...entriesWithSortData].sort((a, b) => {
      const aAddedOn = a.volumeData.addedOn ? new Date(a.volumeData.addedOn).getTime() : null;
      const bAddedOn = b.volumeData.addedOn ? new Date(b.volumeData.addedOn).getTime() : null;

      // If both have addedOn, sort by it (newest first)
      if (aAddedOn !== null && bAddedOn !== null) {
        return bAddedOn - aAddedOn;
      }

      // If one has addedOn and the other doesn't, prioritize the one with addedOn
      if (aAddedOn !== null && bAddedOn === null) {
        return -1;
      }
      if (aAddedOn === null && bAddedOn !== null) {
        return 1;
      }

      // If neither has addedOn, fall back to lastProgressUpdate
      const aLastUpdate = a.lastProgressUpdate;
      const bLastUpdate = b.lastProgressUpdate;

      if (aLastUpdate !== 0 && bLastUpdate !== 0) {
        return bLastUpdate - aLastUpdate;
      }

      // If one has lastProgressUpdate and the other doesn't, prioritize the one with it
      if (aLastUpdate !== 0 && bLastUpdate === 0) {
        return -1;
      }
      if (aLastUpdate === 0 && bLastUpdate !== 0) {
        return 1;
      }

      // Both have no timestamps, maintain current order
      return 0;
    });
  }

  // Helper function to sort Completed Volumes by completion date (oldest first)
  function sortByCompletionDate(entriesWithSortData: ReturnType<typeof createEntriesWithSortData>) {
    const completedMap = $completedAtMap;

    return [...entriesWithSortData].sort((a, b) => {
      const aCompletedAt = completedMap[a.volumeId]
        ? new Date(completedMap[a.volumeId]).getTime()
        : null;
      const bCompletedAt = completedMap[b.volumeId]
        ? new Date(completedMap[b.volumeId]).getTime()
        : null;

      // If both have completedAt, sort by it (oldest first)
      if (aCompletedAt !== null && bCompletedAt !== null) {
        return aCompletedAt - bCompletedAt;
      }

      // If one has completedAt and the other doesn't, prioritize the one with completedAt
      if (aCompletedAt !== null && bCompletedAt === null) {
        return -1;
      }
      if (aCompletedAt === null && bCompletedAt !== null) {
        return 1;
      }

      // If neither has completedAt, fall back to lastProgressUpdate (oldest first)
      return a.lastProgressUpdate - b.lastProgressUpdate;
    });
  }

  // Helper function to sort entries
  function sortEntries(entriesWithSortData: ReturnType<typeof createEntriesWithSortData>) {
    const sorting = $miscSettings.progressTrackerSorting;

    return [...entriesWithSortData].sort((a, b) => {
      switch (sorting) {
        case 'last-read':
          // Most recently read first
          return b.lastProgressUpdate - a.lastProgressUpdate;

        case 'pages-per-period':
          // Highest target per period first (most urgent)
          // Volumes without deadlines go to the end
          if (a.targetPagesPerPeriod === null && b.targetPagesPerPeriod === null) {
            return b.lastProgressUpdate - a.lastProgressUpdate;
          }
          if (a.targetPagesPerPeriod === null) return 1;
          if (b.targetPagesPerPeriod === null) return -1;
          return b.targetPagesPerPeriod - a.targetPagesPerPeriod;

        case 'pages-to-goal':
          // Highest pages remaining to reach goal first (most behind)
          // Volumes without targets go to the end
          if (a.pagesToGoal === null && b.pagesToGoal === null) {
            return b.lastProgressUpdate - a.lastProgressUpdate;
          }
          if (a.pagesToGoal === null) return 1;
          if (b.pagesToGoal === null) return -1;
          return b.pagesToGoal - a.pagesToGoal;

        case 'fewest-pages':
          // Fewest remaining pages first (closest to completion)
          return a.remainingPages - b.remainingPages;

        case 'deadline':
          // Soonest deadline first
          // Volumes without deadlines go to the end
          if (!a.hasDeadline && !b.hasDeadline) {
            return b.lastProgressUpdate - a.lastProgressUpdate;
          }
          if (!a.hasDeadline) return 1;
          if (!b.hasDeadline) return -1;
          return (a.daysUntilDeadline ?? 0) - (b.daysUntilDeadline ?? 0);

        default:
          return 0;
      }
    });
  }

  // Split volumes into reading status categories
  let volumeSections = $derived.by(() => {
    const currentlyReading: [string, VolumeData][] = [];
    const futureReads: [string, VolumeData][] = [];
    const completedVolumes: [string, VolumeData][] = [];

    const activePeriod = $activeGoalPeriod;
    const snapshot = $activeGoalSnapshot;
    const completedMap = $completedAtMap;

    // Explicitly track deadline changes to ensure reactivity
    const deadlines = $volumeDeadlines;
    const mode = $miscSettings.progressTargetMode ?? 'daily';
    const periodStart = currentPeriodStart;

    for (const [volumeId, volumeData] of volumeEntries) {
      const currentPage = $progress[volumeId] ?? 0;
      const totalPages = $catalogVolumes[volumeId]?.page_count ?? 0;

      const isCompletedByProgress = currentPage >= totalPages && totalPages > 0;

      const isCompletedInActiveGoal = () => {
        if (!activePeriod) return isCompletedByProgress;

        if (snapshot) {
          return Object.prototype.hasOwnProperty.call(snapshot.completed, volumeId);
        }

        const completedAt = completedMap[volumeId];
        if (!completedAt) return false;
        return isDateWithinRange(completedAt, activePeriod.start, activePeriod.end);
      };

      if (isCompletedByProgress) {
        if (isCompletedInActiveGoal()) {
          // Completed: progress equals total pages
          completedVolumes.push([volumeId, volumeData]);
        }
        continue;
      }

      if (currentPage > 1) {
        // Currently Reading: progress > 1 but not at final page
        currentlyReading.push([volumeId, volumeData]);
      } else {
        // Future Reads: no progress or progress = 1
        futureReads.push([volumeId, volumeData]);
      }
    }

    // Collect series that are currently being read
    const currentlyReadingSeries = new Set<string>();
    for (const [, volumeData] of currentlyReading) {
      if (volumeData.series_uuid) {
        currentlyReadingSeries.add(volumeData.series_uuid);
      }
    }

    // Filter future reads to show only one volume per series, excluding series that are currently being read
    // TODO: Replace simple title sort with sortVolumes function when available on "natural sorting" branch
    const filteredFutureReads: [string, VolumeData][] = [];
    const seenSeries = new Set<string>();

    // Sort all future reads by volume title to get consistent ordering within series
    const sortedFutureReads = [...futureReads].sort(([, a], [, b]) => {
      const titleA = a.volume_title || '';
      const titleB = b.volume_title || '';
      return titleA.localeCompare(titleB, undefined, { numeric: true, sensitivity: 'base' });
    });

    for (const [volumeId, volumeData] of sortedFutureReads) {
      const seriesUuid = volumeData.series_uuid;
      if (seriesUuid && !currentlyReadingSeries.has(seriesUuid) && !seenSeries.has(seriesUuid)) {
        seenSeries.add(seriesUuid);
        filteredFutureReads.push([volumeId, volumeData]);
      } else if (!seriesUuid) {
        // Include volumes without series_uuid (shouldn't happen in normal usage)
        filteredFutureReads.push([volumeId, volumeData]);
      }
    }

    return {
      currentlyReading: sortEntries(
        createEntriesWithSortData(currentlyReading, deadlines, mode, periodStart)
      ),
      futureReads: sortByAddedDate(
        createEntriesWithSortData(filteredFutureReads, deadlines, mode, periodStart)
      ),
      completedVolumes: sortByCompletionDate(
        createEntriesWithSortData(completedVolumes, deadlines, mode, periodStart)
      )
    };
  });

  let isGoalClosed = $derived.by(() => {
    const period = $activeGoalPeriod;
    if (!period) return false;
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return period.end.getTime() <= startOfToday.getTime();
  });
</script>

<svelte:head>
  <title>Progress Tracker</title>
</svelte:head>

<div class="min-h-[90svh] w-full p-4">
  <div class="mb-6 flex flex-wrap items-center justify-between gap-2">
    <h1 class="text-3xl font-bold">Progress Tracker</h1>
  </div>

  <!-- Annual Goal Progress -->
  <AnnualGoalProgress />

  {#if !hasVolumes}
    <Card class="mb-6 py-8 text-center">
      <BookSolid size="lg" class="mx-auto mb-3 text-gray-500" />
      <h2 class="mb-2 text-lg font-semibold text-gray-300">No Volumes Started Yet</h2>
      <p class="text-sm text-gray-400">Start reading to track your progress!</p>
    </Card>
  {:else}
    <!-- Currently Reading Section -->
    {#if !isGoalClosed && volumeSections.currentlyReading.length > 0}
      <Card class="mb-6 w-full max-w-none p-6">
        <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-xl font-semibold">Currently Reading</h2>
          <div class="flex items-center gap-2">
            <span class="text-xs text-gray-500">{resetTimeDisplay}</span>
            <Button
              size="xs"
              color="alternative"
              onclick={cycleTargetMode}
              title={`Switch to ${($miscSettings.progressTargetMode ?? 'daily') === 'daily' ? 'weekly' : 'daily'} targets`}
              class="flex h-8 items-center justify-center"
            >
              <span class="text-xs">
                {($miscSettings.progressTargetMode ?? 'daily') === 'daily' ? 'Daily' : 'Weekly'}
              </span>
            </Button>
            <Button
              size="xs"
              color="alternative"
              onclick={cycleSorting}
              title={sortTitles[$miscSettings.progressTrackerSorting]}
              class="flex h-8 items-center justify-center"
            >
              <SortOutline class="h-4 w-4" />
              <span class="ml-1 text-xs">{sortLabels[$miscSettings.progressTrackerSorting]}</span>
            </Button>
            <Button
              size="xs"
              color="alternative"
              onclick={openSettings}
              title="Progress target settings"
              class="flex h-8 w-8 items-center justify-center p-0"
            >
              <CogOutline class="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div
          class="flex w-full flex-col flex-wrap justify-center gap-[6px] sm:flex-row sm:justify-start"
        >
          {#each volumeSections.currentlyReading as { volumeId, volumeData, pagesReadInPeriod, targetPagesPerPeriod }}
            {@const stats = volumeStats.get(volumeId)!}
            <VolumeCard
              {volumeId}
              seriesId={volumeData.series_uuid}
              volumeTitle={volumeData.volume_title}
              thumbnailUrl={thumbnailUrls.get(volumeId)}
              progressPercent={stats.progressPercent}
              progressPercentString={stats.progressPercentString}
              remainingPages={stats.remainingPages}
              isHovered={hoveredVolume === volumeId}
              onHover={(id) => (hoveredVolume = id)}
              showProgressBar={true}
              showDeadline={true}
              {pagesReadInPeriod}
              {targetPagesPerPeriod}
              targetMode={$miscSettings.progressTargetMode ?? 'daily'}
            />
          {/each}
        </div>
      </Card>
    {/if}

    <!-- Future Reads Section -->
    {#if !isGoalClosed && volumeSections.futureReads.length > 0}
      <Card class="mb-6 w-full max-w-none p-6">
        <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 class="mb-2 text-xl font-semibold">Future Reads</h2>
          <div
            class="flex w-full flex-col flex-wrap justify-center gap-[6px] sm:flex-row sm:justify-start"
          >
            {#each volumeSections.futureReads as { volumeId, volumeData }}
              {@const stats = volumeStats.get(volumeId)!}
              <VolumeCard
                {volumeId}
                seriesId={volumeData.series_uuid}
                volumeTitle={volumeData.volume_title}
                thumbnailUrl={thumbnailUrls.get(volumeId)}
                progressPercent={stats.progressPercent}
                progressPercentString={stats.progressPercentString}
                remainingPages={stats.remainingPages}
                isHovered={hoveredVolume === volumeId}
                onHover={(id) => (hoveredVolume = id)}
                showProgressBar={false}
                showDeadline={false}
              />
            {/each}
          </div>
        </div>
      </Card>
    {/if}

    <!-- Completed Volumes Section -->
    {#if volumeSections.completedVolumes.length > 0}
      <Card class="mb-6 w-full max-w-none p-6">
        <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 class="mb-2 text-xl font-semibold">Completed Volumes</h2>
          <div
            class="flex w-full flex-col flex-wrap justify-center gap-[6px] sm:flex-row sm:justify-start"
          >
            {#each volumeSections.completedVolumes as { volumeId, volumeData }}
              {@const stats = volumeStats.get(volumeId)!}
              <VolumeCard
                {volumeId}
                seriesId={volumeData.series_uuid}
                volumeTitle={volumeData.volume_title}
                thumbnailUrl={thumbnailUrls.get(volumeId)}
                progressPercent={stats.progressPercent}
                progressPercentString={stats.progressPercentString}
                remainingPages={stats.remainingPages}
                isHovered={hoveredVolume === volumeId}
                onHover={(id) => (hoveredVolume = id)}
                showProgressBar={false}
                showDeadline={false}
              />
            {/each}
          </div>
        </div>
      </Card>
    {/if}
  {/if}
</div>

<!-- Progress Target Settings Modal -->
<ProgressTargetSettingsModal bind:open={settingsModalOpen} />

<style>
  :root {
    --box-width: 125px;
    --box-height: 180px;
    --border-radius: 5px;
    --spacing: 5px;
    --transition-duration: 0.3s;
    --hover-scale: 1.1;
  }
</style>
