import { describe, expect, it } from 'vitest';
import { queueFixture, queueFixtureWithParts } from './__fixtures__/mokuro-queue';
import { parseQueueFile } from './server-ocr-queue';
import {
  describePendingOcr,
  heldText,
  relativeEta,
  volumeQueueKey,
  type QueueJob
} from './server-ocr-pending';

const NOW = Date.parse('2026-09-28T15:00:00Z');
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const hhmm = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const file = queueFixture(NOW);
const jobsOf = (i: number) => file.volumes[i].jobs as QueueJob[];

describe('relativeEta', () => {
  it('says how long, and at what local clock time', () => {
    expect(relativeEta(at(3), NOW)).toEqual({ when: 'in ~3 min', clock: hhmm(at(3)) });
    expect(relativeEta(at(0.5), NOW)).toEqual({ when: 'in <1 min', clock: hhmm(at(0.5)) });
    expect(relativeEta(at(60), NOW).when).toBe('in ~1 h');
    expect(relativeEta(at(95), NOW).when).toBe('in ~1 h 35 min');
    expect(relativeEta(null, NOW)).toEqual({ when: 'queued', clock: null });
    expect(relativeEta(at(-2), NOW)).toEqual({ when: 'any moment', clock: hhmm(at(-2)) });
  });
});

describe('volumeQueueKey', () => {
  it('matches the queue file’s names to local titles however they are spelled', () => {
    expect(volumeQueueKey('Dr Stone', 'Dr Stone 01')).toBe(
      volumeQueueKey('  dr  stone ', 'DR STONE 01')
    );
    expect(volumeQueueKey('Dr Stone', 'Dr Stone 01')).not.toBe(
      volumeQueueKey('Dr Stone', 'Dr Stone 02')
    );
  });
});

describe('heldText', () => {
  it('says each held code in plain words', () => {
    expect(heldText({ reason: 'no-processor' })).toBe('held: no processor connected');
    expect(heldText({ reason: 'paused' })).toBe('held: queue paused');
    expect(heldText({ reason: 'benchmarking' })).toBe('held: benchmarking');
    expect(heldText({ reason: 'something-new' })).toBe('held');
  });

  it("names a cloud-direct Bunko's storage reasons", () => {
    expect(heldText({ reason: 'storage-offline' })).toBe("held: Bunko can't reach your storage");
    expect(heldText({ reason: 'storage-auth' })).toBe(
      'held: Bunko needs you to sign in to your storage again'
    );
    expect(heldText({ reason: 'storage-full' })).toBe('held: your storage is full');
    expect(heldText({ reason: 'transfer-quota' })).toBe('held: storage transfer limit reached');
    expect(heldText({ reason: 'storage-lease' })).toBe('held: another Bunko manages this library');
    expect(heldText(null)).toBe('held');
  });
});

