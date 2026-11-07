import { describe, expect, it } from 'vitest';
import { scrubAnalyticsEvent, scrubAnalyticsUrl } from './analytics-scrub';

describe('scrubAnalyticsUrl', () => {
  it.each([
    ['https://reader.example/#/series/abc', 'https://reader.example/#/series/abc'],
    ['https://reader.example/#/reader/x?page=3', 'https://reader.example/#/reader/x?page=3'],
    ['https://reader.example/?code=4%2Fsecret&state=s', 'https://reader.example/'],
    ['https://reader.example/?ref=a&state=s', 'https://reader.example/?ref=a'],
    ['https://reader.example/#access_token=tok&token_type=Bearer', 'https://reader.example/'],
    ['https://reader.example/#token_type=Bearer&access_token=tok', 'https://reader.example/'],
    ['https://reader.example/#/cloud?access_token=tok&x=1', 'https://reader.example/#/cloud?x=1'],
    ['https://reader.example/#/cloud?code=c', 'https://reader.example/#/cloud'],
    [
      'https://reader.example/oauth/google-callback.html?code=c&state=s',
      'https://reader.example/oauth/google-callback.html'
    ]
  ])('%s → %s', (input, output) => {
    expect(scrubAnalyticsUrl(input)).toBe(output);
  });

  it('an unparseable URL loses its query and fragment', () => {
    expect(scrubAnalyticsUrl('not a url?code=c#x')).toBe('not a url');
  });

  it('scrubs every event, keeping its type', () => {
    expect(
      scrubAnalyticsEvent({ type: 'pageview', url: 'https://reader.example/?code=c' })
    ).toEqual({ type: 'pageview', url: 'https://reader.example/' });
  });
});
