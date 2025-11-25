# Session-Based Reading Analytics - Implementation Plan

**Status:** Planning Phase
**Created:** 2025-01-30
**Priority:** High (enables accurate reading speed tracking and stats page)

## Executive Summary

Implement session-based reading tracking to enable:

- Accurate reading speed calculation (chars/minute)
- Time-to-finish estimates (personalized)
- Historical performance tracking
- Reread detection
- Future stats/analytics page

## Core Problems Solved

Current limitations:

- ❌ No session boundaries → can't separate struggling early attempts from later mastery
- ❌ Rereading pollutes metrics → time keeps accumulating
- ❌ Too coarse (minutes only) → can't filter "marked as read" vs actually read
- ❌ No historical view → can't show improvement over time

What we need:

- ✅ Session-level granularity with automatic boundaries
- ✅ Page-read timestamps while session is active
- ✅ Automatic compaction when session ends
- ✅ Separate reread sessions from first reads
- ✅ Accurate chars-per-minute calculation
- ✅ Time-to-finish estimates
- ✅ Historical trend data for stats page

---

## Data Structure

### Page Turn Entry (Minimal Format)

```typescript
// Super compact: just [timestamp, page]
// Char count looked up from volume data when needed
type PageTurn = [number, number]; // [timestamp_ms, page_number]
```

### Reading Session

```typescript
type ReadingSession = {
  id: string; // UUID for uniqueness
  volumeId: string; // Which volume this session is for

  // Compact page turn log: [[timestamp, page], [timestamp, page], ...]
  // Duration calculated as difference between consecutive timestamps
  // Char count looked up from volume page data when calculating stats
  turns: PageTurn[];
};
```

**Benefits:**

- 2 numbers per page turn instead of 4 fields
- No redundant data (duration calculated on-demand, chars looked up)
- Smaller JSON serialization
- Simple to work with

### Enhanced Volume Data

```typescript
type VolumeData = {
  // === BACKWARD COMPATIBLE: Keep existing fields ===
  progress: number; // Current page
  chars: number; // Total chars read
  completed: boolean; // Ever completed?
  timeReadInMinutes: number; // Aggregate time (for compatibility)
  lastProgressUpdate: string; // ISO timestamp
  settings: VolumeSettings;

  // === NEW: Session-based tracking ===
  activeSession?: ReadingSession; // Current session (with detailed events)
  sessions: ReadingSession[]; // Historical sessions (with full events)
  totalSessions: number; // Counter for sessionNumber
};
```

### Storage Impact

Using compact `[timestamp, page]` tuples:

- **Per page turn:** 2 integers = ~16 bytes in JSON
- **200-page session:** ~3.2 KB
- **10 sessions:** ~32 KB
- **100 sessions:** ~320 KB
- **For 100 volumes (avg 20 sessions each):** ~6.4 MB

**Much better than original design!** Still room for future compression if needed, but this format is simple and efficient.

---

## Session Lifecycle

### 1. Session Start (Automatic Detection)

**New session starts when:**

- No `activeSession` exists
- Last activity was > 30 minutes ago (configurable)
- User navigates to volume from catalog (intentional start)

```typescript
function startNewSession(volumeId: string, initialPage: number) {
  const now = Date.now();
  const session: ReadingSession = {
    id: generateUUID(),
    volumeId,
    turns: [[now, initialPage]] // First page turn
  };

  volumes[volumeId].activeSession = session;
  volumes[volumeId].totalSessions++;
}
```

### 2. During Session (Page Turn Tracking)

**On every page turn:**

```typescript
function onPageChange(volumeId: string, newPage: number) {
  const session = volumes[volumeId].activeSession;
  if (!session) {
    startNewSession(volumeId, newPage);
    return;
  }

  const now = Date.now();

  // Just append [timestamp, page] - super simple!
  session.turns.push([now, newPage]);

  // Update legacy fields for backward compat
  volumes[volumeId].progress = newPage;
  volumes[volumeId].lastProgressUpdate = new Date().toISOString();
}
```

### 3. Session End

**Session ends when:**

- Inactivity timeout (30+ min)
- User navigates away from volume
- User closes tab (beforeunload, best effort)
- Manual trigger

