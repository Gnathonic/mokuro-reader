/**
 * Tile renderer configuration and device capability detection.
 *
 * Manga pages are sliced into fixed-size tiles for GPU-friendly rendering.
 * Border padding reserves pixels at tile edges for filter kernel sampling.
 */

export type ScalingMode = 'nearest' | 'bilinear' | 'bicubic' | 'lanczos';

export interface TileConfig {
	tileSize: number; // texture dimensions (128 | 256 | 512 | 1024)
	borderPx: number; // filter kernel radius — pixels reserved per edge
	contentSize: number; // derived: tileSize - borderPx * 2 — never set directly
	scalingMode: ScalingMode; // filter quality
	maxConcurrentUploads: number; // upload pipeline throttle
}

/**
 * Build a TileConfig with derived contentSize.
 * contentSize is always computed from tileSize and borderPx to prevent desync.
 */
export function buildTileConfig(overrides?: Partial<Omit<TileConfig, 'contentSize'>>): TileConfig {
	const tileSize = overrides?.tileSize ?? 512;
	const borderPx = overrides?.borderPx ?? 2;
	return {
		tileSize,
		borderPx,
		contentSize: tileSize - borderPx * 2,
		scalingMode: overrides?.scalingMode ?? 'bilinear',
		maxConcurrentUploads: overrides?.maxConcurrentUploads ?? 2
	};
}

/**
 * Detect optimal tile config based on device capabilities.
 * Probes WebGL limits, memory, and platform to pick sensible defaults.
 */
export async function detectTileConfig(): Promise<TileConfig> {
	const canvas = document.createElement('canvas');
	const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
	const _maxTexture = gl?.getParameter(gl.MAX_TEXTURE_SIZE) ?? 2048;
	const memory = (navigator as any).deviceMemory ?? 4; // Chromium only, bucketed
	const concurrency = navigator.hardwareConcurrency ?? 4;
	const isIOS = /iP(ad|hone|od)/.test(navigator.userAgent);

	// Clean up probe canvas
	if (gl) {
		const ext = gl.getExtension('WEBGL_lose_context');
		ext?.loseContext();
	}

	// Probe GPU renderer for targeted detection
	const debugExt = gl?.getExtension('WEBGL_debug_renderer_info');
	const gpuRenderer = debugExt ? String(gl!.getParameter(debugExt.UNMASKED_RENDERER_WEBGL)) : '';

	// Old mobile GPUs with small texture caches — 256px required
	const isLowEndGPU = /Mali-T|Mali-4|Adreno\s*[34]\d\d|PowerVR\s*G[56]/i.test(gpuRenderer);

	// Tier 1: iOS, very low memory, or known low-end GPU
	if (isIOS || memory <= 2 || isLowEndGPU) {
		return buildTileConfig({
			tileSize: 512,
			scalingMode: 'bilinear',
			maxConcurrentUploads: 1
		});
	}

	// Tier 2: Low memory (<=4GB) with few cores — likely older device
	if (memory <= 4 && concurrency <= 4) {
		return buildTileConfig({
			tileSize: 512,
			scalingMode: 'bilinear',
			maxConcurrentUploads: 2
		});
	}

	// Tier 3: High-end (8GB+, 8+ cores)
	if (memory >= 8 && concurrency >= 8) {
		return buildTileConfig({
			tileSize: 512,
			scalingMode: 'bilinear',
			maxConcurrentUploads: 4
		});
	}

	// Tier 4: Mid-range default (includes modern phones with good GPUs)
	return buildTileConfig({ tileSize: 512, scalingMode: 'bilinear', maxConcurrentUploads: 2 });
}

/**
 * Apply URL parameter overrides for A/B testing.
 * Example: ?tileSize=256&scaling=bilinear&border=3&uploads=1
 */
export function applyUrlParamOverrides(base: TileConfig): TileConfig {
	if (typeof location === 'undefined') return base;

	const p = new URLSearchParams(location.search);
	const overrides: Partial<Omit<TileConfig, 'contentSize'>> = {};

	if (p.has('tileSize')) overrides.tileSize = Number(p.get('tileSize'));
	if (p.has('border')) overrides.borderPx = Number(p.get('border'));
	if (p.has('scaling')) overrides.scalingMode = p.get('scaling') as ScalingMode;
	if (p.has('uploads')) overrides.maxConcurrentUploads = Number(p.get('uploads'));

	// Only rebuild if we have overrides
	if (Object.keys(overrides).length === 0) return base;

	return buildTileConfig({ ...base, ...overrides });
}
