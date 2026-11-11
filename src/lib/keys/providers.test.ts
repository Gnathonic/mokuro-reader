import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  KeyActionDef,
  LibrarySeriesActionId,
  LibraryVolumeActionId,
  ScopeActionId
} from './actions';
import type { KeyEventLike, KeyHandler } from './dispatch';
import { compileKeymap, type KeyBindings } from './keymap';
import {
  dispatchOutsideReader,
  handleKeydownOutsideReader,
  type OutsideReaderContext
} from './outside-reader';
import {
  isProvided,
  provideKeyHandlers,
  providedHandler,
  scopesOutsideReader,
  type ProvidedScope
} from './providers';
import { allActions } from './registry';

function event(code: string, over: Partial<KeyEventLike> = {}) {
  return {
    code,
    key: code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    isComposing: false,
    keyCode: 0,
    repeat: false,
    defaultPrevented: false,
    preventDefault: vi.fn(),
    ...over
  };
}

const noop: KeyHandler = () => {};

/** A full `library.series` map: every id is required by the type. */
function seriesCard(over: Partial<Record<LibrarySeriesActionId, KeyHandler>> = {}) {
  return {
    'library.series-open': noop,
    'library.series-edit': noop,
    'library.series-remove': noop,
    ...over
  };
}

function volumeRow(over: Partial<Record<LibraryVolumeActionId, KeyHandler>> = {}) {
  return {
    'library.volume-open': noop,
    'library.volume-edit': noop,
    'library.volume-cover': noop,
    'library.volume-remove': noop,
    'library.volume-delete-cloud': noop,
    'library.volume-read': noop,
    'library.volume-download': noop,
    'library.volume-backup': noop,
    'library.volume-text': noop,
    'library.volume-extract': noop,
    ...over
  };
}

const disposers: (() => void)[] = [];
function provide<S extends ProvidedScope>(
  scope: S,
  handlers: Record<ScopeActionId<S>, KeyHandler>
) {
  const dispose = provideKeyHandlers(scope, handlers);
  disposers.push(dispose);
  return dispose;
}
afterEach(() => {
  while (disposers.length) disposers.pop()!();
});

describe('provideKeyHandlers', () => {
  it('provides a scope until its disposer runs', () => {
    expect(isProvided('library')).toBe(false);
    const focus = vi.fn();
    const dispose = provide('library', { 'library.focus-search': focus });
    expect(isProvided('library')).toBe(true);
    expect(providedHandler('library', 'library.focus-search')).toBe(focus);
    expect(providedHandler('library', 'library.series-open')).toBeUndefined();
    dispose();
    expect(isProvided('library')).toBe(false);
    expect(providedHandler('library', 'library.focus-search')).toBeUndefined();
  });

  it('lets the newest provider of a scope win, and hands the scope back when it goes', () => {
    const first = vi.fn();
    const second = vi.fn();
    provide('library.series', seriesCard({ 'library.series-open': first }));
    const disposeSecond = provide('library.series', seriesCard({ 'library.series-open': second }));
    expect(providedHandler('library.series', 'library.series-open')).toBe(second);
    disposeSecond();
    expect(providedHandler('library.series', 'library.series-open')).toBe(first);
  });

  it('a disposer removes its own entry only, whatever the order, and only once', () => {
    const first = vi.fn();
    const second = vi.fn();
    const disposeFirst = provide('library.series', seriesCard({ 'library.series-open': first }));
    provide('library.series', seriesCard({ 'library.series-open': second }));
    // The pointer left the OLDER card after entering the newer one.
    disposeFirst();
    expect(providedHandler('library.series', 'library.series-open')).toBe(second);
    disposeFirst();
    expect(providedHandler('library.series', 'library.series-open')).toBe(second);
  });
});

