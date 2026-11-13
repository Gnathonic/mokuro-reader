/**
 * `GET <dav root>/.mokuro-queue.json`, built on what mokuro-bunko actually
 * serves: the base document is its contract fixture `queue-file-http`
 * (`interop/contract/bunko/`, see `$lib/interop/contract`), and the volumes
 * these tests need are edits of that document's own entries. An edit may only
 * replace a field the served document HAS, so a field Bunko renames or drops
 * fails here instead of being quietly re-added.
 *
 * Without a Bunko checkout (and without `BUNKO_CONTRACT_REQUIRED=1`) the base
 * is the snapshot below, taken from that fixture.
 */
import { bunkoBody, editExisting as edit } from '#lib/interop/contract.js';

interface QueueJobDoc {
  kind: string;
  id: string;
  state: string;
  eta: string | null;
  progress: number | null;
  /** bunko 0.8: the job's tools, in `ocr_engine.parts` shape (optional). */
  parts?: unknown;
}

interface QueueVolumeDoc {
  series: string;
  volume: string;
  path: string;
  manifest: string;
  jobs: QueueJobDoc[];
}

export interface QueueFixtureDoc {
  version: number;
  generated_at: string;
  held: null | { reason: string };
  next_check_after: number | null;
  pending_volumes?: number;
  volumes: QueueVolumeDoc[];
}

/**
 * `queue-file-http`'s body as exported (sentinel times). `bunko-contract.test.ts`
 * checks it still equals the fixture whenever a Bunko checkout is there.
 */
export const QUEUE_SNAPSHOT: QueueFixtureDoc = {
  version: 1,
  generated_at: '2000-01-01T00:00:00Z',
  held: { reason: 'no-processor' },
  next_check_after: 300,
  pending_volumes: 1,
  volumes: [
    {
      series: 'Contract Series',
      volume: 'Volume 02',
      path: '/mokuro-reader/Contract%20Series/Volume%2002.cbz',
      manifest: '/catalog/api/manifest?series=Contract%20Series&volume=Volume%2002',
      jobs: [
        {
          kind: 'ocr',
          id: 'hayai-nova',
          parts: [
            { role: 'recognizer', name: 'Hayai Nova', version: '2.5' },
            { role: 'detector', name: 'PP-OCR Manga', version: '0.3' }
          ],
          state: 'held',
          eta: null,
          progress: null
        }
      ]
    }
  ]
};

/** A job document without its `parts` — what an older Bunko (before 0.8's parts) writes. */
export function withoutParts(job: QueueJobDoc): QueueJobDoc {
  const { parts: _parts, ...rest } = job;
  return rest;
}

/** The whole document as an older Bunko writes it: no job carries `parts`. */
export function stripQueueParts(doc: QueueFixtureDoc): QueueFixtureDoc {
  return {
    ...doc,
    volumes: doc.volumes.map((v) => ({ ...v, jobs: v.jobs.map(withoutParts) }))
  };
}

/** The queue file Bunko serves, its times rebased onto `now`. */
export function servedQueueFile(now: number): QueueFixtureDoc {
  return bunkoBody('queue-file-http', QUEUE_SNAPSHOT, now);
}

export function queueFixture(now: number): QueueFixtureDoc {
  const at = (min: number) => new Date(now + min * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const served = servedQueueFile(now);
  // Every variation below is an edit of Bunko's first volume and its first
  // job: name the fixture that lost them instead of a TypeError further down.
  const entry = served.volumes?.[0];
  if (!entry?.jobs?.[0]) {
    throw new Error(
      "Bunko's queue-file-http fixture has no volume with a job to vary " +
        `(volumes: ${JSON.stringify(served.volumes)})`
    );
  }
  // Bunko's job carries `parts` (0.8): these jobs are about times and states,
  // and are named by their generation id, so they drop them.
  const job = (patch: Partial<QueueJobDoc>) => withoutParts(edit(entry.jobs[0], patch));
  const volume = (n: string, jobs: QueueJobDoc[]) =>
    edit(entry, {
      series: 'Dr Stone',
      volume: `Dr Stone ${n}`,
      path: `/mokuro-reader/Dr%20Stone/Dr%20Stone%20${n}.cbz`,
      manifest: `/catalog/api/manifest?series=Dr%20Stone&volume=Dr%20Stone%20${n}`,
      jobs
    });
  return edit(served, {
    generated_at: at(0),
    held: null,
    next_check_after: 95,
    volumes: [
      volume('01', [
        job({ kind: 'ocr', id: 'mokuro-fp16', state: 'running', eta: at(3), progress: 0.42 }),
        job({ kind: 'layer', id: 'hayai-nova', state: 'queued', eta: at(8), progress: null }),
        job({ kind: 'layer', id: 'paddle-manga', state: 'queued', eta: null, progress: null })
      ]),
      volume('02', [
        job({ kind: 'ocr', id: 'mokuro-fp16', state: 'held', eta: null, progress: null })
      ])
    ]
  });
}

/** The parts of hayai-nova reading PP-OCR Manga lines, as bunko lists them. */
export const NOVA_ON_PPOCR_PARTS = [
  { role: 'recognizer', name: 'Hayai Nova', version: '2.5' },
  { role: 'detector', name: 'PP-OCR Manga', version: '0.3' }
];

/**
 * `queueFixture` plus a volume whose jobs carry bunko 0.8's optional `parts`
 * (the tools each job will use). `parts` is ADDED to Bunko's job document, not
 * edited in (`editExisting` refuses new fields): a server without it is the
 * other fixtures. The last job's `parts` is malformed on purpose.
 */
export function queueFixtureWithParts(now: number): QueueFixtureDoc {
  const base = queueFixture(now);
  const at = (min: number) => new Date(now + min * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const template = base.volumes[0];
  const job = ({ parts, ...patch }: QueueJobDoc): QueueJobDoc => ({
    ...edit(template.jobs[0], patch),
    parts
  });
  const volume = edit(template, {
    series: 'Dr Stone',
    volume: 'Dr Stone 03',
    path: '/mokuro-reader/Dr%20Stone/Dr%20Stone%2003.cbz',
    manifest: '/catalog/api/manifest?series=Dr%20Stone&volume=Dr%20Stone%2003',
    jobs: [
      job({
        kind: 'ocr',
        id: 'hayai-nova',
        state: 'running',
        eta: at(3),
        progress: 0.5,
        parts: NOVA_ON_PPOCR_PARTS
      }),
      job({
        kind: 'layer',
        id: 'ppocr-manga',
        state: 'queued',
        eta: at(8),
        progress: null,
        parts: [{ role: 'recognizer', name: 'PP-OCR Manga', version: '0.3' }]
      }),
      job({
        kind: 'layer',
        id: 'charspot-small',
        state: 'queued',
        eta: at(9),
        progress: null,
        parts: [
          { role: 'recognizer', name: 'Charspot Small' },
          { role: 'detector', name: 'AnimeText', version: '12x' }
        ]
      }),
      job({
        kind: 'layer',
        id: 'nar-small',
        state: 'queued',
        eta: at(10),
        progress: null,
        parts: [{ role: 'recognizer', version: '1' }]
      })
    ]
  });
  return { ...base, volumes: [...base.volumes, volume] };
}
