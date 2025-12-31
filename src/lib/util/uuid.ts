/**
 * Generates a UUID v4
 * Uses crypto.randomUUID when available, falls back to Math.random for older browsers (iOS Safari)
 */
export function generateUUID(): string {
	// Use crypto.randomUUID if available (modern browsers, secure contexts)
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}

	// Fallback for older environments or non-secure contexts
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === 'x' ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}
