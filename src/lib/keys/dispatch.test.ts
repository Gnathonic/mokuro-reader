import { describe, expect, it, vi } from 'vitest';
import { compileKeymap as compileOver, type KeyBindings } from './keymap';
import { dispatchKey, type KeyEventLike } from './dispatch';
import { allActions } from './registry';

const compileKeymap = (bindings: KeyBindings) => compileOver(bindings, allActions());

function event(code: string, over: Partial<KeyEventLike> = {}) {
  const e = {
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
  return e;
}

describe('dispatchKey', () => {
  it('runs the matching handler and prevents the default only on a match', () => {
    const map = compileKeymap({ 'reader.page-right': ['KeyD'] });
    const turn = vi.fn();
    const hit = event('KeyD');
    expect(
      dispatchKey(hit, { scopes: ['reader'], mode: 'paged' }, { 'reader.page-right': turn }, map)
    ).toBe('reader.page-right');
    expect(turn).toHaveBeenCalledOnce();
    expect(hit.preventDefault).toHaveBeenCalledOnce();

    const miss = event('KeyQ');
    expect(
      dispatchKey(miss, { scopes: ['reader'], mode: 'paged' }, { 'reader.page-right': turn }, map)
    ).toBeNull();
    expect(miss.preventDefault).not.toHaveBeenCalled();
  });

  it('matches exact modifiers only', () => {
    const map = compileKeymap({ 'reader.page-right': ['KeyD'] });
    const turn = vi.fn();
    for (const mods of [
      { shiftKey: true },
      { ctrlKey: true },
      { altKey: true },
      { metaKey: true }
    ]) {
      dispatchKey(event('KeyD', mods), { scopes: ['reader'] }, { 'reader.page-right': turn }, map);
    }
    expect(turn).not.toHaveBeenCalled();
  });

  it('tries scopes in order and falls through a handler that declines', () => {
    const map = compileKeymap({});
    const order: string[] = [];
    const id = dispatchKey(
      event('Escape'),
      { scopes: ['edit', 'reader', 'app'], mode: 'paged' },
      {
        'edit.back': () => {
          order.push('edit');
          return false;
        },
        'app.back': () => void order.push('app')
      },
      map
    );
    expect(id).toBe('app.back');
    expect(order).toEqual(['edit', 'app']);
  });

  it('a declined key keeps its default', () => {
    const map = compileKeymap({});
    const e = event('Escape');
    expect(dispatchKey(e, { scopes: ['app'] }, { 'app.back': () => false }, map)).toBeNull();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('skips actions not live in the mode', () => {
    const map = compileKeymap({});
    const left = vi.fn();
    const scroll = vi.fn();
    dispatchKey(
      event('ArrowLeft'),
      { scopes: ['reader'], mode: 'vertical' },
      { 'reader.page-left': left, 'reader.scroll-left': scroll },
      map
    );
    expect(left).not.toHaveBeenCalled();
    expect(scroll).toHaveBeenCalledOnce();
  });

  it('skips an action with no handler at this site', () => {
    const map = compileKeymap({});
    expect(dispatchKey(event('KeyF'), { scopes: ['reader'] }, {}, map)).toBeNull();
  });

  it('runs the first action in registry order for a synced conflict', () => {
    const map = compileKeymap({ 'reader.fullscreen': ['KeyN'] });
    const full = vi.fn();
    const night = vi.fn();
    dispatchKey(
      event('KeyN'),
      { scopes: ['reader'], mode: 'paged' },
      {
        'reader.fullscreen': full,
        'reader.night': night
      },
      map
    );
    expect(full).toHaveBeenCalledOnce();
    expect(night).not.toHaveBeenCalled();
  });

  it('accepts a resolver: the site’s own map first, a generated action after it', () => {
    const map = compileKeymap({ 'set.bold.toggle': ['KeyB'], 'set.brightness.up': ['KeyU'] });
    const own = { 'reader.fullscreen': vi.fn() };
    const generated = vi.fn();
    const seen: string[] = [];
    const resolve = (id: string, action: { setting?: unknown }) => {
      seen.push(id);
      if (id in own) return own[id as keyof typeof own];
      if (action.setting) return () => generated(id);
      return undefined;
    };
    const ctx = { scopes: ['reader', 'app'] as const, mode: 'paged' as const };

    expect(dispatchKey(event('KeyF'), ctx, resolve, map)).toBe('reader.fullscreen');
    expect(own['reader.fullscreen']).toHaveBeenCalledOnce();
    expect(dispatchKey(event('KeyB'), ctx, resolve, map)).toBe('set.bold.toggle');
    expect(generated).toHaveBeenLastCalledWith('set.bold.toggle');
    // A hand-registered action the resolver does not serve: not this site's key.
    expect(dispatchKey(event('KeyZ'), ctx, resolve, map)).toBeNull();
    expect(seen).toEqual(['reader.fullscreen', 'set.bold.toggle', 'reader.zoom-mode']);

    // Repeat comes from the keymap's own action list: a toggle swallows it, a slider step fires.
    generated.mockClear();
    const held = event('KeyB', { repeat: true });
    expect(dispatchKey(held, ctx, resolve, map)).toBe('set.bold.toggle');
    expect(held.preventDefault).toHaveBeenCalledOnce();
    expect(generated).not.toHaveBeenCalled();
    dispatchKey(event('KeyU', { repeat: true }), ctx, resolve, map);
    expect(generated).toHaveBeenLastCalledWith('set.brightness.up');
  });

  it('drops composition, bare modifiers and handled events', () => {
    const map = compileKeymap({});
    const any = vi.fn();
    const handlers = { 'reader.page-left': any, 'reader.fullscreen': any };
    const ctx = { scopes: ['reader'] as const, mode: 'paged' as const };
    dispatchKey(event('ArrowLeft', { isComposing: true }), ctx, handlers, map);
    dispatchKey(event('ArrowLeft', { keyCode: 229 }), ctx, handlers, map);
    dispatchKey(event('ShiftLeft', { key: 'Shift', shiftKey: true }), ctx, handlers, map);
    dispatchKey(event('KeyF', { defaultPrevented: true }), ctx, handlers, map);
    expect(any).not.toHaveBeenCalled();
  });
});