```typescript
function endSession(volumeId: string, volumeData: VolumePageData) {
  const session = volumes[volumeId].activeSession;
  if (!session) return;

  // Move to historical sessions
  volumes[volumeId].sessions.push(session);
  delete volumes[volumeId].activeSession;

  // Update legacy aggregate fields for backward compatibility
  const stats = calculateSessionStats(session, volumeData);
  volumes[volumeId].timeReadInMinutes += Math.ceil(stats.totalSeconds / 60);
  volumes[volumeId].chars += stats.totalChars;
}

// Helper: Calculate stats from turns (with break filtering)
function calculateSessionStats(session: ReadingSession, volumeData: VolumePageData) {
  const MAX_BREAK_MS = 5 * 60 * 1000; // 5 min = reading break
  let totalSeconds = 0;
  let totalChars = 0;

  for (let i = 1; i < session.turns.length; i++) {
    const [prevTime, prevPage] = session.turns[i - 1];
    const [currTime, currPage] = session.turns[i];

    const duration = (currTime - prevTime) / 1000;

    // Skip if break was too long (user walked away)
    if (duration > MAX_BREAK_MS / 1000) continue;

    totalSeconds += duration;
    totalChars += getCharCountForPage(volumeData, prevPage);
  }

  return { totalSeconds, totalChars };
}
```

---

## Reading Speed Calculation

### Handling Real Reading Behavior

The `[timestamp, page]` format captures actual behavior, including:

**Skimming/Preview:** User jumps ahead to preview, then returns to read properly

```
[[1000, 10], [1030, 15], [1040, 16], [1070, 10], [1100, 11], ...]
         └─ jumped to 15-16 ─┘  └─ returned to read from 10 ─┘
```

**Strategy for time attribution:**

1. Group turns by page number: `{10: [1000, 1070], 11: [1100], 15: [1030], 16: [1040]}`
2. For pages visited multiple times, sum all durations leading to that page
3. This accurately captures "time actually spent reading page 10" even if interrupted

**Example calculation for page 10:**

- First visit: `1030 - 1000 = 30s` (then jumped to preview)
- Second visit: `1100 - 1070 = 30s` (actually reading)
- Total time on page 10: `60s`

This naturally handles rereading, backtracking, and preview behaviors without special cases!

### Smart Session Filtering Algorithm

