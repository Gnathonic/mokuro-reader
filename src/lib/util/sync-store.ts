import { writable } from 'svelte/store';

// Create a store to hold the sync function
export const syncFunctionStore = writable<(() => Promise<void>) | null>(null);