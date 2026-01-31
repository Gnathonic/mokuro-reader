import { test, expect, describe } from 'vitest';
import { parseHash, viewToHash, nav } from '$lib/util/hash-router';

describe('parseHash', () => {
	test('handles merge-series route', () => {
		const result = parseHash('#/merge-series');
		expect(result).toEqual({ type: 'merge-series' });
	});

	test('handles libraries route', () => {
		const result = parseHash('#/libraries');
		expect(result).toEqual({ type: 'libraries' });
	});

	test('handles add-library route without params', () => {
		const result = parseHash('#/add-library');
		expect(result).toEqual({ type: 'add-library', params: undefined });
	});

	test('handles add-library route with url param', () => {
		const result = parseHash('#/add-library?url=https://example.com/dav');
		expect(result).toEqual({
			type: 'add-library',
			params: { url: 'https://example.com/dav' }
		});
	});

	test('handles add-library route with URL-encoded url param', () => {
		const result = parseHash(
			'#/add-library?url=http%3A%2F%2F192.168.2.231%3A3923%2Fmokuro-reader'
		);
		expect(result).toEqual({
			type: 'add-library',
			params: { url: 'http://192.168.2.231:3923/mokuro-reader' }
		});
	});

	test('handles add-library route with multiple params', () => {
		const result = parseHash(
			'#/add-library?url=https://example.com/dav&name=My+Library&path=/manga'
		);
		expect(result).toEqual({
			type: 'add-library',
			params: {
				url: 'https://example.com/dav',
				name: 'My Library',
				path: '/manga'
			}
		});
	});

	test('handles add-library route with all params URL-encoded', () => {
		const result = parseHash(
			'#/add-library?url=http%3A%2F%2F192.168.2.231%3A3923%2Fmokuro-reader&name=Test+Library'
		);
		expect(result).toEqual({
			type: 'add-library',
			params: {
				url: 'http://192.168.2.231:3923/mokuro-reader',
				name: 'Test Library'
			}
		});
	});
});

describe('viewToHash', () => {
	test('generates merge-series hash', () => {
		const result = viewToHash({ type: 'merge-series' });
		expect(result).toBe('#/merge-series');
	});

	test('generates libraries hash', () => {
		const result = viewToHash({ type: 'libraries' });
		expect(result).toBe('#/libraries');
	});

	test('generates add-library hash without params', () => {
		const result = viewToHash({ type: 'add-library' });
		expect(result).toBe('#/add-library');
	});

	test('generates add-library hash with params', () => {
		const result = viewToHash({
			type: 'add-library',
			params: { url: 'https://example.com/dav', name: 'My Library' }
		});
		expect(result).toBe('#/add-library?url=https%3A%2F%2Fexample.com%2Fdav&name=My+Library');
	});
});

describe('nav helpers', () => {
	test('nav.toMergeSeries exists and is callable', () => {
		expect(typeof nav.toMergeSeries).toBe('function');
	});

	test('nav.toLibraries exists and is callable', () => {
		expect(typeof nav.toLibraries).toBe('function');
	});

	test('nav.toAddLibrary exists and is callable', () => {
		expect(typeof nav.toAddLibrary).toBe('function');
	});
});