```typescript
interface ReadingSpeedResult {
  charsPerMinute: number;
  isPersonalized: boolean;
  confidence: 'high' | 'medium' | 'low' | 'none';
  sessionsUsed: number;
  recentSessions?: ReadingSession[];
}

function calculateReadingSpeed(
  volumes: Volumes,
  volumesData: VolumePageData[]
): ReadingSpeedResult {
  const MAX_BREAK_MS = 5 * 60 * 1000; // 5 min

  // Gather all historical sessions across all volumes
  const allSessions = Object.entries(volumes)
    .flatMap(([volumeId, volumeData]) =>
      volumeData.sessions.map((s) => ({
        session: s,
        pageData: volumesData.find((v) => v.volume_uuid === volumeId)
      }))
    )
    .filter((item) => item.session.turns.length >= 2 && item.pageData);

  // Calculate stats and filter invalid sessions
  const validSessions = allSessions
    .map(({ session, pageData }) => {
      // Group time spent by page (handles rereading/backtracking)
      const timePerPage = new Map<number, number>();

      // Process each turn pair
      for (let i = 1; i < session.turns.length; i++) {
        const [prevTime, prevPage] = session.turns[i - 1];
        const [currTime, currPage] = session.turns[i];
        const duration = (currTime - prevTime) / 1000;

        // Skip breaks
        if (duration > MAX_BREAK_MS / 1000) continue;

        // Accumulate time for this page (even if visited multiple times)
        const current = timePerPage.get(prevPage) || 0;
        timePerPage.set(prevPage, current + duration);
      }

      // Calculate totals
      let totalSeconds = 0;
      let totalChars = 0;

      for (const [page, duration] of timePerPage.entries()) {
        totalSeconds += duration;
        totalChars += getCharCountForPage(pageData!, page);
      }

      const pagesRead = timePerPage.size;
      const avgSecondsPerPage = pagesRead > 0 ? totalSeconds / pagesRead : 0;
      const charsPerMinute = totalSeconds > 0 ? (totalChars / totalSeconds) * 60 : 0;

      return {
        session,
        totalSeconds,
        totalChars,
        pagesRead,
        avgSecondsPerPage,
        charsPerMinute
      };
    })
    .filter((stats) => {
      // Must have read enough to be meaningful
      if (stats.pagesRead < 10) return false;

      // Must be reasonable speed (not "mark all as read")
      if (stats.avgSecondsPerPage < 5) return false;

      // Must have actual reading time
      if (stats.totalSeconds < 60) return false;

      // Reasonable CPM range (100-2000)
      if (stats.charsPerMinute < 100 || stats.charsPerMinute > 2000) return false;

      return true;
    });

  if (validSessions.length === 0) {
    return {
      charsPerMinute: 500, // Default
      isPersonalized: false,
      confidence: 'none',
      sessionsUsed: 0
    };
  }

  // Sort by most recent turn timestamp
  validSessions.sort((a, b) => {
    const aLastTurn = a.session.turns[a.session.turns.length - 1][0];
    const bLastTurn = b.session.turns[b.session.turns.length - 1][0];
    return bLastTurn - aLastTurn;
  });

  // Take last 5 sessions for averaging
  const recentSessions = validSessions.slice(0, 5);

  // Calculate weighted average (more recent = higher weight)
  let totalWeightedCPM = 0;
  let totalWeight = 0;

  recentSessions.forEach((stats, index) => {
    const weight = 1 / (index + 1); // 1.0, 0.5, 0.33, 0.25, 0.2
    totalWeightedCPM += stats.charsPerMinute * weight;
    totalWeight += weight;
  });

  const avgCPM = Math.round(totalWeightedCPM / totalWeight);

  // Determine confidence
  let confidence: 'high' | 'medium' | 'low' | 'none';
  if (recentSessions.length >= 5) confidence = 'high';
  else if (recentSessions.length >= 3) confidence = 'medium';
  else if (recentSessions.length >= 1) confidence = 'low';
  else confidence = 'none';

  return {
    charsPerMinute: avgCPM,
    isPersonalized: true,
    confidence,
    sessionsUsed: recentSessions.length,
    recentSessions: recentSessions.map((stats) => stats.session)
  };
}
```

---

## Time-to-Finish Display

### In Reader (next to timer)

```svelte
<script>
  let readingSpeed = $derived(calculateReadingSpeed($volumes));
  let remainingChars = $derived(volumeData.totalChars - $volumes[volumeId].chars);
  let estimatedMinutes = $derived(Math.ceil(remainingChars / readingSpeed.charsPerMinute));

  let displayText = $derived(() => {
    if (estimatedMinutes < 60) {
      return `~${estimatedMinutes} min left`;
    } else {
      const hours = Math.floor(estimatedMinutes / 60);
      const mins = estimatedMinutes % 60;
      return `~${hours}h ${mins}m left`;
    }
  });
</script>

<div class="timer-display">
  <p>Minutes read: {$volumeStats.timeReadInMinutes}</p>
  {#if readingSpeed.isPersonalized}
    <p class="estimate personalized" title="Based on your reading speed">
      {displayText} ⭐
    </p>
  {:else}
    <p class="estimate">{displayText}</p>
  {/if}
</div>
```

### On Series Page

```svelte
<script>
  let seriesEstimate = $derived(() => {
    const readingSpeed = calculateReadingSpeed($volumes);

    let totalRemainingChars = 0;
    seriesVolumes.forEach((volume) => {
      const volumeData = $volumes[volume.volume_uuid];
      const remainingChars = volume.char_count - (volumeData?.chars || 0);
      totalRemainingChars += remainingChars;
    });

    const minutes = Math.ceil(totalRemainingChars / readingSpeed.charsPerMinute);
    const hours = Math.floor(minutes / 60);

    return { hours, minutes: minutes % 60 };
  });
</script>

<div class="series-header">
  <h1>{seriesTitle}</h1>
  <p class="series-stats">
    {volumesComplete}/{totalVolumes} volumes complete
    {#if seriesEstimate.hours > 0}
      • ~{seriesEstimate.hours}h {seriesEstimate.minutes}m remaining
    {/if}
  </p>
</div>
```

---

## Future Stats Page Features

### MVP Stats Page Route: `/stats`

**Overall Statistics:**

