<script lang="ts">
  import { Button, Card } from 'flowbite-svelte';
  import { BookSolid, SortOutline } from 'flowbite-svelte-icons';
  import { volumes, VolumeData, progress } from '$lib/settings/volume-data';
  import { volumes as catalogVolumes } from '$lib/catalog';
  import { miscSettings, updateMiscSetting, type ProgressTrackerSorting } from '$lib/settings';
  import { onMount } from 'svelte';
  import {
    volumeDeadlines,
    calculatePagesPerDay,
    dateUtils,
    finalizeClosedGoalSnapshots,
    activeGoalPeriod,
    activeGoalSnapshot,
    completedAtMap,
    isDateWithinRange
  } from '$lib/settings/goals';
  import { nav } from '$lib/util/hash-router';
  import AnnualGoalProgress from '$lib/components/AnnualGoalProgress.svelte';
  import VolumeCard from '$lib/components/VolumeCard.svelte';

  // Check if volumes is empty
  let hasVolumes = $derived($volumes && Object.keys($volumes).length > 0);

  // Create typed entries for iteration
  let volumeEntries = $derived(Object.entries($volumes) as [string, VolumeData][]);

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
    'pages-per-day',
    'fewest-pages',
    'deadline'
  ];

  const sortLabels: Record<ProgressTrackerSorting, string> = {
    'last-read': 'Last Read',
    'pages-per-day': 'Pages/Day',
    'fewest-pages': 'Fewest Pages',
    deadline: 'Deadline'
  };

  const sortTitles: Record<ProgressTrackerSorting, string> = {
    'last-read': 'Sorted by most recently read',
    'pages-per-day': 'Sorted by highest pages per day needed to reach deadline',
    'fewest-pages': 'Sorted by fewest pages remaining',
    deadline: 'Sorted by soonest deadline'
  };

  function cycleSorting() {
    const currentIndex = sortOrder.indexOf($miscSettings.progressTrackerSorting);
    const nextIndex = (currentIndex + 1) % sortOrder.length;
    updateMiscSetting('progressTrackerSorting', sortOrder[nextIndex]);
  }

  onMount(() => {
    finalizeClosedGoalSnapshots();
  });

  // Helper function to create entries with sort data
  function createEntriesWithSortData(entries: [string, VolumeData][]) {
    const deadlines = $volumeDeadlines;

    return entries.map(([volumeId, volumeData]) => {
      const stats = volumeStats.get(volumeId);
      const remainingPages = stats?.remainingPages ?? 0;
      const deadline = deadlines[volumeId] || null;
      const pagesPerDay = calculatePagesPerDay(remainingPages, deadline);
      const daysUntilDeadline = deadline ? dateUtils.calculateDaysRemaining(deadline) : null;
      const lastProgressUpdate = new Date(volumeData.lastProgressUpdate || 0).getTime();

      return {
        volumeId,
        volumeData,
        remainingPages,
        pagesPerDay,
        daysUntilDeadline,
        lastProgressUpdate,
        hasDeadline: deadline !== null
      };
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

        case 'pages-per-day':
          // Highest pages per day first (most urgent)
          // Volumes without deadlines go to the end
          if (a.pagesPerDay === null && b.pagesPerDay === null) {
            return b.lastProgressUpdate - a.lastProgressUpdate;
          }
          if (a.pagesPerDay === null) return 1;
          if (b.pagesPerDay === null) return -1;
          return b.pagesPerDay - a.pagesPerDay;

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

    // Filter future reads to show only one volume per series
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
      if (seriesUuid && !seenSeries.has(seriesUuid)) {
        seenSeries.add(seriesUuid);
        filteredFutureReads.push([volumeId, volumeData]);
      } else if (!seriesUuid) {
        // Include volumes without series_uuid (shouldn't happen in normal usage)
        filteredFutureReads.push([volumeId, volumeData]);
      }
    }

    return {
      currentlyReading: sortEntries(createEntriesWithSortData(currentlyReading)),
      futureReads: sortEntries(createEntriesWithSortData(filteredFutureReads)),
      completedVolumes: sortEntries(createEntriesWithSortData(completedVolumes))
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

    {#if hasVolumes}
      <div class="flex flex-wrap items-center gap-2">
        <Button size="sm" color="alternative" onclick={() => nav.toManageGoals()}>
          Manage Goals
        </Button>
        <Button
          size="sm"
          color="alternative"
          onclick={cycleSorting}
          title={sortTitles[$miscSettings.progressTrackerSorting]}
          class="flex h-10 items-center justify-center"
        >
          <SortOutline class="h-5 w-5" />
          <span class="ml-1 text-xs">{sortLabels[$miscSettings.progressTrackerSorting]}</span>
        </Button>
      </div>
    {/if}
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
        <h2 class="mb-4 text-xl font-semibold">Currently Reading</h2>
        <div
          class="flex w-full flex-col flex-wrap justify-center gap-[6px] sm:flex-row sm:justify-start"
        >
          {#each volumeSections.currentlyReading as { volumeId, volumeData }}
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
            />
          {/each}
        </div>
      </Card>
    {/if}

    <!-- Future Reads Section -->
    {#if !isGoalClosed && volumeSections.futureReads.length > 0}
      <Card class="mb-6 w-full max-w-none p-6">
        <h2 class="mb-4 text-xl font-semibold">Future Reads</h2>
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
      </Card>
    {/if}

    <!-- Completed Volumes Section -->
    {#if volumeSections.completedVolumes.length > 0}
      <Card class="mb-6 w-full max-w-none p-6">
        <h2 class="mb-4 text-xl font-semibold">Completed Volumes</h2>
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
      </Card>
    {/if}
  {/if}
</div>

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
