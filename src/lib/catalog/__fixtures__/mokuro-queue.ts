/**
 * `GET <dav root>/.mokuro-queue.json` exactly as Addendum C specifies it
 * (mokuro-bunko builds the endpoint to the same body shape).
 */
export function queueFixture(now: number) {
  const at = (min: number) => new Date(now + min * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return {
    version: 1,
    generated_at: at(0),
    held: null as null | { reason: string },
    next_check_after: 95,
    volumes: [
      {
        series: 'Dr Stone',
        volume: 'Dr Stone 01',
        path: '/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.cbz',
        manifest: '/catalog/api/manifest?series=Dr%20Stone&volume=Dr%20Stone%2001',
        jobs: [
          { kind: 'ocr', id: 'mokuro-fp16', state: 'running', eta: at(3), progress: 0.42 },
          { kind: 'layer', id: 'hayai-nova', state: 'queued', eta: at(8), progress: null },
          { kind: 'layer', id: 'paddle-manga', state: 'queued', eta: null, progress: null }
        ]
      },
      {
        series: 'Dr Stone',
        volume: 'Dr Stone 02',
        path: '/mokuro-reader/Dr%20Stone/Dr%20Stone%2002.cbz',
        manifest: '/catalog/api/manifest?series=Dr%20Stone&volume=Dr%20Stone%2002',
        jobs: [{ kind: 'ocr', id: 'mokuro-fp16', state: 'held', eta: null, progress: null }]
      }
    ]
  };
}
