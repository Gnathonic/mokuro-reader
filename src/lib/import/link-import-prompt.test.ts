import { describe, expect, it } from 'vitest';
import { buildLinkImportPrompt, linkDisplayName } from './link-import-prompt';
import { parseHtmlDownloadRequest, type HtmlDownloadRequest } from './html-download-provider';

function request(query: string): HtmlDownloadRequest {
  const parsed = parseHtmlDownloadRequest(new URLSearchParams(query));
  if (!parsed) throw new Error(`not a request: ${query}`);
  return parsed;
}

const cbz = (url: string, extra = '') => request(`cbz=${encodeURIComponent(url)}${extra}`);

describe('buildLinkImportPrompt', () => {
  it('names the volume and shows where it downloads from, large, before anything is fetched', () => {
    const prompt = buildLinkImportPrompt(
      cbz('https://books.example.com/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.cbz'),
      new Set()
    );
    expect(prompt.message).toBe('Import Dr Stone 01 into your catalog?');
    expect(prompt.source).toEqual({ label: 'Downloads from', values: ['books.example.com'] });
    expect(prompt.warnings).toEqual([]);
    expect(prompt.confirmLabel).toBe('Import');
    // A stray Enter declines rather than imports.
    expect(prompt.focusCancel).toBe(true);
    expect(prompt.seriesUpdate).toBeUndefined();
  });

  it('lists every host the link names once, with the port', () => {
    const prompt = buildLinkImportPrompt(
      cbz(
        'https://books.example.com/S/V.cbz',
        `&manifest=${encodeURIComponent('https://books.example.com/api/manifest?v=1')}` +
          `&cover=${encodeURIComponent('https://img.example.net:8443/c.webp')}`
      ),
      new Set()
    );
    expect(prompt.source.values).toEqual(['books.example.com', 'img.example.net:8443']);
  });

  it('a relative cover is on the archive host and adds none', () => {
    const prompt = buildLinkImportPrompt(
      cbz('https://books.example.com/S/V.cbz', '&cover=S/V.webp'),
      new Set()
    );
    expect(prompt.source.values).toEqual(['books.example.com']);
  });

  it('warns, in plain words, about plain http and private addresses', () => {
    const prompt = buildLinkImportPrompt(cbz('http://192.168.1.20:8080/S/V.cbz'), new Set());
    expect(prompt.source.values).toEqual(['192.168.1.20:8080']);
    expect(prompt.warnings).toHaveLength(2);
    expect(prompt.warnings[0]).toContain('does not use a secure connection (https)');
    expect(prompt.warnings[1]).toContain('private address');
  });

  it('warns about a link that points at this device', () => {
    const prompt = buildLinkImportPrompt(cbz('http://localhost:9090/S/V.cbz'), new Set());
    expect(prompt.warnings).toEqual([
      'localhost:9090 is this device itself. A link from a website should not normally point here.'
    ]);
  });

  it('warns about each risky host, not only the archive’s', () => {
    const prompt = buildLinkImportPrompt(
      cbz(
        'https://books.example.com/S/V.cbz',
        `&manifest=${encodeURIComponent('http://10.0.0.2/manifest')}`
      ),
      new Set()
    );
    expect(prompt.source.values).toEqual(['books.example.com', '10.0.0.2']);
    expect(prompt.warnings.join(' ')).toContain('10.0.0.2 is a private address');
  });

  it('judges every target on a host, so plain http beside https on the same host still warns', () => {
    // One host, two schemes: the manifest — which picks every other URL —
    // travels in the clear even though the archive link is https.
    const prompt = buildLinkImportPrompt(
      cbz(
        'https://books.example.com/S/V.cbz',
        `&manifest=${encodeURIComponent('http://books.example.com/manifest')}`
      ),
      new Set()
    );
    expect(prompt.source.values).toEqual(['books.example.com']);
    expect(prompt.warnings).toEqual([
      'books.example.com does not use a secure connection (https). What is downloaded from it could be read or changed on the way.'
    ]);
  });

  it('says a warning once, however many targets earn it', () => {
    const prompt = buildLinkImportPrompt(
      cbz(
        'http://books.example.com/S/V.cbz',
        `&manifest=${encodeURIComponent('http://books.example.com/manifest')}`
      ),
      new Set()
    );
    expect(prompt.warnings).toHaveLength(1);
  });

  it('covers directory-mode links (source=…)', () => {
    const prompt = buildLinkImportPrompt(
      request('source=http://nas.local/manga&manga=Dr%20Stone&volume=Dr%20Stone%2001'),
      new Set()
    );
    expect(prompt.source.values).toEqual(['nas.local']);
    expect(prompt.warnings.join(' ')).toContain('private address');
  });

  describe('a series already in the library', () => {
    const existing = new Set(['dr stone']);

    it('says the volume joins it, and offers — unticked — to let the link update its info', () => {
      const prompt = buildLinkImportPrompt(
        cbz(
          'https://books.example.com/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.cbz',
          `&manifest=${encodeURIComponent('https://books.example.com/m')}`
        ),
        existing
      );
      expect(prompt.notes.join(' ')).toContain('“Dr Stone” is already in your library');
      expect(prompt.notes.join(' ')).toContain('left as it is, unless you tick the box');
      expect(prompt.seriesUpdate).toEqual({
        label: 'Let this link update the series info of “Dr Stone”',
        seriesKey: 'dr stone'
      });
    });

    it('offers the box without a manifest too: the archive itself can carry a series.json', () => {
      const prompt = buildLinkImportPrompt(
        cbz('https://books.example.com/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.cbz'),
        existing
      );
      expect(prompt.notes.join(' ')).toContain('already in your library');
      expect(prompt.notes.join(' ')).toContain('left as it is, unless you tick the box');
      expect(prompt.seriesUpdate?.seriesKey).toBe('dr stone');
    });

    it('matches a decomposed (NFD) spelling of a composed series name', () => {
      const prompt = buildLinkImportPrompt(
        cbz(`https://books.example.com/${encodeURIComponent('Pokémon'.normalize('NFD'))}/V.cbz`),
        new Set(['pokémon'.normalize('NFC')])
      );
      expect(prompt.seriesUpdate?.seriesKey).toBe('pokémon'.normalize('NFC'));
    });

    it('matches the series the way the catalog groups it (case, spacing)', () => {
      const prompt = buildLinkImportPrompt(
        cbz(
          'https://books.example.com/mokuro-reader/DR%20%20STONE/V.cbz',
          `&manifest=${encodeURIComponent('https://books.example.com/m')}`
        ),
        existing
      );
      expect(prompt.seriesUpdate?.seriesKey).toBe('dr stone');
    });
  });
});

describe('linkDisplayName', () => {
  it('survives a name with a bare % in it', () => {
    expect(linkDisplayName(cbz('https://e.example.com/S/100%25%20Love.cbz'))).toBe('100% Love');
  });
});

describe('parseHtmlDownloadRequest only takes web addresses', () => {
  it.each(['javascript:alert(1)', 'data:application/zip;base64,UEsDBA==', 'blob:abc'])(
    'refuses cbz=%s',
    (value) => {
      expect(parseHtmlDownloadRequest(new URLSearchParams({ cbz: value }))).toBeNull();
    }
  );

  it('refuses a directory source that is not http(s)', () => {
    expect(
      parseHtmlDownloadRequest(
        new URLSearchParams({ source: 'javascript:alert(1)', manga: 'S', volume: 'V' })
      )
    ).toBeNull();
  });

  it('drops a manifest that is not http(s), keeping the archive', () => {
    const parsed = parseHtmlDownloadRequest(
      new URLSearchParams({ cbz: 'https://e.example.com/S/V.cbz', manifest: 'data:,{}' })
    );
    expect(parsed?.cbzUrl).toBe('https://e.example.com/S/V.cbz');
    expect(parsed?.manifestUrl).toBeUndefined();
  });
});
