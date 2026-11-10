import { describe, expect, it } from 'vitest';
import {
  volumeBackupCommand,
  volumeDownloadCommand,
  volumePagesCommand,
  type VolumeRowState
} from './volume-row-commands';

const row = (over: Partial<VolumeRowState> = {}): VolumeRowState => ({
  installed: true,
  hasProvider: true,
  readOnly: false,
  cloudLoading: false,
  backedUp: false,
  hasCloudFile: false,
  downloading: false,
  ...over
});

describe('the Backup key', () => {
  it('backs up a volume the cloud does not have', () => {
    expect(volumeBackupCommand(row())).toEqual({ run: true });
  });

  it('never runs on a backed-up volume: it says so, and the menu’s delete is not its business', () => {
    // The menu item in this state reads "Delete from cloud". The key must not
    // reach it under any other combination either.
    for (const installed of [true, false]) {
      for (const hasProvider of [true, false]) {
        for (const readOnly of [true, false]) {
          for (const cloudLoading of [true, false]) {
            const state = row({ backedUp: true, installed, hasProvider, readOnly, cloudLoading });
            expect(volumeBackupCommand(state).run, JSON.stringify(state)).toBe(false);
          }
        }
      }
    }
    expect(volumeBackupCommand(row({ backedUp: true }))).toEqual({
      run: false,
      reason: 'Already backed up'
    });
  });

  it('does not guess while the listing is loading: backed up or not is unknown', () => {
    expect(volumeBackupCommand(row({ cloudLoading: true }))).toEqual({
      run: false,
      reason: 'Cloud status is still loading'
    });
  });

  it('applies the menu item’s own test: installed, connected, writable', () => {
    expect(volumeBackupCommand(row({ installed: false })).run).toBe(false);
    expect(volumeBackupCommand(row({ hasProvider: false }))).toEqual({
      run: false,
      reason: 'Connect cloud storage to back up'
    });
    expect(volumeBackupCommand(row({ readOnly: true }))).toEqual({
      run: false,
      reason: 'This cloud connection is read-only'
    });
  });
});

describe('the Download key', () => {
  it('downloads a volume that is not here and that the cloud has', () => {
    expect(volumeDownloadCommand(row({ installed: false, hasCloudFile: true }))).toEqual({
      run: true
    });
  });

  it('says why otherwise', () => {
    expect(volumeDownloadCommand(row({ hasCloudFile: true }))).toEqual({
      run: false,
      reason: 'Already on this device'
    });
    expect(
      volumeDownloadCommand(row({ installed: false, hasCloudFile: true, downloading: true }))
    ).toEqual({ run: false, reason: 'Already downloading' });
    expect(volumeDownloadCommand(row({ installed: false }))).toEqual({
      run: false,
      reason: 'Not in the connected cloud storage'
    });
  });
});

describe('View text and Extract', () => {
  it('need the pages', () => {
    expect(volumePagesCommand({ installed: true })).toEqual({ run: true });
    expect(volumePagesCommand({ installed: false }).run).toBe(false);
  });
});
