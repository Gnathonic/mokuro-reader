import { describe, expect, it } from 'vitest';
import { COALESCE_WINDOW_MS, EditHistory } from './edit-history';

describe('EditHistory', () => {
  it('undoes and redoes in order', () => {
    const h = new EditHistory(0);
    h.push(1);
    h.push(2);
    expect(h.current).toBe(2);
    expect(h.undo()).toBe(1);
    expect(h.undo()).toBe(0);
    expect(h.undo()).toBeNull();
    expect(h.redo()).toBe(1);
    expect(h.canRedo).toBe(true);
  });

  it('a push after undo discards the redo branch', () => {
    const h = new EditHistory(0);
    h.push(1);
    h.undo();
    h.push(5);
    expect(h.canRedo).toBe(false);
    expect(h.undo()).toBe(0);
  });

  it('coalesces same-key pushes inside the window into one entry', () => {
    let t = 0;
    const h = new EditHistory(0, () => t);
    h.push(1, 'drag:0');
    t += 100;
    h.push(2, 'drag:0');
    t += 100;
    h.push(3, 'drag:0');
    expect(h.current).toBe(3);
    expect(h.undo()).toBe(0);
  });

  it('does not coalesce across the window or across keys', () => {
    let t = 0;
    const h = new EditHistory(0, () => t);
    h.push(1, 'drag:0');
    t += COALESCE_WINDOW_MS + 1;
    h.push(2, 'drag:0');
    h.push(3, 'drag:1');
    expect(h.undo()).toBe(2);
    expect(h.undo()).toBe(1);
  });

  it('reset clears everything', () => {
    const h = new EditHistory(0);
    h.push(1);
    h.reset(9);
    expect(h.current).toBe(9);
    expect(h.canUndo).toBe(false);
  });
});
