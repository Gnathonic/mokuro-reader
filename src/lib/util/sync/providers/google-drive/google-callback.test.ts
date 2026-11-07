/**
 * The static OAuth callback (`static/oauth/google-callback.js`), run as the
 * browser runs it: a classic script reading `location`, `history` and
 * `sessionStorage`, handed fakes here. It must drop the code from the URL
 * before anything else, hand the answer to the app only for a flow this tab
 * started, and send the tab back to a hash route of the app — never anywhere
 * else.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import script from '../../../../../../static/oauth/google-callback.js?raw';
import page from '../../../../../../static/oauth/google-callback.html?raw';
import { CALLBACK_KEY, PENDING_KEY, takeCallback } from './auth-backend';

interface Run {
  events: string[];
  replacedWith: string | undefined;
}

/**
 * Run the page's script against fake globals. The script is our own static
 * file (`?raw` at build time), evaluated with its globals resolved through a
 * scope object so a test can record, or make throw, each access.
 */
function runCallback(search: string, storage: 'blocked' | Storage = sessionStorage): Run {
  const run: Run = { events: [], replacedWith: undefined };
  const location = {
    search,
    pathname: '/oauth/google-callback.html',
    replace: (url: string) => {
      run.events.push(`replace ${url}`);
      run.replacedWith = url;
    }
  };
  const history = {
    replaceState: (_data: unknown, _unused: string, url: string) => {
      run.events.push(`replaceState ${url}`);
      location.search = '';
    }
  };
  const recorded = {
    getItem: (key: string) => {
      run.events.push(`getItem ${key}`);
      return (storage as Storage).getItem(key);
    },
    setItem: (key: string, value: string) => {
      run.events.push(`setItem ${key}`);
      (storage as Storage).setItem(key, value);
    }
  };
  const scope = {
    location,
    history,
    URLSearchParams,
    JSON,
    get sessionStorage() {
      if (storage === 'blocked') throw new DOMException('denied', 'SecurityError');
      return recorded;
    }
  };
  // Sloppy-mode wrapper so `with` can supply the globals; the script's own
  // IIFE is still strict inside it.
  new Function('scope', `with (scope) {\n${script}\n}`)(scope);
  return run;
}

function startFlow(returnTo = '#/cloud', state = 'S1') {
  sessionStorage.setItem(
    PENDING_KEY,
    JSON.stringify({ state, verifier: 'v'.repeat(43), returnTo, createdAt: Date.now() })
  );
}

beforeEach(() => sessionStorage.clear());

describe('the OAuth callback page', () => {
  it('is static, external-script only, and sends no Referer', () => {
    expect(page).toContain('<meta name="referrer" content="no-referrer" />');
    expect(page).toContain('<script src="/oauth/google-callback.js"></script>');
    // No inline script anywhere.
    expect(page.match(/<script\b[^>]*>/g)).toEqual(['<script src="/oauth/google-callback.js">']);
  });

  it('drops the query from the URL before it does anything else', () => {
    startFlow();
    const run = runCallback('?code=4%2Fsecret&state=S1');
    expect(run.events[0]).toBe('replaceState /oauth/google-callback.html');
  });

  it('hands the code and state to the app and returns to where the sign-in started', () => {
    startFlow('#/series/abc');
    const run = runCallback('?code=4%2Fsecret&state=S1&scope=x');
    expect(JSON.parse(sessionStorage.getItem(CALLBACK_KEY)!)).toEqual({
      code: '4/secret',
      state: 'S1',
      error: null
    });
    expect(run.replacedWith).toBe('/#/series/abc');
    // The app then takes it, once.
    expect(takeCallback()).toEqual({ kind: 'code', code: '4/secret', verifier: 'v'.repeat(43) });
    expect(takeCallback()).toEqual({ kind: 'none' });
  });

  it('hands a refusal on as an error (the user cancelled at Google)', () => {
    startFlow();
    runCallback('?error=access_denied&state=S1');
    expect(takeCallback()).toEqual({ kind: 'denied', error: 'access_denied' });
  });

  it('a code with no sign-in pending in this tab is dropped, not stored', () => {
    const run = runCallback('?code=4%2Fplanted&state=S1');
    expect(sessionStorage.getItem(CALLBACK_KEY)).toBeNull();
    expect(run.replacedWith).toBe('/');
  });

  it.each([
    '//evil.example/#/x',
    'https://evil.example',
    'javascript:alert(1)',
    '#access_token=x',
    '#/x"onload="y',
    '#/<script>',
    `#/${'x'.repeat(600)}`
  ])('never returns anywhere but a hash route of the app: %s', (returnTo) => {
    startFlow(returnTo);
    const run = runCallback('?code=4%2Fc&state=S1');
    expect(run.replacedWith).toBe('/');
  });

  it('passes on only sane values', () => {
    startFlow();
    runCallback(`?code=${'c'.repeat(3000)}&state=S1`);
    expect(sessionStorage.getItem(CALLBACK_KEY)).toBeNull();
    runCallback('?code=4%2Fc&state=S1&error=%3Cb%3E');
    expect(JSON.parse(sessionStorage.getItem(CALLBACK_KEY)!).error).toBeNull();
  });

  it('with storage blocked it still leaves the callback, signed out', () => {
    const run = runCallback('?code=4%2Fc&state=S1', 'blocked');
    expect(run.events[0]).toBe('replaceState /oauth/google-callback.html');
    expect(run.replacedWith).toBe('/');
  });

  it('with storage that throws on use it still leaves the callback', () => {
    const broken = {
      getItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      }
    } as unknown as Storage;
    const run = runCallback('?code=4%2Fc&state=S1', broken);
    expect(run.replacedWith).toBe('/');
  });

  it('is a classic script (runs during parse, before anything else on the page)', () => {
    expect(script).not.toMatch(/^\s*(import|export)\b/m);
  });
});
