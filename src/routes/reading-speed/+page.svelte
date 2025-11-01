<script lang="ts">
  import { onMount } from 'svelte';
  import { derived } from 'svelte/store';
  import {
    processVolumeSpeedData,
    calculateReadingSpeedStats,
    getSeriesSpeedInfo,
    formatDuration,
    formatRelativeDate,
    type VolumeSpeedData
  } from '$lib/util/reading-speed-history';
  import { volumes, clearVolumeSpeedData } from '$lib/settings/volume-data';
  import { volumes as catalogStore } from '$lib/catalog';
  import { personalizedReadingSpeed } from '$lib/settings/reading-speed';
  import { Badge, Card, Table, TableBody, TableBodyCell, TableBodyRow, TableHead, TableHeadCell, Button, Modal } from 'flowbite-svelte';
  import {
    AwardSolid,
    FireSolid,
    ClockSolid,
    BookSolid,
    ArrowUpOutline,
    ArrowDownOutline,
    ChartLineUpOutline,
    TrashBinSolid
  } from 'flowbite-svelte-icons';
  import type { VolumeMetadata } from '$lib/types';
  import Chart from 'chart.js/auto';

  // All possible achievements for test mode (10 levels per category + 1 special)
  const ALL_ACHIEVEMENTS = [
    // Speed-based achievements (10 levels: Grey -> Bronze -> Silver -> Gold -> Platinum -> Prestige Bronze -> Prestige Silver -> Prestige Gold -> Prestige Platinum -> Prismatic)
    'Beginner',
    '¹⁄₁₆ Native',
    '⅛ Native',
    '¼ Native',
    '⅜ Native',
    '½ Native',
    '⅝ Native',
    '¾ Native',
    '⅞ Native',
    'Native',
    // Volume count achievements (10 levels)
    'First Volume',
    'First Steps',
    'Getting Started',
    'Consistent Reader',
    'Dedicated Reader',
    'Veteran Reader',
    'Century Club',
    'Master Reader',
    'Bookworm',
    'Librarian',
    // Character count achievements (10 levels)
    '10K Characters',
    '50K Characters',
    '100K Characters',
    'Quarter Million',
    'Half Million',
    'Million Club',
    '2.5 Million Club',
    '5 Million Club',
    '7.5 Million Club',
    '10 Million Club',
    // Time-based achievements (10 levels)
    '1 Hour Reader',
    '5 Hour Reader',
    '10 Hour Reader',
    '25 Hour Reader',
    '50 Hour Reader',
    '100 Hour Reader',
    '250 Hour Reader',
    '500 Hour Reader',
    '1000 Hour Reader',
    '2000 Hour Reader',
    // Special achievement
    'Improving Fast'
  ];

  // Reactive state
  let chartCanvas: HTMLCanvasElement = $state()!;
  let chart: Chart | null = null;
  let sortBy: 'dateFinished' | 'speed' | 'series' | 'volume' | 'duration' = $state('dateFinished');
  let sortDirection: 'asc' | 'desc' = $state('desc');

  // Delete confirmation modal
  let deleteModalOpen = $state(false);
  let volumeToDelete: VolumeSpeedData | null = $state(null);

  // Toggle for showing all achievements
  let showAllAchievements = $state(false);

  // Derived stores
  const volumeSpeedData = derived(
    [volumes, catalogStore],
    ([$volumes, $catalogStore]) => {
      const catalog = Object.values($catalogStore);
      return processVolumeSpeedData($volumes, catalog);
    }
  );

  const stats = derived(
    [volumeSpeedData, personalizedReadingSpeed, volumes],
    ([$volumeSpeedData, $personalizedSpeed, $volumes]) => {
      return calculateReadingSpeedStats($volumeSpeedData, $personalizedSpeed.charsPerMinute, $volumes);
    }
  );

  const seriesInfo = derived(volumeSpeedData, ($volumeSpeedData) => {
    return getSeriesSpeedInfo($volumeSpeedData);
  });

  // Count all completed volumes (including those without speed tracking)
  const totalCompletedVolumes = derived(volumes, ($volumes) => {
    return Object.values($volumes).filter(vol => vol.completed).length;
  });

  // Sorted volume list using $derived for reactivity
  const sortedVolumes = $derived.by(() => {
    let sorted = [...$volumeSpeedData];

    switch (sortBy) {
      case 'dateFinished':
        sorted.sort((a, b) => {
          const comparison = b.completionDate.getTime() - a.completionDate.getTime();
          return sortDirection === 'asc' ? -comparison : comparison;
        });
        break;
      case 'speed':
        sorted.sort((a, b) => {
          const comparison = b.charsPerMinute - a.charsPerMinute;
          return sortDirection === 'asc' ? -comparison : comparison;
        });
        break;
      case 'series':
        sorted.sort((a, b) => {
          const comparison = a.seriesTitle.localeCompare(b.seriesTitle);
          return sortDirection === 'asc' ? comparison : -comparison;
        });
        break;
      case 'volume':
        sorted.sort((a, b) => {
          const comparison = a.volumeTitle.localeCompare(b.volumeTitle);
          return sortDirection === 'asc' ? comparison : -comparison;
        });
        break;
      case 'duration':
        sorted.sort((a, b) => {
          const comparison = b.durationMinutes - a.durationMinutes;
          return sortDirection === 'asc' ? -comparison : comparison;
        });
        break;
    }

    return sorted;
  });

  function toggleSort(column: 'dateFinished' | 'speed' | 'series' | 'volume' | 'duration') {
    if (sortBy === column) {
      sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      sortBy = column;
      sortDirection = 'desc';
    }
  }

  function createChart(data: VolumeSpeedData[]) {
    if (!chartCanvas || data.length === 0) return;

    // Destroy existing chart
    if (chart) {
      chart.destroy();
    }

    // Sort data by date (oldest first for chart)
    const sortedData = [...data].sort((a, b) => a.completionDate.getTime() - b.completionDate.getTime());

    // Generate colors for each series
    const seriesColors = new Map<string, string>();
    const colorPalette = [
      '#3b82f6', // blue
      '#ef4444', // red
      '#10b981', // green
      '#f59e0b', // amber
      '#8b5cf6', // violet
      '#ec4899', // pink
      '#14b8a6', // teal
      '#f97316', // orange
    ];

    let colorIndex = 0;
    sortedData.forEach(vol => {
      if (!seriesColors.has(vol.seriesId)) {
        seriesColors.set(vol.seriesId, colorPalette[colorIndex % colorPalette.length]);
        colorIndex++;
      }
    });

    // Calculate trend line (linear regression)
    const n = sortedData.length;
    const xValues = sortedData.map((_, i) => i);
    const yValues = sortedData.map(v => v.charsPerMinute);

    const sumX = xValues.reduce((a, b) => a + b, 0);
    const sumY = yValues.reduce((a, b) => a + b, 0);
    const sumXY = xValues.reduce((sum, x, i) => sum + x * yValues[i], 0);
    const sumXX = xValues.reduce((sum, x) => sum + x * x, 0);

    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;

    const trendData = xValues.map(x => slope * x + intercept);

    chart = new Chart(chartCanvas, {
      type: 'line',
      data: {
        labels: sortedData.map(v => v.completionDate.toLocaleDateString()),
        datasets: [
          {
            label: 'Reading Speed',
            data: sortedData.map(v => v.charsPerMinute),
            backgroundColor: sortedData.map(v => seriesColors.get(v.seriesId) || '#3b82f6'),
            borderColor: sortedData.map(v => seriesColors.get(v.seriesId) || '#3b82f6'),
            borderWidth: 2,
            pointRadius: 6,
            pointHoverRadius: 8,
            tension: 0.1,
            fill: false
          },
          {
            label: 'Trend',
            data: trendData,
            borderColor: 'rgba(156, 163, 175, 0.5)',
            borderWidth: 2,
            borderDash: [5, 5],
            pointRadius: 0,
            pointHoverRadius: 0,
            fill: false
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true,
            labels: {
              color: '#9ca3af',
              filter: (item) => item.text === 'Trend' // Only show trend in legend
            }
          },
          tooltip: {
            backgroundColor: 'rgba(17, 24, 39, 0.95)',
            titleColor: '#f3f4f6',
            bodyColor: '#d1d5db',
            borderColor: '#374151',
            borderWidth: 1,
            callbacks: {
              title: (items) => {
                const index = items[0].dataIndex;
                return sortedData[index].volumeTitle;
              },
              label: (context) => {
                if (context.datasetIndex === 1) return ''; // Skip trend line tooltip
                const index = context.dataIndex;
                const vol = sortedData[index];
                return [
                  `Series: ${vol.seriesTitle}`,
                  `Speed: ${Math.round(vol.charsPerMinute)} chars/min`,
                  `Date: ${formatRelativeDate(vol.completionDate)}`,
                  `Duration: ${formatDuration(vol.durationMinutes)}`
                ];
              }
            }
          }
        },
        scales: {
          x: {
            display: true,
            grid: {
              color: 'rgba(75, 85, 99, 0.2)'
            },
            ticks: {
              color: '#9ca3af',
              maxRotation: 45,
              minRotation: 0,
              autoSkip: true,
              maxTicksLimit: 10
            }
          },
          y: {
            display: true,
            grid: {
              color: 'rgba(75, 85, 99, 0.2)'
            },
            ticks: {
              color: '#9ca3af',
              callback: (value) => `${value} cpm`
            },
            title: {
              display: true,
              text: 'Characters per Minute',
              color: '#9ca3af'
            }
          }
        }
      }
    });
  }

  // Update chart when data changes
  $effect(() => {
    if (chartCanvas && $volumeSpeedData) {
      createChart($volumeSpeedData);
    }
  });

  onMount(() => {
    return () => {
      if (chart) {
        chart.destroy();
      }
    };
  });

  function formatNumber(num: number): string {
    return new Intl.NumberFormat().format(Math.round(num));
  }

  // Format numbers with metric notation (K, M, B)
  function formatMetric(num: number): string {
    if (num >= 1_000_000_000) {
      return (num / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'B';
    }
    if (num >= 1_000_000) {
      return (num / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
    }
    if (num >= 1_000) {
      return (num / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
    }
    return num.toString();
  }

  function getBadgeColor(badge: string): 'dark' | 'yellow' | 'blue' | 'green' {
    // 10-tier system: Grey -> Bronze -> Silver -> Gold -> Platinum -> Prestige Bronze -> Prestige Silver -> Prestige Gold -> Prestige Platinum -> Prismatic
    switch (badge) {
      // Speed-based badges (10 levels)
      case 'Beginner': return 'dark';      // Tier 1: Grey
      case '¹⁄₁₆ Native': return 'dark';   // Tier 2: Bronze
      case '⅛ Native': return 'dark';      // Tier 3: Silver
      case '¼ Native': return 'dark';      // Tier 4: Gold
      case '⅜ Native': return 'blue';      // Tier 5: Platinum
      case '½ Native': return 'dark';      // Tier 6: Prestige Bronze
      case '⅝ Native': return 'dark';      // Tier 7: Prestige Silver
      case '¾ Native': return 'dark';      // Tier 8: Prestige Gold
      case '⅞ Native': return 'blue';      // Tier 9: Prestige Platinum
      case 'Native': return 'dark';        // Tier 10: Prismatic

      // Volume count badges (10 levels)
      case 'First Volume': return 'dark';      // Tier 1: Grey
      case 'First Steps': return 'dark';       // Tier 2: Bronze
      case 'Getting Started': return 'dark';   // Tier 3: Silver
      case 'Consistent Reader': return 'dark';   // Tier 4: Gold
      case 'Dedicated Reader': return 'blue';    // Tier 5: Platinum
      case 'Veteran Reader': return 'dark';      // Tier 6: Prestige Bronze
      case 'Century Club': return 'dark';        // Tier 7: Prestige Silver
      case 'Master Reader': return 'dark';       // Tier 8: Prestige Gold
      case 'Bookworm': return 'blue';            // Tier 9: Prestige Platinum
      case 'Librarian': return 'dark';           // Tier 10: Prismatic

      // Character count badges (10 levels)
      case '10K Characters': return 'dark';      // Tier 1: Grey
      case '50K Characters': return 'dark';      // Tier 2: Bronze
      case '100K Characters': return 'dark';     // Tier 3: Silver
      case 'Quarter Million': return 'dark';     // Tier 4: Gold
      case 'Half Million': return 'blue';        // Tier 5: Platinum
      case 'Million Club': return 'dark';        // Tier 6: Prestige Bronze
      case '2.5 Million Club': return 'dark';    // Tier 7: Prestige Silver
      case '5 Million Club': return 'dark';      // Tier 8: Prestige Gold
      case '7.5 Million Club': return 'blue';    // Tier 9: Prestige Platinum
      case '10 Million Club': return 'dark';     // Tier 10: Prismatic

      // Time-based badges (10 levels)
      case '1 Hour Reader': return 'dark';       // Tier 1: Grey
      case '5 Hour Reader': return 'dark';       // Tier 2: Bronze
      case '10 Hour Reader': return 'dark';      // Tier 3: Silver
      case '25 Hour Reader': return 'dark';      // Tier 4: Gold
      case '50 Hour Reader': return 'blue';      // Tier 5: Platinum
      case '100 Hour Reader': return 'dark';     // Tier 6: Prestige Bronze
      case '250 Hour Reader': return 'dark';     // Tier 7: Prestige Silver
      case '500 Hour Reader': return 'dark';     // Tier 8: Prestige Gold
      case '1000 Hour Reader': return 'blue';    // Tier 9: Prestige Platinum
      case '2000 Hour Reader': return 'dark';    // Tier 10: Prismatic

      // Special achievement
      case 'Improving Fast': return 'green';

      default: return 'dark';
    }
  }

  function getBadgeTooltip(badge: string): string {
    switch (badge) {
      // Speed-based badges (10 levels)
      case 'Beginner': return 'Unlocked at >10 chars/min reading speed';
      case '¹⁄₁₆ Native': return 'Unlocked at >25 chars/min reading speed';
      case '⅛ Native': return 'Unlocked at >50 chars/min reading speed';
      case '¼ Native': return 'Unlocked at >100 chars/min reading speed';
      case '⅜ Native': return 'Unlocked at >150 chars/min reading speed';
      case '½ Native': return 'Unlocked at >200 chars/min reading speed';
      case '⅝ Native': return 'Unlocked at >250 chars/min reading speed';
      case '¾ Native': return 'Unlocked at >300 chars/min reading speed';
      case '⅞ Native': return 'Unlocked at >350 chars/min reading speed';
      case 'Native': return 'Unlocked at >450 chars/min reading speed';

      // Volume count badges (10 levels)
      case 'First Volume': return 'Unlocked after completing 1 volume';
      case 'First Steps': return 'Unlocked after completing 3 volumes';
      case 'Getting Started': return 'Unlocked after completing 5 volumes';
      case 'Consistent Reader': return 'Unlocked after completing 10 volumes';
      case 'Dedicated Reader': return 'Unlocked after completing 25 volumes';
      case 'Veteran Reader': return 'Unlocked after completing 50 volumes';
      case 'Century Club': return 'Unlocked after completing 100 volumes';
      case 'Master Reader': return 'Unlocked after completing 250 volumes';
      case 'Bookworm': return 'Unlocked after completing 500 volumes';
      case 'Librarian': return 'Unlocked after completing 1,000 volumes';

      // Character count badges (10 levels)
      case '10K Characters': return 'Unlocked after reading 10,000 characters';
      case '50K Characters': return 'Unlocked after reading 50,000 characters';
      case '100K Characters': return 'Unlocked after reading 100,000 characters';
      case 'Quarter Million': return 'Unlocked after reading 250,000 characters';
      case 'Half Million': return 'Unlocked after reading 500,000 characters';
      case 'Million Club': return 'Unlocked after reading 1,000,000 characters';
      case '2.5 Million Club': return 'Unlocked after reading 2,500,000 characters';
      case '5 Million Club': return 'Unlocked after reading 5,000,000 characters';
      case '7.5 Million Club': return 'Unlocked after reading 7,500,000 characters';
      case '10 Million Club': return 'Unlocked after reading 10,000,000 characters';

      // Time-based badges (10 levels)
      case '1 Hour Reader': return 'Unlocked after 1 hour of reading time';
      case '5 Hour Reader': return 'Unlocked after 5 hours of reading time';
      case '10 Hour Reader': return 'Unlocked after 10 hours of reading time';
      case '25 Hour Reader': return 'Unlocked after 25 hours of reading time';
      case '50 Hour Reader': return 'Unlocked after 50 hours of reading time';
      case '100 Hour Reader': return 'Unlocked after 100 hours of reading time';
      case '250 Hour Reader': return 'Unlocked after 250 hours of reading time';
      case '500 Hour Reader': return 'Unlocked after 500 hours of reading time';
      case '1000 Hour Reader': return 'Unlocked after 1,000 hours of reading time';
      case '2000 Hour Reader': return 'Unlocked after 2,000 hours of reading time';

      // Special achievement
      case 'Improving Fast': return 'Unlocked when speed trend shows >20% improvement';

      default: return '';
    }
  }

  function getTrendIcon(trend: number) {
    if (trend > 10) return ArrowUpOutline;
    if (trend < -10) return ArrowDownOutline;
    return null;
  }

  // Get category for a badge to enable separators
  function getBadgeCategory(badge: string): 'speed' | 'volume' | 'characters' | 'time' | 'special' {
    const speedBadges = ['Beginner', '¹⁄₁₆ Native', '⅛ Native', '¼ Native', '⅜ Native', '½ Native', '⅝ Native', '¾ Native', '⅞ Native', 'Native'];
    const volumeBadges = ['First Volume', 'First Steps', 'Getting Started', 'Consistent Reader', 'Dedicated Reader', 'Veteran Reader', 'Century Club', 'Master Reader', 'Bookworm', 'Librarian'];
    const charBadges = ['10K Characters', '50K Characters', '100K Characters', 'Quarter Million', 'Half Million', 'Million Club', '2.5 Million Club', '5 Million Club', '7.5 Million Club', '10 Million Club'];
    const timeBadges = ['1 Hour Reader', '5 Hour Reader', '10 Hour Reader', '25 Hour Reader', '50 Hour Reader', '100 Hour Reader', '250 Hour Reader', '500 Hour Reader', '1000 Hour Reader', '2000 Hour Reader'];

    if (speedBadges.includes(badge)) return 'speed';
    if (volumeBadges.includes(badge)) return 'volume';
    if (charBadges.includes(badge)) return 'characters';
    if (timeBadges.includes(badge)) return 'time';
    return 'special';
  }

  function confirmDelete(volume: VolumeSpeedData) {
    volumeToDelete = volume;
    deleteModalOpen = true;
  }

  function deleteVolumeData() {
    if (!volumeToDelete) return;

    clearVolumeSpeedData(volumeToDelete.volumeId);

    deleteModalOpen = false;
    volumeToDelete = null;
  }

  // Get animation class for prestige and mythic tier badges
  function getBadgeAnimation(badge: string): string {
    // Tier 6 (Prestige Bronze) - Bronze shimmer effect
    const tier6Badges = ['½ Native', 'Veteran Reader', '100 Hour Reader', 'Million Club'];
    if (tier6Badges.includes(badge)) return 'badge-bronze-shimmer';

    // Tier 7 (Prestige Silver) - Silver sparkle effect
    const tier7Badges = ['⅝ Native', 'Century Club', '250 Hour Reader', '2.5 Million Club'];
    if (tier7Badges.includes(badge)) return 'badge-silver-sparkle';

    // Tier 8 (Prestige Gold) - Gold glow effect
    const tier8Badges = ['¾ Native', 'Master Reader', '500 Hour Reader', '5 Million Club'];
    if (tier8Badges.includes(badge)) return 'badge-gold-glow';

    // Tier 9 (Prestige Platinum) - Platinum pulse effect
    const tier9Badges = ['⅞ Native', 'Bookworm', '1000 Hour Reader', '7.5 Million Club'];
    if (tier9Badges.includes(badge)) return 'badge-platinum-pulse';

    // Tier 10 (Mythic Prismatic) - Ultimate rainbow prismatic effect
    const tier10Badges = ['Native', 'Librarian', '2000 Hour Reader', '10 Million Club'];
    if (tier10Badges.includes(badge)) return 'badge-prismatic';

    return '';
  }

  // Get tier-specific color class for custom badge colors
  function getBadgeTierClass(badge: string): string {
    // Tier 1 (Grey)
    const tier1Badges = ['Beginner', 'First Volume', '10K Characters', '1 Hour Reader'];
    if (tier1Badges.includes(badge)) return 'badge-tier-grey';

    // Tier 2 (Bronze)
    const tier2Badges = ['¹⁄₁₆ Native', 'First Steps', '50K Characters', '5 Hour Reader'];
    if (tier2Badges.includes(badge)) return 'badge-tier-bronze';

    // Tier 3 (Silver)
    const tier3Badges = ['⅛ Native', 'Getting Started', '100K Characters', '10 Hour Reader'];
    if (tier3Badges.includes(badge)) return 'badge-tier-silver';

    // Tier 4 (Gold)
    const tier4Badges = ['¼ Native', 'Consistent Reader', 'Quarter Million', '25 Hour Reader'];
    if (tier4Badges.includes(badge)) return 'badge-tier-gold';

    // Tier 6 (Prestige Bronze)
    const tier6Badges = ['½ Native', 'Veteran Reader', '100 Hour Reader', 'Million Club'];
    if (tier6Badges.includes(badge)) return 'badge-tier-bronze';

    // Tier 7 (Prestige Silver)
    const tier7Badges = ['⅝ Native', 'Century Club', '250 Hour Reader', '2.5 Million Club'];
    if (tier7Badges.includes(badge)) return 'badge-tier-silver';

    // Tier 8 (Prestige Gold)
    const tier8Badges = ['¾ Native', 'Master Reader', '500 Hour Reader', '5 Million Club'];
    if (tier8Badges.includes(badge)) return 'badge-tier-gold';

    // Tier 9 (Prestige Platinum)
    const tier9Badges = ['⅞ Native', 'Bookworm', '1000 Hour Reader', '7.5 Million Club'];
    if (tier9Badges.includes(badge)) return 'badge-tier-platinum';

    // Tier 10 (Prismatic)
    const tier10Badges = ['Native', 'Librarian', '2000 Hour Reader', '10 Million Club'];
    if (tier10Badges.includes(badge)) return 'badge-tier-prismatic';

    return '';
  }
</script>

<svelte:head>
  <title>Reading Speed History</title>
</svelte:head>

<div class="p-4 min-h-[90svh] w-full">
  <h1 class="text-3xl font-bold mb-6">Reading Speed History</h1>

  {#if $volumeSpeedData.length === 0}
    <!-- Empty State -->
    <Card class="text-center py-12">
      <BookSolid size="xl" class="mx-auto mb-4 text-gray-500" />
      <h2 class="text-xl font-semibold mb-2 text-gray-300">No Reading History Yet</h2>
      <p class="text-gray-400">
        Complete your first volume to start tracking your reading speed and progress!
      </p>
    </Card>
  {:else}
    <!-- Stats Cards -->
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6 w-full">
      <!-- Recent Speed -->
      <Card class="max-w-none">
        <div class="flex items-center justify-between">
          <div>
            <p class="text-sm text-gray-400 mb-1">Recent Speed</p>
            <p class="text-2xl font-bold">{Math.round($stats.currentSpeed)}</p>
            <p class="text-xs text-gray-500">chars/min</p>
          </div>
          <FireSolid size="lg" class="text-orange-500" />
        </div>
      </Card>

      <!-- Characters Read -->
      <Card class="max-w-none">
        <div class="flex items-center justify-between">
          <div>
            <p class="text-sm text-gray-400 mb-1">Characters Read</p>
            <p class="text-2xl font-bold">{formatMetric($stats.totalCharsRead)}</p>
            <p class="text-xs text-gray-500">{formatNumber($stats.totalCharsRead)} total</p>
          </div>
          <ChartLineUpOutline size="lg" class="text-blue-500" />
        </div>
      </Card>

      <!-- Volumes Completed -->
      <Card class="max-w-none">
        <div class="flex items-center justify-between">
          <div>
            <p class="text-sm text-gray-400 mb-1">Volumes Completed</p>
            <p class="text-2xl font-bold">{$totalCompletedVolumes}</p>
            <p class="text-xs text-gray-500">({$stats.volumesCompleted} tracked)</p>
          </div>
          <BookSolid size="lg" class="text-green-500" />
        </div>
      </Card>

      <!-- Total Time -->
      <Card class="max-w-none">
        <div class="flex items-center justify-between">
          <div>
            <p class="text-sm text-gray-400 mb-1">Total Time</p>
            <p class="text-2xl font-bold">{formatDuration($stats.totalTimeMinutes)}</p>
            {#if $stats.speedTrend !== 0}
              <div class="flex items-center gap-1 text-xs mt-1">
                {#if getTrendIcon($stats.speedTrend)}
                  <svelte:component this={getTrendIcon($stats.speedTrend)} size="xs"
                    class={$stats.speedTrend > 0 ? 'text-green-500' : 'text-red-500'} />
                {/if}
                <span class={$stats.speedTrend > 0 ? 'text-green-500' : 'text-red-500'}>
                  {Math.abs(Math.round($stats.speedTrend))}% {$stats.speedTrendLabel}
                </span>
              </div>
            {/if}
          </div>
          <ClockSolid size="lg" class="text-purple-500" />
        </div>
      </Card>
    </div>

    <!-- Achievement Badges -->
    {#if showAllAchievements || $stats.badges.length > 0}
      <Card class="mb-6 w-full max-w-none">
        <div class="flex items-center justify-between mb-4">
          <div class="flex items-center gap-2">
            <AwardSolid size="md" class="text-yellow-500" />
            <span class="font-semibold">Achievements</span>
          </div>
          <Button size="xs" color="alternative" on:click={() => showAllAchievements = !showAllAchievements}>
            {showAllAchievements ? 'Show My Achievements' : 'Show All Achievements'}
          </Button>
        </div>
        <div class="flex items-center gap-2 flex-wrap w-full">
          {#each (showAllAchievements ? ALL_ACHIEVEMENTS : $stats.badges) as badge, index}
            {@const animation = getBadgeAnimation(badge)}
            {@const tierClass = getBadgeTierClass(badge)}
            {@const isUnlocked = $stats.badges.includes(badge)}
            {@const badges = showAllAchievements ? ALL_ACHIEVEMENTS : $stats.badges}
            {@const currentCategory = getBadgeCategory(badge)}
            {@const previousCategory = index > 0 ? getBadgeCategory(badges[index - 1]) : null}
            {@const needsSeparator = index > 0 && currentCategory !== previousCategory}

            {#if needsSeparator}
              <span class="text-gray-500 text-xl select-none">•</span>
            {/if}

            <span title={getBadgeTooltip(badge)}>
              <Badge
                color={getBadgeColor(badge)}
                large
                class="{showAllAchievements && !isUnlocked ? 'opacity-40' : ''} {animation} {tierClass}"
              >{badge}</Badge>
            </span>
          {/each}
        </div>
      </Card>
    {/if}

    <!-- Chart -->
    <Card class="mb-6 w-full max-w-none">
      <h2 class="text-xl font-semibold mb-4">Reading Speed Over Time</h2>
      <div class="w-full" style="height: 600px;">
        <canvas bind:this={chartCanvas}></canvas>
      </div>
    </Card>

    <!-- Series Breakdown -->
    {#if $seriesInfo.length > 0}
      <Card class="mb-6 w-full max-w-none">
        <h2 class="text-xl font-semibold mb-4">Speed by Series</h2>
        <div class="overflow-x-auto">
        <Table>
          <TableHead>
            <TableHeadCell>Series</TableHeadCell>
            <TableHeadCell>Volumes</TableHeadCell>
            <TableHeadCell>Avg Speed</TableHeadCell>
            <TableHeadCell>Improvement</TableHeadCell>
          </TableHead>
          <TableBody>
            {#each $seriesInfo as series}
              <TableBodyRow>
                <TableBodyCell>{series.seriesTitle}</TableBodyCell>
                <TableBodyCell>{series.volumeCount}</TableBodyCell>
                <TableBodyCell>{Math.round(series.averageSpeed)} cpm</TableBodyCell>
                <TableBodyCell>
                  {#if series.speedImprovement > 0}
                    <span class="text-green-500 flex items-center gap-1">
                      <ArrowUpOutline size="xs" />
                      +{Math.round(series.speedImprovement)}%
                    </span>
                  {:else if series.speedImprovement < 0}
                    <span class="text-red-500 flex items-center gap-1">
                      <ArrowDownOutline size="xs" />
                      {Math.round(series.speedImprovement)}%
                    </span>
                  {:else}
                    <span class="text-gray-500">-</span>
                  {/if}
                </TableBodyCell>
              </TableBodyRow>
            {/each}
          </TableBody>
        </Table>
        </div>
      </Card>
    {/if}

    <!-- Volume History -->
    <Card class="w-full max-w-none">
      <h2 class="text-xl font-semibold mb-4">Completed Volumes</h2>

      <div class="overflow-x-auto w-full">
      <Table hoverable={true}>
        <TableHead>
          <TableHeadCell class="cursor-pointer" on:click={() => toggleSort('series')}>
            Series {sortBy === 'series' ? (sortDirection === 'asc' ? '↑' : '↓') : ''}
          </TableHeadCell>
          <TableHeadCell class="cursor-pointer" on:click={() => toggleSort('volume')}>
            Volume {sortBy === 'volume' ? (sortDirection === 'asc' ? '↑' : '↓') : ''}
          </TableHeadCell>
          <TableHeadCell class="cursor-pointer" on:click={() => toggleSort('speed')}>
            Speed {sortBy === 'speed' ? (sortDirection === 'asc' ? '↑' : '↓') : ''}
          </TableHeadCell>
          <TableHeadCell class="cursor-pointer" on:click={() => toggleSort('duration')}>
            Duration {sortBy === 'duration' ? (sortDirection === 'asc' ? '↑' : '↓') : ''}
          </TableHeadCell>
          <TableHeadCell class="cursor-pointer" on:click={() => toggleSort('dateFinished')}>
            Date Finished {sortBy === 'dateFinished' ? (sortDirection === 'asc' ? '↑' : '↓') : ''}
          </TableHeadCell>
          <TableHeadCell>Actions</TableHeadCell>
        </TableHead>
        <TableBody>
          {#each sortedVolumes as volume}
            <TableBodyRow>
              <TableBodyCell>{volume.seriesTitle}</TableBodyCell>
              <TableBodyCell>{volume.volumeTitle}</TableBodyCell>
              <TableBodyCell>
                <div class="flex flex-col">
                  <span class="font-semibold">{Math.round(volume.charsPerMinute)} cpm</span>
                  <span class="text-xs" class:text-green-500={volume.percentVsAverage > 0}
                        class:text-red-500={volume.percentVsAverage < 0}>
                    {volume.percentVsAverage > 0 ? '+' : ''}{Math.round(volume.percentVsAverage)}% vs avg
                  </span>
                </div>
              </TableBodyCell>
              <TableBodyCell>
                <div class="text-sm">{formatDuration(volume.durationMinutes)}</div>
                <div class="text-xs text-gray-500">{formatNumber(volume.charsRead)} chars</div>
              </TableBodyCell>
              <TableBodyCell>
                <div class="text-sm">{formatRelativeDate(volume.completionDate)}</div>
                <div class="text-xs text-gray-500">{volume.completionDate.toLocaleDateString()}</div>
              </TableBodyCell>
              <TableBodyCell>
                <Button size="xs" color="red" on:click={() => confirmDelete(volume)}>
                  <TrashBinSolid class="w-3 h-3" />
                </Button>
              </TableBodyCell>
            </TableBodyRow>
          {/each}
        </TableBody>
      </Table>
      </div>
    </Card>
  {/if}
</div>

<!-- Delete Confirmation Modal -->
<Modal bind:open={deleteModalOpen} size="xs" autoclose={false}>
  <div class="text-center">
    <TrashBinSolid size="lg" class="mx-auto mb-4 text-gray-400 dark:text-gray-200" />
    <h3 class="mb-5 text-lg font-normal text-gray-500 dark:text-gray-400">
      Are you sure you want to delete reading data for<br />
      <span class="font-semibold">{volumeToDelete?.volumeTitle}</span>?
    </h3>
    <p class="mb-5 text-sm text-gray-400">
      This will permanently remove all progress, time, and speed data for this volume.
      This action cannot be undone.
    </p>
    <div class="flex justify-center gap-4">
      <Button color="red" on:click={deleteVolumeData}>
        Yes, delete
      </Button>
      <Button color="alternative" on:click={() => { deleteModalOpen = false; volumeToDelete = null; }}>
        Cancel
      </Button>
    </div>
  </div>
</Modal>

<style>
  :global(.dark) canvas {
    filter: brightness(0.95);
  }

  /* Custom tier colors for badges */
  :global(.badge-tier-grey) {
    background-color: #374151 !important;
    color: #E5E7EB !important;
  }

  :global(.badge-tier-bronze) {
    background: linear-gradient(135deg, #A0522D 0%, #8B4513 100%) !important;
    color: #FFF !important;
    border: none !important;
  }

  :global(.badge-tier-silver) {
    background: linear-gradient(135deg, #D1D5DB 0%, #9CA3AF 100%) !important;
    color: #1F2937 !important;
    border: none !important;
  }

  :global(.badge-tier-gold) {
    background: linear-gradient(135deg, #FFD700 0%, #FFA500 100%) !important;
    color: #1F2937 !important;
    border: none !important;
  }

  :global(.badge-tier-platinum) {
    background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%) !important;
    color: #FFF !important;
    border: none !important;
  }

  :global(.badge-tier-prismatic) {
    background: linear-gradient(135deg, #ec4899 0%, #8b5cf6 50%, #3b82f6 100%) !important;
    color: #FFF !important;
    border: none !important;
  }

  /* Tier 6: Prestige Bronze - Bronze shimmer with sweep effect */
  @keyframes bronze-shimmer {
    0% {
      background: linear-gradient(135deg, #A0522D 0%, #8B4513 100%);
    }
    50% {
      background: linear-gradient(135deg, #FFB366 0%, #F4A460 30%, #D2691E 50%, #A0522D 70%, #8B4513 100%);
    }
    100% {
      background: linear-gradient(135deg, #A0522D 0%, #8B4513 100%);
    }
  }

  :global(.badge-bronze-shimmer) {
    animation: bronze-shimmer 3s linear infinite;
    box-shadow: 0 0 12px rgba(160, 82, 45, 0.8), 0 0 20px rgba(160, 82, 45, 0.5);
  }

  /* Tier 7: Prestige Silver - Silver sparkle with sweep effect */
  @keyframes silver-sparkle {
    0% {
      background: linear-gradient(135deg, #D1D5DB 0%, #9CA3AF 100%);
    }
    50% {
      background: linear-gradient(135deg, #FFFFFF 0%, #F9FAFB 30%, #E5E7EB 50%, #D1D5DB 70%, #9CA3AF 100%);
    }
    100% {
      background: linear-gradient(135deg, #D1D5DB 0%, #9CA3AF 100%);
    }
  }

  :global(.badge-silver-sparkle) {
    animation: silver-sparkle 2.5s linear infinite;
    box-shadow: 0 0 10px rgba(255, 255, 255, 0.8);
  }

  /* Tier 8: Prestige Gold - Gold glow with sweep effect */
  @keyframes gold-glow {
    0% {
      background: linear-gradient(135deg, #FFD700 0%, #FFA500 100%);
    }
    50% {
      background: linear-gradient(135deg, #FFFBCC 0%, #FFEC80 30%, #FFE066 50%, #FFD700 70%, #FFA500 100%);
    }
    100% {
      background: linear-gradient(135deg, #FFD700 0%, #FFA500 100%);
    }
  }

  :global(.badge-gold-glow) {
    animation: gold-glow 3s linear infinite;
    box-shadow: 0 0 15px rgba(234, 179, 8, 0.8), 0 0 25px rgba(234, 179, 8, 0.6);
  }

  /* Tier 9: Prestige Platinum - Platinum with sweep effect */
  @keyframes platinum-pulse {
    0% {
      background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
    }
    50% {
      background: linear-gradient(135deg, #dbeafe 0%, #bfdbfe 30%, #93c5fd 50%, #3b82f6 70%, #2563eb 100%);
    }
    100% {
      background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
    }
  }

  :global(.badge-platinum-pulse) {
    animation: platinum-pulse 2.5s linear infinite;
    box-shadow: 0 0 18px rgba(59, 130, 246, 0.8), 0 0 30px rgba(59, 130, 246, 0.5);
  }

  /* Tier 10: Mythic Prismatic - Ultimate rainbow effect with multi-layered glow */
  @keyframes prismatic-rainbow {
    0% { filter: hue-rotate(0deg) brightness(1.3) saturate(1.8); }
    100% { filter: hue-rotate(360deg) brightness(1.3) saturate(1.8); }
  }

  @keyframes prismatic-glow {
    0%, 100% {
      box-shadow:
        0 0 10px rgba(236, 72, 153, 0.7),
        0 0 20px rgba(139, 92, 246, 0.5),
        0 0 30px rgba(59, 130, 246, 0.3);
    }
    50% {
      box-shadow:
        0 0 20px rgba(236, 72, 153, 0.9),
        0 0 40px rgba(139, 92, 246, 0.7),
        0 0 60px rgba(59, 130, 246, 0.5);
    }
  }

  :global(.badge-prismatic) {
    animation:
      prismatic-rainbow 3s linear infinite,
      prismatic-glow 2s ease-in-out infinite;
  }
</style>
