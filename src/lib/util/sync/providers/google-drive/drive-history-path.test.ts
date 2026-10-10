import { describe, expect, it } from 'vitest';
import { driveHistoryPath } from './drive-history-path';

const folders = new Map([
  ['reader', { name: 'mokuro-reader' }],
  ['hist', { name: 'history', parent: 'reader' }],
  ['dev', { name: 'dev-a', parent: 'hist' }],
  ['other-hist', { name: 'history', parent: 'elsewhere' }],
  ['dev2', { name: 'dev-a', parent: 'other-hist' }],
  ['series', { name: 'Some Series', parent: 'reader' }]
]);

describe('driveHistoryPath', () => {
  it('walks up to mokuro-reader/history/<device>', () => {
    expect(
      driveHistoryPath({ name: '2026-10.events', parents: ['dev'] }, folders, 'mokuro-reader')
    ).toBe('history/dev-a/2026-10.events');
  });
  it('rejects a history folder outside mokuro-reader, or a file in a series folder', () => {
    expect(
      driveHistoryPath({ name: '2026-10.events', parents: ['dev2'] }, folders, 'mokuro-reader')
    ).toBeNull();
    expect(
      driveHistoryPath({ name: 'device.json', parents: ['series'] }, folders, 'mokuro-reader')
    ).toBeNull();
    expect(driveHistoryPath({ name: '2026-10.events' }, folders, 'mokuro-reader')).toBeNull();
  });
});
