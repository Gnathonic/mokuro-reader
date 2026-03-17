import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildTileConfig, applyUrlParamOverrides, type TileConfig } from './tile-config';

describe('buildTileConfig', () => {
	it('should return defaults when no overrides', () => {
		const config = buildTileConfig();
		expect(config.tileSize).toBe(512);
		expect(config.borderPx).toBe(2);
		expect(config.contentSize).toBe(508); // 512 - 2*2
		expect(config.scalingMode).toBe('bilinear');
		expect(config.maxConcurrentUploads).toBe(2);
	});

	it('should compute contentSize from tileSize and borderPx', () => {
		const config = buildTileConfig({ tileSize: 256, borderPx: 4 });
		expect(config.contentSize).toBe(248); // 256 - 4*2
	});

	it('should accept partial overrides', () => {
		const config = buildTileConfig({ tileSize: 1024 });
		expect(config.tileSize).toBe(1024);
		expect(config.borderPx).toBe(2); // default
		expect(config.contentSize).toBe(1020);
	});

	it('should handle zero border', () => {
		const config = buildTileConfig({ borderPx: 0 });
		expect(config.contentSize).toBe(512); // tileSize - 0
	});

	it('should override scaling mode', () => {
		const config = buildTileConfig({ scalingMode: 'lanczos' });
		expect(config.scalingMode).toBe('lanczos');
	});
});

describe('applyUrlParamOverrides', () => {
	const base = buildTileConfig();
	let originalLocation: Location;

	beforeEach(() => {
		originalLocation = window.location;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('should return base config when no URL params', () => {
		vi.stubGlobal('location', { search: '' });
		const result = applyUrlParamOverrides(base);
		expect(result).toBe(base); // same reference, no rebuild
	});

	it('should override tileSize from URL', () => {
		vi.stubGlobal('location', { search: '?tileSize=256' });
		const result = applyUrlParamOverrides(base);
		expect(result.tileSize).toBe(256);
		expect(result.contentSize).toBe(252); // 256 - 2*2
	});

	it('should override multiple params', () => {
		vi.stubGlobal('location', { search: '?tileSize=256&scaling=lanczos&border=3' });
		const result = applyUrlParamOverrides(base);
		expect(result.tileSize).toBe(256);
		expect(result.scalingMode).toBe('lanczos');
		expect(result.borderPx).toBe(3);
		expect(result.contentSize).toBe(250); // 256 - 3*2
	});
});
