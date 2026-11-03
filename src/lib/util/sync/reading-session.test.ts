import { afterEach, describe, expect, it } from 'vitest';
import { noteReaderClosed, noteReaderOpened } from '$lib/positions/reader-open';
import {
  clearVolumeDataDeferred,
  noteVolumeDataDeferred,
  readingSessionActive,
  takeVolumeDataDeferred,
  volumeDataDeferred
} from './reading-session';

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

afterEach(() => {
  noteReaderClosed('v');
  setVisibility('visible');
  clearVolumeDataDeferred();
});

describe('readingSessionActive', () => {
  it('the reader open on a volume and the document visible', () => {
    setVisibility('visible');
    noteReaderOpened('v');
    expect(readingSessionActive()).toBe(true);
  });

  it('no reader open: no session', () => {
    setVisibility('visible');
    expect(readingSessionActive()).toBe(false);
    noteReaderOpened('v');
    noteReaderClosed('v');
    expect(readingSessionActive()).toBe(false);
  });

  it('a hidden document: no session, and it is one again when visible', () => {
    noteReaderOpened('v');
    setVisibility('hidden');
    expect(readingSessionActive()).toBe(false);
    setVisibility('visible');
    expect(readingSessionActive()).toBe(true);
  });
});

describe('the deferred flag', () => {
  it('is set by a deferral and cleared by an upload', () => {
    expect(volumeDataDeferred()).toBe(false);
    noteVolumeDataDeferred();
    expect(volumeDataDeferred()).toBe(true);
    clearVolumeDataDeferred();
    expect(volumeDataDeferred()).toBe(false);
  });

  it('is spent by the flush that takes it, whatever that sync then does', () => {
    expect(takeVolumeDataDeferred()).toBe(false);
    noteVolumeDataDeferred();
    expect(takeVolumeDataDeferred()).toBe(true);
    expect(volumeDataDeferred()).toBe(false);
    expect(takeVolumeDataDeferred()).toBe(false);
  });
});