describe('scopesOutsideReader', () => {
  it('is the view scope then app, with the hovered card first when one provides', () => {
    expect(scopesOutsideReader('library', false)).toEqual(['library', 'app']);
    expect(scopesOutsideReader(undefined, false)).toEqual(['app']);
    provide('library.series', seriesCard());
    expect(scopesOutsideReader('library', false)).toEqual(['library.series', 'library', 'app']);
    // A series card's scope does not shadow the series PAGE.
    expect(scopesOutsideReader('series', false)).toEqual(['series', 'app']);
    provide('library.volume', volumeRow());
    expect(scopesOutsideReader('series', false)).toEqual(['library.volume', 'series', 'app']);
    expect(scopesOutsideReader('tracker', false)).toEqual(['tracker', 'app']);
  });

  it('is a provided dialog scope alone while a dialog is open', () => {
    provide('library.series', seriesCard());
    expect(scopesOutsideReader('library', true)).toEqual([]);
    provide('series-editor', {
      'series-editor.next-unlinked': noop,
      'series-editor.next-untitled': noop
    });
    expect(scopesOutsideReader('library', true)).toEqual(['series-editor']);
    // Not under no dialog: a dialog scope is never tried from the page.
    expect(scopesOutsideReader('library', false)).toEqual(['library.series', 'library', 'app']);
  });
});

