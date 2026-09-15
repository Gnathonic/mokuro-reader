import { describe, expect, it, vi } from 'vitest';
import { RetryableError } from './run-queue';
import { annotateImage, prepareImage, testGoogleVision, VISION_ENDPOINT } from './gcv';

function fetchOk(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}
const asFetch = (f: unknown) => f as typeof fetch;

describe('annotateImage', () => {
  it('posts DOCUMENT_TEXT_DETECTION with ja hints to the keyed endpoint', async () => {
    const f = fetchOk({ responses: [{}] });
    await annotateImage('AAAA', 'k-1', { fetch: asFetch(f) });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${VISION_ENDPOINT}?key=k-1`);
    const body = JSON.parse(init.body as string);
    expect(body.requests[0].image.content).toBe('AAAA');
    expect(body.requests[0].features).toEqual([{ type: 'DOCUMENT_TEXT_DETECTION' }]);
    expect(body.requests[0].imageContext.languageHints).toEqual(['ja']);
  });

  it('maps 429/5xx to RetryableError and other failures to Error with the API message', async () => {
    await expect(
      annotateImage('A', 'k', { fetch: asFetch(fetchOk({}, 429)) })
    ).rejects.toBeInstanceOf(RetryableError);
    await expect(
      annotateImage('A', 'k', {
        fetch: asFetch(fetchOk({ error: { message: 'API key not valid' } }, 400))
      })
    ).rejects.toThrow('API key not valid');
    // a per-response error inside a 200 is an error too
    await expect(
      annotateImage('A', 'k', {
        fetch: asFetch(fetchOk({ responses: [{ error: { message: 'bad image' } }] }))
      })
    ).rejects.toThrow('bad image');
  });
});

describe('prepareImage', () => {
  it('sends the image as-is under 4 MP and halves a 16 MP one (scale 0.5)', async () => {
    const draw = vi.fn(async () => new Blob(['x']));
    const decode = vi.fn(async () => ({ width: 4000, height: 4000, draw }));
    const r = await prepareImage(new Blob(['png']), 4_000_000, decode);
    expect(r.scale).toBe(0.5);
    expect(draw).toHaveBeenCalledWith(2000, 2000);

    const small = vi.fn(async () => ({ width: 1000, height: 1000, draw }));
    const r2 = await prepareImage(new Blob(['png']), 4_000_000, small);
    expect(r2.scale).toBe(1);
    expect(r2.base64).toBe(btoa('png'));
  });
});

describe('testGoogleVision', () => {
  it('reports ok / the error message', async () => {
    expect(await testGoogleVision('k', asFetch(fetchOk({ responses: [{}] })))).toEqual({
      ok: true
    });
    expect(
      await testGoogleVision('k', asFetch(fetchOk({ error: { message: 'nope' } }, 403)))
    ).toEqual({ ok: false, error: 'nope' });
  });
});
