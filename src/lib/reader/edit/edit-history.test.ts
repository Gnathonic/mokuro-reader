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

  // A gesture the user cancelled is not an edit the user made and took back:
  // rolling it back with undo() parks it on the redo stack (Ctrl+Y replays a
  // drag that never happened) and the push before it already wiped the redo
  // entries that were there.
  describe('mark / cancelTo', () => {
    it('drops what was pushed since the mark, present included, and leaves no redo of it', () => {
      const h = new EditHistory('a');
      h.push('b');
      const mark = h.mark();
      h.push('c');
      h.push('d');
      h.cancelTo(mark);
      expect(h.current).toBe('b');
      expect(h.canRedo).toBe(false);
      expect(h.undo()).toBe('a');
      expect(h.canUndo).toBe(false);
    });

    it('puts back the redo entries that existed before the gesture', () => {
      const h = new EditHistory('a');
      h.push('b');
      h.push('c');
      h.undo();
      h.undo(); // at 'a', redo: b, c
      const mark = h.mark();
      h.push('x'); // would have wiped the redo branch for good
      h.cancelTo(mark);
      expect(h.current).toBe('a');
      expect(h.redo()).toBe('b');
      expect(h.redo()).toBe('c');
    });

    it('a gesture that coalesced INTO the entry before it is still cancelled exactly', () => {
      let now = 0;
      const h = new EditHistory('a', () => now);
      h.push('b', 'drag'); // an earlier drag under the same key, 100 ms ago
      now = 100;
      const mark = h.mark();
      h.push('c', 'drag'); // replaces 'b' in place: nothing new on the stack
      h.cancelTo(mark);
      expect(h.current).toBe('b');
      expect(h.undo()).toBe('a');
      expect(h.canUndo).toBe(false);
    });

    it('the next push after a cancel never coalesces into a pre-gesture entry', () => {
      let now = 0;
      const h = new EditHistory('a', () => now);
      h.push('b', 'drag');
      const mark = h.mark();
      h.push('c', 'drag');
      h.cancelTo(mark);
      now = 10;
      h.push('d', 'drag');
      expect(h.undo()).toBe('b');
    });
  });

  it('reset clears everything', () => {
    const h = new EditHistory(0);
    h.push(1);
    h.reset(9);
    expect(h.current).toBe(9);
    expect(h.canUndo).toBe(false);
  });
});