describe('dispatchOutsideReader', () => {
  const compile = (bindings: KeyBindings) => compileKeymap(bindings, allActions());
  // One chord on a hovered card's action, the page's action and an app action.
  const SHARED = compile({
    'library.series-open': ['KeyX'],
    'library.focus-search': ['KeyX'],
    'app.settings': ['KeyX']
  });

  function context(over: Partial<OutsideReaderContext> = {}): OutsideReaderContext {
    return { viewScope: 'library', dialogOpen: false, app: {}, setting: () => false, ...over };
  }

  it('tries the hovered card before the page before app on a shared chord', () => {
    const settings = vi.fn();
    const focus = vi.fn();
    const open = vi.fn();
    const ctx = context({ app: { 'app.settings': settings } });

    // Nothing provided: only `app` has a handler.
    expect(dispatchOutsideReader(event('KeyX'), ctx, SHARED)).toBe('app.settings');

    // The page provides: it is tried before `app`.
    provide('library', { 'library.focus-search': focus });
    expect(dispatchOutsideReader(event('KeyX'), ctx, SHARED)).toBe('library.focus-search');

    // A card under the pointer: it is tried before its page.
    const leave = provide('library.series', seriesCard({ 'library.series-open': open }));
    const e = event('KeyX');
    expect(dispatchOutsideReader(e, ctx, SHARED)).toBe('library.series-open');
    expect(e.preventDefault).toHaveBeenCalledOnce();
    expect([open.mock.calls.length, focus.mock.calls.length, settings.mock.calls.length]).toEqual([
      1, 1, 1
    ]);

    // The pointer leaves: back to the page.
    leave();
    expect(dispatchOutsideReader(event('KeyX'), ctx, SHARED)).toBe('library.focus-search');
  });

  it('falls through a handler that declines, down to app', () => {
    const settings = vi.fn();
    provide('library', { 'library.focus-search': () => false });
    provide('library.series', seriesCard({ 'library.series-open': () => false }));
    expect(
      dispatchOutsideReader(event('KeyX'), context({ app: { 'app.settings': settings } }), SHARED)
    ).toBe('app.settings');
    expect(settings).toHaveBeenCalledOnce();
  });

  it('never runs a hovered card of another page', () => {
    const open = vi.fn();
    provide('library.series', seriesCard({ 'library.series-open': open }));
    expect(
      dispatchOutsideReader(event('KeyX'), context({ viewScope: 'series' }), SHARED)
    ).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it('under a dialog runs a provided dialog scope and nothing else', () => {
    const map = compile({
      'series-editor.next-unlinked': ['KeyN'],
      'app.settings': ['KeyN'],
      'library.focus-search': ['KeyN'],
      'set.theme.next': ['KeyT']
    });
    const settings = vi.fn();
    const focus = vi.fn();
    const setting = vi.fn(() => true);
    const next = vi.fn();
    provide('library', { 'library.focus-search': focus });
    const ctx = context({ dialogOpen: true, app: { 'app.settings': settings }, setting });

    // Some other dialog is up: nothing fires, the key keeps its default.
    const quiet = event('KeyN');
    expect(dispatchOutsideReader(quiet, ctx, map)).toBeNull();
    expect(quiet.preventDefault).not.toHaveBeenCalled();
    expect(dispatchOutsideReader(event('KeyT'), ctx, map)).toBeNull();

    // The series editor is the top dialog.
    provide('series-editor', {
      'series-editor.next-unlinked': next,
      'series-editor.next-untitled': noop
    });
    expect(dispatchOutsideReader(event('KeyN'), ctx, map)).toBe('series-editor.next-unlinked');
    expect(dispatchOutsideReader(event('KeyT'), ctx, map)).toBeNull();
    expect(next).toHaveBeenCalledOnce();
    expect(settings).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(setting).not.toHaveBeenCalled();
  });

  it('answers a generated setting action of the view scope and of app', () => {
    const map = compile({ 'set.gallery-layout.next': ['KeyG'], 'set.theme.next': ['KeyT'] });
    const ran: string[] = [];
    const setting = (action: KeyActionDef) => {
      ran.push(action.id);
      return true;
    };
    expect(dispatchOutsideReader(event('KeyG'), context({ setting }), map)).toBe(
      'set.gallery-layout.next'
    );
    expect(dispatchOutsideReader(event('KeyT'), context({ setting }), map)).toBe('set.theme.next');
    // The gallery layout is the catalog's: not on the series page.
    expect(
      dispatchOutsideReader(event('KeyG'), context({ viewScope: 'series', setting }), map)
    ).toBeNull();
    expect(ran).toEqual(['set.gallery-layout.next', 'set.theme.next']);
  });

  it('a library action ignores auto-repeat but still takes the key', () => {
    const open = vi.fn();
    provide('library.series', seriesCard({ 'library.series-open': open }));
    const e = event('KeyX', { repeat: true });
    expect(dispatchOutsideReader(e, context(), SHARED)).toBe('library.series-open');
    expect(open).not.toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalledOnce();
  });
});

describe('handleKeydownOutsideReader: the guards run once', () => {
  const map = compileKeymap({ 'library.series-open': ['KeyX'] }, allActions());
  const handlers = { viewScope: 'library' as const, app: {}, setting: () => false };
  const press = () => new KeyboardEvent('keydown', { code: 'KeyX', key: 'x', cancelable: true });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('runs a hovered card’s action from the page', () => {
    const open = vi.fn();
    provide('library.series', seriesCard({ 'library.series-open': open }));
    const e = press();
    document.body.dispatchEvent(e);
    expect(handleKeydownOutsideReader(e, handlers, map)).toBe('library.series-open');
    expect(open).toHaveBeenCalledOnce();
  });

  it('not while a field has focus, nor from the settings panel', () => {
    const open = vi.fn();
    provide('library.series', seriesCard({ 'library.series-open': open }));
    document.body.innerHTML =
      '<input id="field" /><div id="settings"><button id="b"></button></div>';
    const field = document.getElementById('field') as HTMLInputElement;
    field.focus();
    const typed = press();
    field.dispatchEvent(typed);
    expect(handleKeydownOutsideReader(typed, handlers, map)).toBeNull();
    field.blur();
    const inPanel = press();
    document.getElementById('b')!.dispatchEvent(inPanel);
    expect(handleKeydownOutsideReader(inPanel, handlers, map)).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it('not under an open dialog: a second press cannot stack a confirmation', () => {
    const open = vi.fn();
    provide('library.series', seriesCard({ 'library.series-open': open }));
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    document.body.appendChild(dialog);
    const e = press();
    document.body.dispatchEvent(e);
    expect(handleKeydownOutsideReader(e, handlers, map)).toBeNull();
    expect(open).not.toHaveBeenCalled();
    dialog.remove();
    expect(handleKeydownOutsideReader(press(), handlers, map)).toBe('library.series-open');
  });
});
