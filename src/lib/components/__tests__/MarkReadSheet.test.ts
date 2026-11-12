import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';

const sheet = vi.hoisted(() => {
  let value: unknown = null;
  const subs = new Set<(v: unknown) => void>();
  return {
    subscribe(fn: (v: unknown) => void) {
      subs.add(fn);
      fn(value);
      return () => subs.delete(fn);
    },
    set(v: unknown) {
      value = v;
      for (const fn of subs) fn(v);
    }
  };
});
vi.mock('$lib/reading-history/mark-read-flow', () => ({ markReadSheet: sheet }));

import MarkReadSheet from '../MarkReadSheet.svelte';
import type { SheetRequest, SheetVolume } from '$lib/reading-history/mark-read-flow';

/** 180 pages of 100 characters; pages 139–180 were never read here. */
const vol3: SheetVolume = {
  uuid: 'v3',
  title: 'Vol. 3',
  pageCount: 180,
  totalChars: 18_000,
  pageChars: Array.from({ length: 180 }, () => 100),
  notRead: Array.from({ length: 42 }, (_, i) => 139 + i)
};
const seriesSpeed = { charsPerMinute: 248, source: 'series' as const, rough: false };

function open(patch: Partial<SheetRequest> = {}) {
  const answer = vi.fn((_a: unknown) => sheet.set(null));
  sheet.set({
    mode: 'single',
    volumes: [vol3],
    checked: ['v3'],
    speed: seriesSpeed,
    focus: 'skip',
    upTo: 180,
    ...patch,
    answer
  });
  return answer;
}

const dialog = () => screen.getByTestId('mark-read-sheet') as HTMLDialogElement;
const estimate = () => screen.getByTestId('mark-read-estimate').textContent!.replace(/\s+/g, ' ');

afterEach(() => {
  sheet.set(null);
  cleanup();
});

describe('MarkReadSheet: one volume', () => {
  it('says what was not read here, estimates at the series speed, and focuses Don’t count', async () => {
    render(MarkReadSheet);
    open();
    await tick();
    await Promise.resolve();
    expect(dialog().open).toBe(true);
    expect(dialog().textContent).toContain('Mark “Vol. 3” as read');
    expect(dialog().textContent).toContain('42 of its 180 pages weren’t read in this app.');
    // 4,200 characters at 248 chars/min = 16.9 → 17 min.
    expect(estimate()).toContain('42 pages · 4,200 characters · about 17 min');
    expect(estimate()).toContain('At your speed in this series, 248 chars/min.');
    expect(dialog().textContent).toContain(
      'Either way it’s marked read and counts for your goals.'
    );
    expect(document.activeElement).toBe(screen.getByTestId('mark-read-skip'));
  });

  it('Count them answers with the estimate; Don’t count answers no', async () => {
    render(MarkReadSheet);
    let answer = open();
    await tick();
    await fireEvent.click(screen.getByTestId('mark-read-count'));
    expect(answer).toHaveBeenCalledWith({
      count: true,
      checked: ['v3'],
      upTo: 180,
      typedMinutes: null,
      dontAskAgain: false
    });
    answer = open();
    await tick();
    await fireEvent.click(screen.getByTestId('mark-read-skip'));
    expect(answer.mock.calls[0][0]).toMatchObject({ count: false });
  });

  it('×, Escape and the backdrop cancel with no answer', async () => {
    render(MarkReadSheet);
    let answer = open();
    await tick();
    await fireEvent.click(screen.getByTestId('mark-read-cancel'));
    expect(answer).toHaveBeenCalledWith(null);

    answer = open();
    await tick();
    const outside = vi.fn();
    window.addEventListener('keydown', outside);
    await fireEvent.keyDown(document.body, { key: 'Escape' });
    window.removeEventListener('keydown', outside);
    expect(answer).toHaveBeenCalledWith(null);
    // The page under the sheet never hears it (no "go back").
    expect(outside).not.toHaveBeenCalled();

    answer = open();
    await tick();
    await fireEvent.click(dialog());
    expect(answer).toHaveBeenCalledWith(null);
  });

  it('Adjust: a page bound re-counts characters and re-estimates; a typed time sticks until Use estimate', async () => {
    render(MarkReadSheet);
    const answer = open();
    await tick();
    await fireEvent.click(screen.getByText(/Adjust/));
    const upTo = screen.getByTestId('mark-read-up-to') as HTMLInputElement;
    await fireEvent.input(upTo, { target: { value: '150' } });
    // Pages 139–150: 12 pages, 1,200 characters, 1,200 / 248 → 5 min.
    expect(estimate()).toContain('12 pages · 1,200 characters · about 5 min');
    const minutes = screen.getByTestId('mark-read-minutes') as HTMLInputElement;
    expect(minutes.value).toBe('5');
    await fireEvent.input(minutes, { target: { value: '20' } });
    expect(estimate()).toContain('12 pages · 1,200 characters · 20 min');
    await fireEvent.input(upTo, { target: { value: '180' } });
    // A typed time is the user's: the bound no longer moves it.
    expect(estimate()).toContain('42 pages · 4,200 characters · 20 min');
    await fireEvent.click(screen.getByTestId('mark-read-count'));
    expect(answer.mock.calls[0][0]).toMatchObject({ count: true, upTo: 180, typedMinutes: 20 });

    open();
    await tick();
    await fireEvent.click(screen.getByText(/Adjust/));
    await fireEvent.input(screen.getByTestId('mark-read-minutes'), { target: { value: '3' } });
    await fireEvent.click(screen.getByText('Use estimate'));
    expect(estimate()).toContain('about 17 min');
  });

  it('typed minutes past 59 carry into the hours, never silently capped', async () => {
    render(MarkReadSheet);
    const answer = open();
    await tick();
    await fireEvent.click(screen.getByText(/Adjust/));
    await fireEvent.input(screen.getByTestId('mark-read-hours'), { target: { value: '0' } });
    await fireEvent.input(screen.getByTestId('mark-read-minutes'), { target: { value: '90' } });
    expect(estimate()).toContain('42 pages · 4,200 characters · 1 h 30 min');
    await fireEvent.click(screen.getByTestId('mark-read-count'));
    expect(answer.mock.calls[0][0]).toMatchObject({ count: true, typedMinutes: 90 });
  });

  it('low data: no time shown as if it were the user’s, an optional empty time field', async () => {
    render(MarkReadSheet);
    const answer = open({ speed: null });
    await tick();
    expect(estimate()).toContain(
      '42 pages · 4,200 characters. Not enough reading here yet to estimate your time.'
    );
    expect(estimate()).not.toContain('chars/min');
    expect((screen.getByTestId('mark-read-hours') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('mark-read-minutes') as HTMLInputElement).value).toBe('');
    expect(estimate()).toContain('optional');
    await fireEvent.click(screen.getByTestId('mark-read-count'));
    // Characters only.
    expect(answer.mock.calls[0][0]).toMatchObject({ count: true, typedMinutes: null });
  });

  it('a rough recent speed says so', async () => {
    render(MarkReadSheet);
    open({ speed: { charsPerMinute: 180, source: 'recent', rough: true } });
    await tick();
    expect(estimate()).toContain('At your recent speed, 180 chars/min (rough estimate).');
  });

  it('Don’t ask again rides the answer and names where to change it', async () => {
    render(MarkReadSheet);
    const answer = open();
    await tick();
    await fireEvent.click(screen.getByTestId('mark-read-dont-ask'));
    expect(dialog().textContent).toContain('Change this in Settings → Reader → Reading timer.');
    await fireEvent.click(screen.getByTestId('mark-read-skip'));
    expect(answer.mock.calls[0][0]).toMatchObject({ count: false, dontAskAgain: true });
  });

  it('editor mode marks nothing: its own title, Cancel, the bound at the current page', async () => {
    render(MarkReadSheet);
    const answer = open({ mode: 'editor', upTo: 150, focus: 'count' });
    await tick();
    await Promise.resolve();
    expect(dialog().textContent).toContain('Count reading done elsewhere');
    expect(dialog().textContent).not.toContain('marked read');
    expect(screen.queryByTestId('mark-read-dont-ask')).toBeNull();
    expect((screen.getByTestId('mark-read-up-to') as HTMLInputElement).value).toBe('150');
    expect(document.activeElement).toBe(screen.getByTestId('mark-read-count'));
    await fireEvent.click(screen.getByTestId('mark-read-skip'));
    expect(answer).toHaveBeenCalledWith(null);
  });
});

