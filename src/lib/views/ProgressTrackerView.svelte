<script lang="ts">
  import { onMount } from 'svelte';
  import { Button, Card, Spinner } from 'flowbite-svelte';
  import { BookSolid, SortOutline, CogOutline } from 'flowbite-svelte-icons';
  import { volumes, VolumeData, progress } from '$lib/settings/volume-data';
  // Placeholders included: a volume read on another device and never downloaded
  // here has no catalog row, so the plain store gave it page_count 0 and the
  // tracker dropped it from every section.
  import { volumesWithPlaceholders as catalogVolumes } from '$lib/catalog';
  import {
    miscSettings,
    updateMiscSetting,
    type ProgressTrackerSorting,
    type CompletedVolumesViewMode
  } from '$lib/settings';
  import {
    volumeDeadlines,
    getCurrentPeriodStart,
    getNextResetTime,
    formatRelativeResetTime,
    activeGoalPeriod,
    activeGoalSelection,
    activeGoalSnapshot,
    completedAtMap,
    ensureCurrentYearTarget,
    getCurrentPeriodKey,
    setActiveGoalSelection
  } from '$lib/goals';
  import AnnualGoalProgress from '$lib/components/AnnualGoalProgress.svelte';
  import VolumeCard from '$lib/components/VolumeCard.svelte';
  import ProgressTargetSettingsModal from '$lib/components/ProgressTargetSettingsModal.svelte';
  import {
    bucketVolumes,
    computeVolumeStats,
    createEntriesWithSortData,
    groupCompletedEntriesBySeries,
    pickNextPerSeries,
    sortByAddedDate,
    sortByCompletionDate,
    sortEntries
  } from '$lib/views/progress-tracker-helpers';

  // The catalog store is `undefined` until its first read resolves. Collapsing
  // that into `{}` made every page count 0 for one coalesce window, which put
  // the whole library into Future Reads and then re-flowed a moment later.
  let catalogLoading = $derived($catalogVolumes === undefined);
  let catalogVolumeMap = $derived($catalogVolumes ?? {});

  let hasVolumes = $derived(Object.keys($volumes ?? {}).length > 0);
  let volumeEntries = $derived(Object.entries($volumes ?? {}) as [string, VolumeData][]);

  // Settings modal state
  let settingsModalOpen = $state(false);

  /*
   * A ticking clock, so everything derived from "now" actually advances.
   *
   * The period start, the reset countdown and the closed-goal test were derived
   * only from `miscSettings`, so they were computed once at mount and then
   * frozen: a tracker left open past the daily reset kept showing the old
   * period's pages-read counts and a countdown stuck at "0m".
   */
  let nowTick = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (nowTick = Date.now()), 60 * 1000);
    return () => clearInterval(timer);
  });

  let currentPeriodStart = $derived.by(() => {
    void nowTick; // re-derive when the clock ticks past a reset boundary
    return getCurrentPeriodStart(
      $miscSettings.progressTargetMode,
      $miscSettings.progressResetHour,
      $miscSettings.progressResetDay
    );
  });

  // Calculate next reset time and format for display
  let nextResetTimestamp = $derived.by(() => {
    void nowTick;
    return getNextResetTime(
      $miscSettings.progressTargetMode,
      $miscSettings.progressResetHour,
      $miscSettings.progressResetDay
    );
  });

  let relativeResetTime = $derived.by(() => {
    void nowTick;
    return formatRelativeResetTime(nextResetTimestamp);
  });

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

    if ($miscSettings.progressTargetMode === 'weekly') {
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

  let volumeStats = $derived(computeVolumeStats(volumeEntries, catalogVolumeMap, $progress));

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

  const completedViewLabels: Record<CompletedVolumesViewMode, string> = {
    volumes: 'Volumes',
    series: 'Series'
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

  function cycleCompletedVolumesViewMode() {
    const newMode: CompletedVolumesViewMode =
      ($miscSettings.completedVolumesViewMode ?? 'volumes') === 'volumes' ? 'series' : 'volumes';
    updateMiscSetting('completedVolumesViewMode', newMode);
  }

  function openSettings() {
    settingsModalOpen = true;
  }

  // Split volumes into reading status categories. The bucketing, sorting and
  // per-series pick are pure functions in `progress-tracker-helpers.ts` so they
  // can be tested; this only wires the stores into them.
  let volumeSections = $derived.by(() => {
    const deadlines = $volumeDeadlines;
    const mode = $miscSettings.progressTargetMode;
    const periodStart = currentPeriodStart;

    const buckets = bucketVolumes(
      volumeEntries,
      volumeStats,
      $activeGoalPeriod,
      $activeGoalSnapshot,
      nowTick
    );

    const withSortData = (entries: [string, VolumeData][]) =>
      createEntriesWithSortData(entries, volumeStats, deadlines, mode, periodStart);

    return {
      currentlyReading: sortEntries(
        withSortData(buckets.currentlyReading),
        $miscSettings.progressTrackerSorting
      ),
      futureReads: sortByAddedDate(
        withSortData(pickNextPerSeries(buckets.futureReads, buckets.currentlyReading))
      ),
      completedVolumes: sortByCompletionDate(
        withSortData(buckets.completedVolumes),
        $completedAtMap
      )
    };
  });

  let completedSeries = $derived.by(() =>
    groupCompletedEntriesBySeries(volumeSections.completedVolumes, $completedAtMap)
  );

  let isGoalClosed = $derived.by(() => {
    const period = $activeGoalPeriod;
    if (!period) return false;
    const now = new Date(nowTick);
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return period.end.getTime() <= startOfToday.getTime();
  });

  let activeGoalPeriodLabel = $derived($activeGoalPeriod?.label ?? null);

  function returnToCurrentPeriod() {
    const selection = $activeGoalSelection;
    if (selection.goalType === 'custom') {
      setActiveGoalSelection({ goalType: 'year', periodKey: getCurrentPeriodKey('year') });
      return;
    }
    setActiveGoalSelection({
      goalType: selection.goalType,
      periodKey: getCurrentPeriodKey(selection.goalType)
    });
  }

  // Mint this year's goal the first time the tracker is opened. Deliberately
  // not at app start: a persisted default would put a goals.json in the cloud
  // folder of every user who never opens this page.
  onMount(() => ensureCurrentYearTarget());
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

  {#if catalogLoading}
    <!-- Not the same thing as an empty library: every page count is unknown
         until the catalog resolves, so sectioning now would show the whole
         library as Future Reads and then re-flow. -->
    <div class="flex items-center justify-center p-16">
      <Spinner size="12" />
    </div>
  {:else if !hasVolumes}
    <Card class="mb-6 py-8 text-center">
      <BookSolid size="lg" class="mx-auto mb-3 text-gray-500" />
      <h2 class="mb-2 text-lg font-semibold text-gray-300">No Volumes Started Yet</h2>
      <p class="text-sm text-gray-400">Start reading to track your progress!</p>
    </Card>
  {:else}
    <!-- A period the user chose to look back at. `rollForwardStaleSelection`
         handles the accidental case at mount, so reaching here means they
         picked a past period deliberately — say so and offer the way back,
         rather than rendering two missing sections and no explanation. -->
    {#if isGoalClosed}
      <Card class="mb-6 py-6 text-center">
        <h2 class="mb-2 text-lg font-semibold text-gray-300">
          Viewing a closed period{activeGoalPeriodLabel ? `: ${activeGoalPeriodLabel}` : ''}
        </h2>
        <p class="mb-4 text-sm text-gray-400">
          Currently Reading and Future Reads are about what to read next, so they are hidden while
          you are looking at a period that has ended.
        </p>
        <div class="relative z-10 flex justify-center">
          <Button size="sm" onclick={returnToCurrentPeriod}>Back to the current period</Button>
        </div>
      </Card>
    {/if}

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
          {#each volumeSections.currentlyReading as { volumeId, volumeData, pagesReadInPeriod, targetPagesPerPeriod } (volumeId)}
            {@const stats = volumeStats[volumeId]!}
            <VolumeCard
              {volumeId}
              seriesId={volumeData.series_uuid}
              volumeTitle={volumeData.volume_title}
              thumbnail={(catalogVolumeMap[volumeId]?.thumbnail as Blob | undefined) ?? undefined}
              progressPercentString={stats.progressPercentString}
              remainingPages={stats.remainingPages}
              isHovered={hoveredVolume === volumeId}
              onHover={(id) => (hoveredVolume = id)}
              now={nowTick}
              volume={catalogVolumeMap[volumeId]}
              showProgressBar={true}
              showDeadline={true}
              {pagesReadInPeriod}
              {targetPagesPerPeriod}
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
            {#each volumeSections.futureReads as { volumeId, volumeData } (volumeId)}
              {@const stats = volumeStats[volumeId]!}
              <VolumeCard
                {volumeId}
                seriesId={volumeData.series_uuid}
                volumeTitle={volumeData.volume_title}
                thumbnail={(catalogVolumeMap[volumeId]?.thumbnail as Blob | undefined) ?? undefined}
                progressPercentString={stats.progressPercentString}
                remainingPages={stats.remainingPages}
                isHovered={hoveredVolume === volumeId}
                onHover={(id) => (hoveredVolume = id)}
                now={nowTick}
                volume={catalogVolumeMap[volumeId]}
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
          <h2 class="text-xl font-semibold">Completed Volumes</h2>
          <div class="flex items-center gap-2">
            <Button
              size="xs"
              color="alternative"
              onclick={cycleCompletedVolumesViewMode}
              title={`Switch to ${($miscSettings.completedVolumesViewMode ?? 'volumes') === 'volumes' ? 'series' : 'volume'} view`}
              class="flex h-8 items-center justify-center"
            >
              <span class="text-xs">
                {completedViewLabels[$miscSettings.completedVolumesViewMode ?? 'volumes']} View
              </span>
            </Button>
          </div>
        </div>
        {#key $miscSettings.completedVolumesViewMode ?? 'volumes'}
          <div
            class="flex w-full flex-col flex-wrap justify-center gap-[6px] sm:flex-row sm:justify-start"
          >
            {#if ($miscSettings.completedVolumesViewMode ?? 'volumes') === 'volumes'}
              {#each volumeSections.completedVolumes as { volumeId, volumeData } (volumeId)}
                {@const stats = volumeStats[volumeId]!}
                <VolumeCard
                  {volumeId}
                  seriesId={volumeData.series_uuid}
                  volumeTitle={volumeData.volume_title}
                  thumbnail={(catalogVolumeMap[volumeId]?.thumbnail as Blob | undefined) ??
                    undefined}
                  progressPercentString={stats.progressPercentString}
                  remainingPages={stats.remainingPages}
                  isHovered={hoveredVolume === volumeId}
                  onHover={(id) => (hoveredVolume = id)}
                  now={nowTick}
                  volume={catalogVolumeMap[volumeId]}
                  showProgressBar={false}
                  showDeadline={false}
                />
              {/each}
            {:else}
              {#each completedSeries as { representativeEntry, completedLabel } (representativeEntry.volumeId)}
                {@const { volumeId, volumeData } = representativeEntry}
                {@const stats = volumeStats[volumeId]!}
                <VolumeCard
                  {volumeId}
                  seriesId={volumeData.series_uuid}
                  volumeTitle={volumeData.volume_title}
                  thumbnail={(catalogVolumeMap[volumeId]?.thumbnail as Blob | undefined) ??
                    undefined}
                  progressPercentString={stats.progressPercentString}
                  remainingPages={stats.remainingPages}
                  isHovered={hoveredVolume === volumeId}
                  onHover={(id) => (hoveredVolume = id)}
                  now={nowTick}
                  volume={catalogVolumeMap[volumeId]}
                  showProgressBar={false}
                  showDeadline={false}
                  subtitle={completedLabel}
                />
              {/each}
            {/if}
          </div>
        {/key}
      </Card>
    {/if}
  {/if}
</div>

<!-- Progress Target Settings Modal -->
<ProgressTargetSettingsModal bind:open={settingsModalOpen} />
