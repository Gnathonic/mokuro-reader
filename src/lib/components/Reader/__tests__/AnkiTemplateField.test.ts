import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import AnkiTemplateField from '../AnkiTemplateField.svelte';
import { escapeFieldText } from '$lib/anki-connect/field-html';

afterEach(() => cleanup());

function renderPreview(resolvedValue: string) {
  return render(AnkiTemplateField, {
    props: {
      fieldName: 'Sentence',
      fieldId: 'sentence',
      template: '{sentence}',
      resolvedValue,
      templateButtons: []
    }
  });
}

describe('AnkiTemplateField preview', () => {
  it('shows an escaped OCR value as the text that was read, never as markup', () => {
    const ocr = `<img src=x onerror="alert('1')"> & 「嫌だ」`;
    const { container } = renderPreview(escapeFieldText(ocr));

    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain(ocr);
    expect(container.textContent).not.toContain('&#39;');
  });

  it('still summarizes real field markup', () => {
    const { container } = renderPreview('<b>猫</b><img src="a.jpg">');
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('猫[img]');
  });
});