describe('MarkReadSheet: bulk', () => {
  const vol = (n: number, notRead: number): SheetVolume => ({
    uuid: `v${n}`,
    title: `Vol. ${n}`,
    pageCount: 10,
    totalChars: 1000,
    pageChars: Array.from({ length: 10 }, () => 100),
    notRead: Array.from({ length: notRead }, (_, i) => 10 - notRead + 1 + i)
  });

  it('a checklist: rows toggle, totals follow, the answer carries what is ticked', async () => {
    render(MarkReadSheet);
    const answer = open({
      mode: 'bulk',
      volumes: [vol(1, 10), vol(2, 4), { ...vol(3, 0), pageCount: 0, notRead: [] }],
      checked: ['v1', 'v2'],
      speed: { charsPerMinute: 100, source: 'series', rough: false },
      focus: 'count',
      upTo: 0
    });
    await tick();
    await Promise.resolve();
    const list = screen.getByTestId('mark-read-list').textContent!.replace(/\s+/g, ' ');
    expect(list).toContain('Vol. 1 10 pages not read here');
    expect(list).toContain('Vol. 2 4 of 10 pages not read here');
    expect(list).toContain('Vol. 3 page count unknown');
    // 10 + 4 pages, 1,400 characters, 10 + 4 min.
    expect(estimate()).toContain('2 volumes · 14 pages · 1,400 characters · about 14 min');
    expect(dialog().textContent).toContain('Either way they’re marked read');
    // The setting says Count: the focus is there.
    expect(document.activeElement).toBe(screen.getByTestId('mark-read-count'));
    await fireEvent.click(screen.getByText('Vol. 1'));
    expect(estimate()).toContain('1 volume · 4 pages · 400 characters · about 4 min');
    await fireEvent.click(screen.getByText(/Adjust/));
    // The fields showed the estimate, 0 h 4 min: typing the hours keeps the minutes.
    await fireEvent.input(screen.getByTestId('mark-read-hours'), { target: { value: '1' } });
    await fireEvent.click(screen.getByTestId('mark-read-count'));
    expect(answer.mock.calls[0][0]).toMatchObject({
      count: true,
      checked: ['v2'],
      typedMinutes: 64
    });
  });

  it('nothing ticked: neither button answers', async () => {
    render(MarkReadSheet);
    open({ mode: 'bulk', volumes: [vol(1, 3)], checked: [], upTo: 0 });
    await tick();
    expect((screen.getByTestId('mark-read-count') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('mark-read-skip') as HTMLButtonElement).disabled).toBe(true);
  });
});
