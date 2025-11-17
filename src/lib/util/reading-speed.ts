import type { AggregateSession, PageTurn } from '$lib/settings/volume-data';

/**
 * Format volume name for logging: "Series/Volume (uuid)" or fallback to uuid
 */
function formatVolumeName(
	volumeData: {
		series_title?: string;
		volume_title?: string;
	},
	volumeId: string
): string {
	if (volumeData.series_title && volumeData.volume_title) {
		return `${volumeData.series_title}/${volumeData.volume_title} (${volumeId.slice(0, 8)}...)`;
	}
	return volumeId.slice(0, 8) + '...';
}

// Reading speed estimation constants
export const SESSION_DATA_HOURS = 4; // Hours of page-level session data to keep/use
export const ESTIMATION_HOURS = 8; // Total hours of reading data to use for speed estimates

/**
 * Calculate statistics from page turns
 * Now uses character counts stored in page turns, no longer needs pages array
 * NOTE: Only works with 3-tuple format [timestamp, page, chars]
 */
function calculateTurnStats(
	turns: PageTurn[],
	idleTimeoutMs: number
): {
	totalSeconds: number;
	totalChars: number;
	pagesRead: number;
	avgSecondsPerPage: number;
	charsPerMinute: number;
} {
	// Group time spent by page (handles rereading/backtracking)
	const timePerPage = new Map<number, { duration: number; chars: number }>();

	// Process each turn pair
	for (let i = 1; i < turns.length; i++) {
		const prevTurn = turns[i - 1];
		const currTurn = turns[i];

		// Skip 2-tuple format (legacy data without character counts)
		if (prevTurn.length < 3 || currTurn.length < 3) continue;

		const [prevTime, prevPage, prevChars] = prevTurn;
		const [currTime, , currChars] = currTurn;
		const duration = (currTime - prevTime) / 1000;

		// Skip idle periods (user configured timeout)
		if (duration > idleTimeoutMs / 1000) continue;

		// Calculate chars read on this page (difference between cumulative counts)
		const charsOnPage = currChars - prevChars;

		// Accumulate time and chars for this page
		const current = timePerPage.get(prevPage) || { duration: 0, chars: 0 };
		timePerPage.set(prevPage, {
			duration: current.duration + duration,
			chars: current.chars + charsOnPage
		});
	}

	// Calculate totals
	let totalSeconds = 0;
	let totalChars = 0;

	for (const { duration, chars } of timePerPage.values()) {
		totalSeconds += duration;
		totalChars += chars;
	}

	const pagesRead = timePerPage.size;
	const avgSecondsPerPage = pagesRead > 0 ? totalSeconds / pagesRead : 0;
	const charsPerMinute = totalSeconds > 0 ? (totalChars / totalSeconds) * 60 : 0;

	return {
		totalSeconds,
		totalChars,
		pagesRead,
		avgSecondsPerPage,
		charsPerMinute
	};
}

export interface ReadingSpeedResult {
	charsPerMinute: number;
	isPersonalized: boolean;
	confidence: 'high' | 'medium' | 'low' | 'none';
	sessionsUsed: number;
}

interface TurnStatsWithVolume {
	totalSeconds: number;
	totalChars: number;
	pagesRead: number;
	avgSecondsPerPage: number;
	charsPerMinute: number;
	volumeId: string;
}

/**
 * Legacy session-based calculation - DEPRECATED
 * TODO: Once compaction algorithm is implemented, this can work with aggregate sessions
 * For now, just fall back to completed volumes calculation
 */
export function calculateReadingSpeedFromSessions(
	volumesData: Record<string, { sessions?: AggregateSession[] }>,
	_idleTimeoutMinutes: number
): ReadingSpeedResult {
	// Since compaction algorithm isn't ready yet, aggregate sessions won't be populated
	// Fall back to completed volumes calculation

	return {
		charsPerMinute: 100, // Default for manga
		isPersonalized: false,
		confidence: 'none',
		sessionsUsed: 0
	};
}