describe('describePendingOcr (from the queue file)', () => {
  it('shows a running job’s progress and ETA, queued ones their ETA', () => {
    const view = describePendingOcr({ jobs: jobsOf(0), held: null }, NOW)!;
    expect(view.title).toBe('Server OCR');
    expect(view.lines.map((l) => [l.name, l.detail])).toEqual([
      ['Mokuro Fp16', `42% · ~${hhmm(at(3))}`],
      ['Hayai Nova', `in ~8 min · ${hhmm(at(8))}`],
      ['Paddle Manga', 'queued']
    ]);
  });

  it('shows a held job with the queue’s reason in plain words', () => {
    const view = describePendingOcr({ jobs: jobsOf(1), held: { reason: 'no-processor' } }, NOW)!;
    expect(view.lines.map((l) => [l.name, l.detail])).toEqual([
      ['Mokuro Fp16', 'held: no processor connected']
    ]);
    expect(view.label).toBe('Server OCR — Mokuro Fp16: held: no processor connected');
  });

  it('running with no progress or ETA still says it is running', () => {
    const view = describePendingOcr(
      { jobs: [{ kind: 'ocr', id: 'm', state: 'running', eta: null, progress: null }], held: null },
      NOW
    )!;
    expect(view.lines[0].detail).toBe('running');
  });

  it('keeps full names and exact clock times in the accessible label', () => {
    const view = describePendingOcr({ jobs: jobsOf(0), held: null }, NOW)!;
    expect(view.label).toBe(
      `Server OCR — Mokuro Fp16: running, 42% done, finishing about ${hhmm(at(3))}; ` +
        `Hayai Nova: in ~8 min, at ${hhmm(at(8))}; Paddle Manga: queued, no estimate yet`
    );
  });

  it('reads as one line for the list view', () => {
    expect(describePendingOcr({ jobs: jobsOf(0), held: null }, NOW)!.inline).toBe(
      `Server OCR: Mokuro Fp16 42% · ~${hhmm(at(3))} · Hayai Nova in ~8 min · Paddle Manga queued`
    );
  });

  it('lists soonest first, shortens long names', () => {
    const view = describePendingOcr(
      {
        jobs: [
          {
            kind: 'layer',
            id: 'paddle-manga-ppocr-manga',
            state: 'queued',
            eta: at(14),
            progress: null
          },
          { kind: 'layer', id: 'gcv', state: 'queued', eta: null, progress: null },
          { kind: 'ocr', id: 'mokuro-fp16', state: 'queued', eta: at(3), progress: null },
          { kind: 'layer', id: 'hayai-nova', state: 'queued', eta: at(8), progress: null }
        ],
        held: null
      },
      NOW
    )!;
    expect(view.lines.map((l) => l.name)).toEqual([
      'Mokuro Fp16',
      'Hayai Nova',
      'Paddle Manga Pp…',
      'Gcv'
    ]);
    expect(view.shown.map((l) => l.name)).toEqual(['Mokuro Fp16', 'Hayai Nova']);
    expect(view.more).toBe(2);
  });

  it('names every job as its finished file will be: its parts, else the generation', () => {
    const parsed = parseQueueFile(queueFixtureWithParts(NOW))!;
    const view = describePendingOcr({ jobs: parsed.volumes[2].jobs, held: null }, NOW)!;
    expect(view.lines.map((l) => l.fullName)).toEqual([
      // The main file's job: never "Text".
      'Hayai Nova 2.5 · PP-OCR Manga 0.3',
      // An engine that is its own detector: one part.
      'PP-OCR Manga 0.3',
      // A part without a version reads as its name.
      'Charspot Small · AnimeText 12x',
      // Malformed parts: the generation's display name.
      'Nar Small'
    ]);
    // Shortened on a line like any long name; whole in the label.
    expect(view.lines[0].name).toBe('Hayai Nova 2.5…');
    expect(view.label).toContain('Hayai Nova 2.5 · PP-OCR Manga 0.3: running, 50% done');
  });

  it('a main-file job without parts (older bunko) is named by its generation', () => {
    const view = describePendingOcr(
      {
        jobs: [{ kind: 'ocr', id: 'hayai-nova', state: 'queued', eta: null, progress: null }],
        held: null
      },
      NOW
    )!;
    expect(view.lines[0].fullName).toBe('Hayai Nova');
  });

  it('a main-file job far off sits below a layer due sooner; running first, held and unpriced last', () => {
    const view = describePendingOcr(
      {
        jobs: [
          { kind: 'layer', id: 'gcv', state: 'queued', eta: null, progress: null },
          { kind: 'ocr', id: 'hayai-nova', state: 'queued', eta: at(284 * 60), progress: null },
          { kind: 'layer', id: 'nar-small', state: 'held', eta: at(1), progress: null },
          { kind: 'layer', id: 'ppocr-manga', state: 'queued', eta: at(2), progress: null },
          { kind: 'layer', id: 'charspot-small', state: 'running', eta: at(30), progress: 0.1 },
          { kind: 'layer', id: 'paddle-manga', state: 'running', eta: null, progress: null },
          { kind: 'layer', id: 'mokuro-fp16', state: 'running', eta: at(5), progress: 0.5 },
          { kind: 'layer', id: 'tr-en', state: 'queued', eta: null, progress: null }
        ],
        held: null
      },
      NOW
    )!;
    expect(view.lines.map((l) => l.key)).toEqual([
      // Running, by ETA (an unpriced one after the priced).
      'layer:mokuro-fp16',
      'layer:charspot-small',
      'layer:paddle-manga',
      // Queued, by ETA: the layer due in ~2 min above the main file in ~284 h.
      'layer:ppocr-manga',
      'ocr:hayai-nova',
      // Unpriced and held, in the server's order.
      'layer:gcv',
      'layer:nar-small',
      'layer:tr-en'
    ]);
  });

  it('keys each line by its job so a landed job leaves in place', () => {
    const view = describePendingOcr({ jobs: jobsOf(0).slice(1), held: null }, NOW)!;
    expect(view.lines.map((l) => l.key)).toEqual(['layer:hayai-nova', 'layer:paddle-manga']);
  });

  it('moves with the clock', () => {
    const later = describePendingOcr({ jobs: jobsOf(0), held: null }, NOW + 5 * 60_000)!;
    expect(later.lines[1].detail).toBe(`in ~3 min · ${hhmm(at(8))}`);
  });

  it('is nothing when nothing is pending', () => {
    expect(describePendingOcr({ jobs: [], held: null }, NOW)).toBeNull();
    expect(describePendingOcr(undefined, NOW)).toBeNull();
  });
});
