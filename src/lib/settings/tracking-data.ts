import { readable, type Readable } from 'svelte/store';
import { DEFAULT_K, type IdleSettings } from '$lib/reading-history/stats-engine';

/** The idle cutoff every stat uses. Phase 3a Task 3 makes it a synced setting. */
export const idleSettings: Readable<IdleSettings> = readable({ k: DEFAULT_K, overrideMs: null });