/**
 * Calculate reading speed using hybrid approach:
 * 1. Use up to SESSION_DATA_HOURS of recent page-level data (recentPageTurns)
 * 2. Fill remaining time (up to ESTIMATION_HOURS total) with aggregate session data
 * 3. Fill remaining time with completed volume data
 *
 * NOTE: Currently compaction algorithm isn't implemented, so aggregate sessions won't be populated.
 * This primarily relies on completed volume data for now.
 */
export function calculateReadingSpeed(
	volumesData: Record<string, {
		completed: boolean;
		timeReadInMinutes: number;
		chars: number;
		lastProgressUpdate: string;
		recentPageTurns?: PageTurn[];
		sessions?: AggregateSession[];
		series_title?: string;
		series_uuid?: string;
		volume_title?: string;
	}>,
	idleTimeoutMinutes: number
): ReadingSpeedResult {
	const SESSION_DATA_MINUTES = SESSION_DATA_HOURS * 60;
	const ESTIMATION_MINUTES = ESTIMATION_HOURS * 60;
	const idleTimeoutMs = idleTimeoutMinutes * 60 * 1000;

	// Step 1: Try to gather recent page-level data from recentPageTurns
	const allTurnData: Array<{ turns: PageTurn[]; volumeId: string; volumeData: typeof volumesData[string] }> = [];

	for (const [volumeId, volumeData] of Object.entries(volumesData)) {
		if (!volumeData.recentPageTurns || volumeData.recentPageTurns.length < 2) {
			continue;
		}

		allTurnData.push({
			turns: volumeData.recentPageTurns,
			volumeId,
			volumeData
		});
	}

	// Calculate stats from turn data
	const validTurnStats = allTurnData
		.map(({ turns, volumeId, volumeData }): TurnStatsWithVolume | null => {
			const stats = calculateTurnStats(turns, idleTimeoutMs);

			// Only validate CPM is reasonable (not trying to game the system)
			if (stats.charsPerMinute <= 0 || stats.charsPerMinute > 1000) {
				return null;
			}

			return {
				volumeId,
				...stats
			};
		})
		.filter((s): s is TurnStatsWithVolume => s !== null);

	// Sort by most recent (last turn timestamp)
	validTurnStats.sort((a, b) => {
		const aTurns = allTurnData.find(t => t.volumeId === a.volumeId)?.turns || [];
		const bTurns = allTurnData.find(t => t.volumeId === b.volumeId)?.turns || [];
		const aLastTurn = aTurns.length > 0 ? aTurns[aTurns.length - 1][0] : 0;
		const bLastTurn = bTurns.length > 0 ? bTurns[bTurns.length - 1][0] : 0;
		return bLastTurn - aLastTurn;
	});

	// Take turn data up to SESSION_DATA_HOURS
	let turnMinutes = 0;
	const recentTurnStats: TurnStatsWithVolume[] = [];

	for (const stats of validTurnStats) {
		const statMinutes = stats.totalSeconds / 60;
		if (turnMinutes + statMinutes > SESSION_DATA_MINUTES) break;
		recentTurnStats.push(stats);
		turnMinutes += statMinutes;
	}

	// Step 2: Use aggregate sessions (when compaction is implemented)
	// For now, this will be empty since compaction isn't implemented yet
	const aggregateSessions: Array<AggregateSession & { volumeId: string; timestamp?: number }> = [];

	for (const [volumeId, volumeData] of Object.entries(volumesData)) {
		if (!volumeData.sessions || volumeData.sessions.length === 0) continue;

		for (const session of volumeData.sessions) {
			// Strict validation - ensure fields exist and are valid numbers
			if (typeof session.durationMs !== 'number' || typeof session.charsRead !== 'number') continue;
			if (!isFinite(session.durationMs) || !isFinite(session.charsRead)) continue;
			if (session.durationMs <= 0 || session.charsRead <= 0) continue;

			const cpm = (session.charsRead / session.durationMs) * 60 * 1000;
			if (!isFinite(cpm) || cpm <= 0 || cpm > 1000) continue;

			aggregateSessions.push({ ...session, volumeId });
		}
	}

	// Take aggregate sessions to fill more time (up to SESSION_DATA_HOURS total)
	let aggregateMinutes = 0;
	const recentAggregateSessions: typeof aggregateSessions = [];
	const remainingSessionMinutes = SESSION_DATA_MINUTES - turnMinutes;

	for (const session of aggregateSessions) {
		const sessionMinutes = session.durationMs / (60 * 1000);
		if (!isFinite(sessionMinutes) || sessionMinutes <= 0) continue;
		if (aggregateMinutes + sessionMinutes > remainingSessionMinutes) break;
		recentAggregateSessions.push(session);
		aggregateMinutes += sessionMinutes;
	}

	// Step 3: Fill remaining time with completed volume data
	const remainingMinutes = ESTIMATION_MINUTES - turnMinutes - aggregateMinutes;

	const completedVolumes = Object.entries(volumesData)
		.filter(([volumeId, data]) => {
			return data.completed && data.chars > 0 && data.timeReadInMinutes > 0;
		})
		.map(([volumeId, data]) => ({
			volumeId,
			...data,
			cpm: data.chars / data.timeReadInMinutes
		}))
		.filter(volume => volume.cpm > 0 && volume.cpm <= 1000)
		.sort((a, b) => {
			return new Date(b.lastProgressUpdate).getTime() - new Date(a.lastProgressUpdate).getTime();
		});

	// Take enough completed volumes to fill remaining time
	let volumeMinutes = 0;
	const recentVolumes: typeof completedVolumes = [];

	for (const volume of completedVolumes) {
		if (volumeMinutes >= remainingMinutes) break;
		recentVolumes.push(volume);
		volumeMinutes += volume.timeReadInMinutes;
	}

	// Step 4: Calculate combined CPM
	if (recentTurnStats.length === 0 && recentAggregateSessions.length === 0 && recentVolumes.length === 0) {
		return {
			charsPerMinute: 100, // Default for manga
			isPersonalized: false,
			confidence: 'none',
			sessionsUsed: 0
		};
	}

	let totalChars = 0;
	let totalMinutes = 0;

	// Add turn data
	for (const stats of recentTurnStats) {
		totalChars += stats.totalChars;
		totalMinutes += stats.totalSeconds / 60;
	}

	// Add aggregate session data
	for (const session of recentAggregateSessions) {
		totalChars += session.charsRead;
		totalMinutes += session.durationMs / (60 * 1000);
	}

	// Add volume data
	for (const volume of recentVolumes) {
		totalChars += volume.chars;
		totalMinutes += volume.timeReadInMinutes;
	}

	const avgCPM = Math.round(totalChars / totalMinutes);

	// Determine confidence based on total data
	let confidence: 'high' | 'medium' | 'low' | 'none';
	if (totalMinutes >= ESTIMATION_MINUTES * 0.75) confidence = 'high';
	else if (totalMinutes >= ESTIMATION_MINUTES * 0.5) confidence = 'medium';
	else if (totalMinutes >= ESTIMATION_MINUTES * 0.25) confidence = 'low';
	else confidence = 'none';

	return {
		charsPerMinute: avgCPM,
		isPersonalized: true,
		confidence,
		sessionsUsed: recentTurnStats.length + recentAggregateSessions.length + recentVolumes.length
	};
}

