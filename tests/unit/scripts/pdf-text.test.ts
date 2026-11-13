/**
 * The dependency-free PDF text extraction (ADR 0022 §6). Synthetic PDFs built here: no
 * vendor content.
 */
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { extractPdfText } from '../../../scripts/lib/pdf-text.ts';

/** A PDF from object bodies, numbered from 1. The extractor needs no cross-reference table. */
function pdf(objects: readonly string[]): Uint8Array {
  const body = objects.map((o, i) => `${String(i + 1)} 0 obj\n${o}\nendobj\n`).join('');
  return Buffer.from(`%PDF-1.7\n${body}trailer\n<< /Root 1 0 R >>\n%%EOF\n`, 'latin1');
}

function stream(content: string, dict = '', compress = false): string {
  const data = compress ? deflateSync(Buffer.from(content, 'latin1')).toString('latin1') : content;
  const filter = compress ? ' /Filter /FlateDecode' : '';
  return `<< /Length ${String(data.length)}${filter}${dict} >>\nstream\n${data}\nendstream`;
}

/** UTF-16BE hex of a string, as a ToUnicode map writes it. */
function hex(text: string): string {
  return Buffer.from(text, 'utf16le').swap16().toString('hex').toUpperCase();
}

describe('PDF text extraction', () => {
  it('reads lines from simple fonts, split by vertical moves', () => {
    const content =
      'BT /F1 12 Tf 72 700 Td (first_name) Tj (TString) Tj 0 -14 Td (next \\(line\\)) Tj ET';
    const pages = extractPdfText(
      pdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
        stream(content),
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      ]),
    );
    expect(pages).toEqual([['first_nameTString', 'next (line)']]);
  });

  it('decodes compressed streams and Type0 fonts through their ToUnicode maps', () => {
    // Codes 0001–0003 map one by one; 0010–0012 map as a range starting at "a".
    const cmap = [
      'begincmap',
      '1 begincodespacerange <0000> <FFFF> endcodespacerange',
      `3 beginbfchar <0001> <${hex('I')}> <0002> <${hex('d')}> <0003> <${hex('é')}> endbfchar`,
      `1 beginbfrange <0010> <0012> <${hex('a')}> endbfrange`,
      'endcmap',
    ].join('\n');
    const content = [
      'BT /F1 10 Tf 1 0 0 1 72 700 Tm <00010002> Tj 1 0 0 1 120 700 Tm <0003> Tj',
      '1 0 0 1 72 680 Tm [<0010> -300 <00110012>] TJ ET',
    ].join('\n');
    const pages = extractPdfText(
      pdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
        stream(content, '', true),
        '<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /ToUnicode 6 0 R >>',
        stream(cmap, '', true),
      ]),
    );
    // Same Tm row: one line. A wide TJ gap becomes a space.
    expect(pages).toEqual([['Idé', 'a bc']]);
  });

  it('follows the page tree in order and draws form XObjects', () => {
    const pages = extractPdfText(
      pdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
        '<< /Type /Pages /Parent 2 0 R /Kids [5 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 8 0 R >> >> /Contents 6 0 R >>',
        '<< /Type /Page /Parent 3 0 R /Resources << /Font << /F1 8 0 R >> /XObject << /Fm1 9 0 R >> >> /Contents [7 0 R] >>',
        stream('BT /F1 9 Tf 0 0 Td (two) Tj ET'),
        stream('BT /F1 9 Tf 0 0 Td (one) Tj ET /Fm1 Do'),
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        stream('BT /F1 9 Tf 0 0 Td (form text) Tj ET', ' /Type /XObject /Subtype /Form'),
      ]),
    );
    expect(pages).toEqual([['one', 'form text'], ['two']]);
  });

  it('fails on a document without a catalog or pages instead of guessing', () => {
    expect(() => extractPdfText(Buffer.from('%PDF-1.7\nnothing here\n'))).toThrow(/catalog/);
    expect(() =>
      extractPdfText(
        pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [] /Count 0 >>']),
      ),
    ).toThrow(/no pages/);
    expect(() =>
      extractPdfText(
        pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [2 0 R] /Count 1 >>']),
      ),
    ).toThrow(/loops/);
  });
});