- Total volumes completed
- Total pages read
- Total characters read
- Total time spent reading
- Current reading speed (CPM)
- All-time fastest/slowest sessions

**Reading Speed Trends:**

- Line chart: CPM over time (last 30 sessions)
- X-axis: Session date
- Y-axis: Characters per minute
- Trend line indicating improvement

**Volume Performance:**

- Bar chart: Sessions per volume
- Show which volumes took multiple attempts
- Tooltip: Session details (date, duration, CPM)

**Recent Activity:**

- List of last 10 sessions with details

**Achievements/Milestones:**

- "Speed Demon" - Read at 1000+ CPM
- "Marathon Reader" - 3+ hour session
- "Dedicated" - 10 volumes completed
- "Improving" - 20% speed increase over last 10 sessions

---

## Implementation Phases

### Phase 1: Core Session Tracking (Week 1)

- [ ] Update `VolumeData` type with session fields
- [ ] Add session start/end logic to reader
- [ ] Implement page event tracking
- [ ] Migration script for existing data
- [ ] Backward compatibility tests

> **Note:** Automatic compaction deferred to future phase. All sessions retain full event data.

### Phase 2: Reading Speed & Estimates (Week 2)

- [ ] Create `reading-speed.ts` utility
- [ ] Implement smart session filtering
- [ ] Add time-to-finish to reader UI
- [ ] Add time-to-finish to series page
- [ ] Add personalized indicator tooltips

### Phase 3: Stats Page (Week 3)

- [ ] Create `/stats` route
- [ ] Implement overall statistics display
- [ ] Add CPM trend chart (using Chart.js)
- [ ] Add volume performance visualization
- [ ] Add recent activity list
- [ ] Polish UI and responsive design

### Phase 4: Advanced Features (Future)

- [ ] Session data compaction/compression (when needed)
- [ ] Reading goals & challenges
- [ ] Export stats as CSV/JSON
- [ ] Comparison with other readers (anonymized, opt-in)
- [ ] Series difficulty ratings based on community CPM
- [ ] Reading streaks and calendar view

---

## Success Metrics

**Technical:**

- ✅ No performance degradation in reader
- ✅ 100% backward compatibility
- ✅ Reliable session end detection (>95%)
- ✅ Storage usage acceptable for typical usage patterns (<5 MB for most users)

**User Experience:**

- ✅ Time estimates within 20% accuracy
- ✅ Visible improvement trend after 5+ sessions
- ✅ Stats page loads < 500ms
- ✅ Clear "personalized" vs "default" indicators

---

## Open Questions / Decisions Needed

1. **Session timeout duration:** 30 minutes reasonable? Or make it configurable?
2. **Minimum session validity:** 10 pages + 5 sec/page + 1 min total? Adjust thresholds?
3. **Stats page priority:** Build now or after Phase 2 feedback?
4. **Data retention:** Keep all sessions forever, or cap at 100 most recent?
5. **Reread detection:** Manual trigger button, or automatic based on completion status?
6. **Export feature:** Important for early adopters, or can wait?

---

## Files to Modify

### New Files

- `src/lib/util/reading-speed.ts` - Reading speed calculation logic
- `src/lib/util/session-tracking.ts` - Session lifecycle management
- `src/routes/stats/+page.svelte` - Stats page (Phase 3)

### Modified Files

- `src/lib/settings/volume-data.ts` - Add session fields to VolumeData
- `src/lib/components/Reader/Reader.svelte` - Integrate session tracking
- `src/lib/components/Reader/Timer.svelte` - Add time-to-finish display
- `src/routes/[manga]/+page.svelte` - Add series time estimate
- `src/routes/[manga]/[volume]/text/+page.svelte` - Use personalized estimates

---

## Notes

- **Backward compatibility is critical** - users must not lose existing data
- **Migration strategy:** Add new fields as optional, populate gradually
- **Performance:** No compaction initially; all event data retained
- **Storage:** For typical usage (~10-20 sessions per volume), storage is negligible
- **Privacy:** All data stays local, no telemetry unless user opts in
- **Testing:** Need comprehensive tests for edge cases (very fast, very slow, rereads)
- **Future optimization:** Consider compaction or compression if storage becomes an issue

---

**Next Steps:** Prioritize Phase 1 implementation after text view PR is merged.