/**
 * Legacy: Calculate reading speed from completed volumes only
 * Kept for backward compatibility
 */
export function calculateReadingSpeedFromCompletedVolumes(
	volumesData: Record<string, { completed: boolean; timeReadInMinutes: number; chars: number; lastProgressUpdate: string }>
): ReadingSpeedResult {
	// Filter to completed volumes only
	const completedVolumes = Object.entries(volumesData)
		.filter(([volumeId, data]) => {
			const hasCompleted = data.completed;
			const hasChars = data.chars > 0;
			const hasTime = data.timeReadInMinutes > 0;

			return hasCompleted && hasChars && hasTime;
		})
		.map(([volumeId, data]) => ({
			volumeId,
			...data
		}));

	if (completedVolumes.length === 0) {
		return {
			charsPerMinute: 100, // Default for manga (lower than novels)
			isPersonalized: false,
			confidence: 'none',
			sessionsUsed: 0
		};
	}

	// Sort by most recent completion (lastProgressUpdate)
	completedVolumes.sort((a, b) => {
		return new Date(b.lastProgressUpdate).getTime() - new Date(a.lastProgressUpdate).getTime();
	});

	// Calculate CPM and filter to valid speeds, keeping them sorted by recency
	const volumesWithCPM = completedVolumes
		.map(volume => ({
			...volume,
			cpm: volume.chars / volume.timeReadInMinutes
		}))
		.filter(volume => {
			// Only filter out unreasonably high speeds (likely "mark all as read")
			// No minimum - language learners read at their own pace
			const isValid = volume.cpm > 0 && volume.cpm <= 1000;
			return isValid;
		});

	// Take 3 most recent VALID volumes
	const recentVolumes = volumesWithCPM.slice(0, 3);

	if (recentVolumes.length === 0) {
		return {
			charsPerMinute: 100, // Default for manga (lower than novels)
			isPersonalized: false,
			confidence: 'none',
			sessionsUsed: 0
		};
	}

	// Calculate average CPM
	let totalCPM = 0;
	for (const volume of recentVolumes) {
		totalCPM += volume.cpm;
	}

	const validCount = recentVolumes.length;

	if (validCount === 0) {
		return {
			charsPerMinute: 100, // Default for manga (lower than novels)
			isPersonalized: false,
			confidence: 'none',
			sessionsUsed: 0
		};
	}

	const avgCPM = Math.round(totalCPM / validCount);

	// Determine confidence
	let confidence: 'high' | 'medium' | 'low' | 'none';
	if (validCount >= 3) confidence = 'high';
	else if (validCount >= 2) confidence = 'medium';
	else if (validCount >= 1) confidence = 'low';
	else confidence = 'none';

	return {
		charsPerMinute: avgCPM,
		isPersonalized: true,
		confidence,
		sessionsUsed: validCount
	};
}

