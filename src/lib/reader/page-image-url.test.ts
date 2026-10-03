import { describe, expect, it } from 'vitest';
import { pageImageUrlFrom } from './page-image-url';

function page(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

describe('pageImageUrlFrom', () => {
  it('finds the image on the page’s .pageImage layer from a text box inside it', () => {
    const host = page(
      `<div data-page-index="0"><div class="pageImage" style="background-image: url(blob:x/1)"></div>` +
        `<div class="textBox"><p><span id="line">あ</span></p></div></div>`
    );
    expect(pageImageUrlFrom(host.querySelector('#line'))).toBe('blob:x/1');
    host.remove();
  });

  it('still reads an ancestor that carries the image as its own background', () => {
    const host = page(
      `<div style="background-image: url(blob:x/2)"><div class="textBox"><span id="line">い</span></div></div>`
    );
    expect(pageImageUrlFrom(host.querySelector('#line'))).toBe('blob:x/2');
    host.remove();
  });

  it('ignores a .pageImage that is not a direct child (another page’s layer)', () => {
    const host = page(
      `<div id="outer"><div><div class="pageImage" style="background-image: url(blob:x/3)"></div></div></div>`
    );
    expect(pageImageUrlFrom(host.querySelector('#outer'))).toBeNull();
    host.remove();
  });

  it('is null for null or an element on no page', () => {
    expect(pageImageUrlFrom(null)).toBeNull();
    const host = page(`<span id="x">x</span>`);
    expect(pageImageUrlFrom(host.querySelector('#x'))).toBeNull();
    host.remove();
  });
});
