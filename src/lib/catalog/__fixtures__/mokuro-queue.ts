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
import { bunkoBody, editExisting as edit } from '$lib/interop/contract';

interface QueueJobDoc {
  kind: string;
  id: string;
  state: string;
  eta: string | null;
  progress: number | null;
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
      jobs: [{ kind: 'ocr', id: 'hayai-nova', state: 'held', eta: null, progress: null }]
    }
  ]
};

/** The queue file Bunko serves, its times rebased onto `now`. */
export function servedQueueFile(now: number): QueueFixtureDoc {
  return bunkoBody('queue-file-http', QUEUE_SNAPSHOT, now);
}

export function queueFixture(now: number): QueueFixtureDoc {
  const at = (min: number) => new Date(now + min * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const served = servedQueueFile(now);
  const entry = served.volumes[0];
  const job = (patch: Partial<QueueJobDoc>) => edit(entry.jobs[0], patch);
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