/**
 * Calculate time to finish for a volume based on its total character count and progress
 * Pure function that can be used for any volume, not tied to current volume
 */
export function calculateVolumeTimeToFinish(
	totalChars: number,
	charsRead: number,
	readingSpeed: ReadingSpeedResult
): {
	minutes: number;
	hours: number;
	displayText: string;
} | null {
	if (totalChars === 0) {
		return null;
	}

	const remainingChars = totalChars - charsRead;

	if (remainingChars <= 0) {
		return null;
	}

	const minutes = Math.ceil(remainingChars / readingSpeed.charsPerMinute);
	const hours = Math.floor(minutes / 60);
	const mins = minutes % 60;

	let displayText: string;
	if (minutes < 60) {
		displayText = `~${minutes} min left`;
	} else {
		displayText = `~${hours}h ${mins}m left`;
	}

	return { minutes, hours, displayText };
}

/**
 * NOTE: Convenience functions using require() don't work in browser contexts.
 * Components should import stores directly and pass values to pure functions like
 * calculateVolumeTimeToFinish() instead.
 *
 * Example usage:
 *
 * import { volumes } from '$lib/settings';
 * import { personalizedReadingSpeed } from '$lib/settings/reading-speed';
 * import { currentVolumeCharacterCount } from '$lib/catalog';
 * import { calculateVolumeTimeToFinish } from '$lib/util/reading-speed';
 *
 * let timeEstimate = $derived.by(() => {
 *   const volumeProgress = $volumes[volumeId];
 *   const charsRead = volumeProgress?.chars || 0;
 *   return calculateVolumeTimeToFinish($currentVolumeCharacterCount, charsRead, $personalizedReadingSpeed);
 * });
 */

/**
 * Calculate estimated reading time for a total character count
 */
export function calculateEstimatedTime(
	totalChars: number,
	readingSpeed: ReadingSpeedResult
): {
	minutes: number;
	hours: number;
	displayText: string;
	isPersonalized: boolean;
} {
	const minutes = Math.ceil(totalChars / readingSpeed.charsPerMinute);
	const hours = Math.floor(minutes / 60);
	const mins = minutes % 60;

	let displayText: string;
	if (minutes < 60) {
		displayText = `${minutes} min`;
	} else if (mins === 0) {
		displayText = `${hours}h`;
	} else {
		displayText = `${hours}h ${mins}m`;
	}

	return {
		minutes,
		hours,
		displayText,
		isPersonalized: readingSpeed.isPersonalized
	};
}
