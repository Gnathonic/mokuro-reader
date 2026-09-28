import { describe, expect, it } from 'vitest';
import type { ManifestPendingJob } from '$lib/import/deep-link-manifest';
import { describePendingOcr, relativeEta } from './server-ocr-pending';

const NOW = Date.parse('2026-09-28T15:00:00Z');
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const hhmm = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const jobs: ManifestPendingJob[] = [
  { kind: 'layer', id: 'paddle-manga-ppocr-manga', eta: at(14) },
  { kind: 'layer', id: 'gcv', eta: null },
  { kind: 'ocr', id: 'mokuro-fp16', eta: at(3) },
  { kind: 'layer', id: 'hayai-nova', eta: at(8) }
];

describe('relativeEta', () => {
  it('says how long, and at what local clock time', () => {
    expect(relativeEta(at(3), NOW)).toEqual({ when: 'in ~3 min', clock: hhmm(at(3)) });
    expect(relativeEta(at(0.5), NOW)).toEqual({ when: 'in <1 min', clock: hhmm(at(0.5)) });
    expect(relativeEta(at(60), NOW).when).toBe('in ~1 h');
    expect(relativeEta(at(95), NOW).when).toBe('in ~1 h 35 min');
  });

  it('is "queued" with no clock when the server could not price it', () => {
    expect(relativeEta(null, NOW)).toEqual({ when: 'queued', clock: null });
  });

  it('is "any moment" once the eta has passed but nothing landed', () => {
    expect(relativeEta(at(-2), NOW)).toEqual({ when: 'any moment', clock: hhmm(at(-2)) });
  });
});

describe('describePendingOcr', () => {
  it('titles it, puts the primary first as "Text", then layers by ETA, unpriced last', () => {
    const view = describePendingOcr(jobs, NOW)!;
    expect(view.title).toBe('Server OCR');
    expect(view.lines.map((l) => [l.name, l.when, l.clock])).toEqual([
      ['Text', 'in ~3 min', hhmm(at(3))],
      ['Hayai Nova', 'in ~8 min', hhmm(at(8))],
      ['Paddle Manga Pp…', 'in ~14 min', hhmm(at(14))],
      ['Gcv', 'queued', null]
    ]);
  });

  it('names a layer the way the reader names layers elsewhere', () => {
    const view = describePendingOcr([{ kind: 'layer', id: 'ppocr-manga', eta: null }], NOW)!;
    expect(view.lines[0].name).toBe('PP-OCR Manga');
  });

  it('keeps the full name and every exact clock time in the accessible label', () => {
    const view = describePendingOcr(jobs, NOW)!;
    expect(view.label).toBe(
      `Server OCR — Text: in ~3 min, at ${hhmm(at(3))}; Hayai Nova: in ~8 min, at ${hhmm(at(8))}; ` +
        `Paddle Manga Ppocr Manga: in ~14 min, at ${hhmm(at(14))}; Gcv: queued, no estimate yet`
    );
  });

  it('reads as one line for the list view', () => {
    expect(describePendingOcr(jobs, NOW)!.inline).toBe(
      'Server OCR: Text in ~3 min · Hayai Nova in ~8 min · Paddle Manga Pp… in ~14 min · Gcv queued'
    );
  });

  it('shows at most three lines, the last one "+N more" when there are more', () => {
    const view = describePendingOcr(jobs, NOW)!;
    expect(view.shown.map((l) => l.name)).toEqual(['Text', 'Hayai Nova']);
    expect(view.more).toBe(2);
    const three = describePendingOcr(jobs.slice(0, 3), NOW)!;
    expect(three.shown).toHaveLength(3);
    expect(three.more).toBe(0);
  });

  it('keeps each line keyed by its job, so a landed job drops out in place', () => {
    const before = describePendingOcr(jobs, NOW)!;
    const after = describePendingOcr(
      jobs.filter((j) => j.kind !== 'ocr'),
      NOW
    )!;
    expect(before.lines.map((l) => l.key)).toContain('ocr:mokuro-fp16');
    expect(after.lines.map((l) => l.key)).not.toContain('ocr:mokuro-fp16');
    expect(after.lines[0].key).toBe('layer:hayai-nova');
  });

  it('refreshes the relative time as the clock moves', () => {
    expect(describePendingOcr(jobs, NOW + 2 * 60_000)!.lines[0].when).toBe('in ~1 min');
    expect(describePendingOcr(jobs, NOW + 5 * 60_000)!.lines[0].when).toBe('any moment');
  });

  it('says only "queued" while the jobs are not known yet', () => {
    const view = describePendingOcr(null, NOW)!;
    expect(view.lines.map((l) => [l.name, l.when])).toEqual([['OCR', 'queued']]);
    expect(view.label).toBe('Server OCR — queued, no estimate yet');
  });

  it('is nothing when nothing is pending', () => {
    expect(describePendingOcr([], NOW)).toBeNull();
    expect(describePendingOcr(undefined, NOW)).toBeNull();
  });
});
