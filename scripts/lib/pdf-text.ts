/**
 * Text lines of a PDF, per page, without dependencies (ADR 0022 §6). Dev tooling only: it
 * reads the checksum-pinned Access API reference so that the hand transcription can be
 * compared with it. It is never part of the service.
 *
 * It handles the subset of PDF that document uses: uncompressed cross-reference tables,
 * FlateDecode streams, Type0 (Identity-H) and simple fonts with ToUnicode maps, and Form
 * XObjects. Lines are reconstructed from text positioning, which is good enough to find
 * table rows and literal strings, not to reproduce layout. A document it cannot read
 * (no catalog or pages) throws.
 */
import { inflateSync, constants as zlibConstants } from 'node:zlib';

/** Each page's non-empty text lines, trimmed, in content-stream order. */
export type PdfPages = readonly (readonly string[])[];

/** A font's decoder: code → text, with the code width in bytes; `null` means Latin-1. */
interface Decoder {
  map: ReadonlyMap<number, string> | null;
  width: number;
}

const LATIN1: Decoder = { map: null, width: 1 };
const UTF16BE = new TextDecoder('utf-16be');
/** Content-stream tokens: strings, hex strings, array brackets, names, numbers, operators. */
const TOKEN =
  /\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>|\[|\]|\/[^\s/[\]()<>]+|[-+]?\d*\.?\d+|[A-Za-z'"*]+/g;
const NUMBER = /^[-+]?\d*\.?\d+$/;
const MAX_FORM_DEPTH = 4;

type Operand = string | string[];

function hexBytes(hex: string): Buffer {
  const clean = hex.replace(/\s/g, '');
  return Buffer.from(clean.length % 2 === 1 ? `${clean}0` : clean, 'hex');
}

function utf16(hex: string): string {
  return UTF16BE.decode(hexBytes(hex));
}

class PdfReader {
  /** Object number → its body between `obj` and `endobj`, as a binary (Latin-1) string. */
  readonly #objects = new Map<number, string>();
  readonly #cmaps = new Map<number, ReadonlyMap<number, string>>();

  constructor(bytes: Uint8Array) {
    const data = Buffer.from(bytes).toString('latin1');
    for (const match of data.matchAll(/(\d+)\s+0\s+obj\b/g)) {
      const start = match.index + match[0].length;
      const end = data.indexOf('endobj', start);
      // A later definition (an incremental update) replaces an earlier one.
      this.#objects.set(Number(match[1]), data.slice(start, end < 0 ? undefined : end));
    }
  }

  dict(num: number): string {
    const body = this.#objects.get(num) ?? '';
    const i = body.indexOf('stream');
    return i < 0 ? body : body.slice(0, i);
  }

  stream(num: number): string {
    const body = this.#objects.get(num);
    if (body === undefined) return '';
    const i = body.indexOf('stream');
    if (i < 0) return '';
    let j = i + 'stream'.length;
    if (body.startsWith('\r\n', j)) j += 2;
    else if (body[j] === '\n' || body[j] === '\r') j += 1;
    const k = body.lastIndexOf('endstream');
    const raw = body.slice(j, k < j ? undefined : k);
    if (!body.slice(0, i).includes('FlateDecode')) return raw;
    try {
      // Tolerates a stream whose end is cut short, as zlib's decompressobj does.
      const out = inflateSync(Buffer.from(raw, 'latin1'), {
        finishFlush: zlibConstants.Z_SYNC_FLUSH,
      });
      return out.toString('latin1');
    } catch {
      return '';
    }
  }

  static ref(dict: string, key: string): number | undefined {
    const match = new RegExp(`/${key}\\s+(\\d+)\\s+0\\s+R`).exec(dict);
    return match?.[1] === undefined ? undefined : Number(match[1]);
  }

  #cmap(num: number): ReadonlyMap<number, string> {
    const cached = this.#cmaps.get(num);
    if (cached !== undefined) return cached;
    const text = this.stream(num);
    const map = new Map<number, string>();
    for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const pair of (block[1] ?? '').matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        map.set(parseInt(pair[1] ?? '', 16), utf16(pair[2] ?? ''));
      }
    }
    for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      const ranges = (block[1] ?? '').matchAll(
        /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(\[[^\]]*\]|<[0-9A-Fa-f]+>)/g,
      );
      for (const range of ranges) {
        const low = parseInt(range[1] ?? '', 16);
        const high = parseInt(range[2] ?? '', 16);
        const target = range[3] ?? '';
        if (target.startsWith('[')) {
          let index = 0;
          for (const item of target.matchAll(/<([0-9A-Fa-f]+)>/g)) {
            map.set(low + index, utf16(item[1] ?? ''));
            index += 1;
          }
        } else {
          const base = hexBytes(target.slice(1, -1));
          const start = BigInt(`0x${base.toString('hex') || '0'}`);
          for (let code = low; code <= high; code++) {
            const value = (start + BigInt(code - low)).toString(16).padStart(base.length * 2, '0');
            map.set(code, utf16(value.slice(-base.length * 2)));
          }
        }
      }
    }
    this.#cmaps.set(num, map);
    return map;
  }

  decoder(font: number): Decoder {
    const dict = this.dict(font);
    const toUnicode = PdfReader.ref(dict, 'ToUnicode');
    const type0 = dict.includes('/Type0');
    if (toUnicode === undefined) return type0 ? { map: new Map(), width: 2 } : LATIN1;
    return { map: this.#cmap(toUnicode), width: type0 ? 2 : 1 };
  }

  #named(resources: string, kind: 'Font' | 'XObject'): Map<string, number> {
    const out = new Map<string, number>();
    const add = (text: string): void => {
      for (const match of text.matchAll(/\/([A-Za-z0-9_.+-]+)\s+(\d+)\s+0\s+R/g)) {
        out.set(match[1] ?? '', Number(match[2]));
      }
    };
    const inline = new RegExp(`/${kind}\\s*<<([\\s\\S]*?)>>`).exec(resources);
    if (inline !== null) {
      add(inline[1] ?? '');
    } else if (kind === 'Font') {
      const indirect = PdfReader.ref(resources, 'Font');
      if (indirect !== undefined) add(this.#objects.get(indirect) ?? '');
    }
    return out;
  }

  resources(dict: string): string {
    const indirect = PdfReader.ref(dict, 'Resources');
    if (indirect !== undefined) return this.#objects.get(indirect) ?? '';
    const i = dict.indexOf('/Resources');
    return i < 0 ? '' : dict.slice(i);
  }

  /** Appends the text lines of one content stream (and the forms it draws) to `lines`. */
  run(content: string, resources: string, lines: string[], depth = 0): void {
    const fonts = this.#named(resources, 'Font');
    const forms = this.#named(resources, 'XObject');
    let decoder = LATIN1;
    let stack: Operand[] = [];
    let array: string[] | undefined;
    let lastY: number | undefined;
    const current: string[] = [];
    const flush = (): void => {
      if (current.length > 0) {
        lines.push(current.join(''));
        current.length = 0;
      }
    };
    const top = (): Operand | undefined => stack[stack.length - 1];
    const numberAt = (operand: Operand | undefined): number | undefined => {
      if (typeof operand !== 'string') return undefined;
      const value = Number(operand);
      return Number.isFinite(value) ? value : undefined;
    };
    for (const [token] of content.matchAll(TOKEN)) {
      if (token === '[') {
        array = [];
        continue;
      }
      if (token === ']') {
        stack.push(array ?? []);
        array = undefined;
        continue;
      }
      if (array !== undefined) {
        array.push(token);
        continue;
      }
      if (/^[(</]/.test(token) || NUMBER.test(token)) {
        stack.push(token);
        continue;
      }
      const op = token;
      if (op === 'Tf' && stack.length >= 2) {
        const name = stack[stack.length - 2];
        const font = typeof name === 'string' ? fonts.get(name.slice(1)) : undefined;
        decoder = font === undefined ? LATIN1 : this.decoder(font);
      } else if ((op === 'Td' || op === 'TD') && stack.length >= 2) {
        const dy = numberAt(top()) ?? 0;
        if (Math.abs(dy) > 0.5) flush();
        else if (current.length > 0) current.push('');
      } else if (op === 'Tm' && stack.length >= 6) {
        const y = numberAt(top());
        if (y !== undefined) {
          if (lastY !== undefined && Math.abs(y - lastY) > 0.5) flush();
          lastY = y;
        }
      } else if (op === 'T*' || op === "'" || op === '"') {
        flush();
      }
      const operand = top();
      if ((op === 'Tj' || op === "'" || op === '"') && typeof operand === 'string') {
        current.push(decode(stringBytes(operand), decoder));
      } else if (op === 'TJ' && Array.isArray(operand)) {
        for (const item of operand) {
          if (item.startsWith('(') || item.startsWith('<')) {
            current.push(decode(stringBytes(item), decoder));
          } else if (Number(item) < -200) {
            current.push(' ');
          }
        }
      } else if (op === 'Do' && typeof operand === 'string' && depth < MAX_FORM_DEPTH) {
        const form = forms.get(operand.slice(1));
        if (form !== undefined && this.dict(form).includes('/Form')) {
          flush();
          const formResources = this.resources(this.dict(form));
          this.run(this.stream(form), formResources || resources, lines, depth + 1);
        }
      }
      stack = [];
    }
    flush();
  }

  #kids(num: number, seen: Set<number>): number[] {
    if (seen.has(num)) throw new Error(`PDF page tree loops at object ${String(num)}.`);
    seen.add(num);
    const dict = this.dict(num);
    if (!/\/Type\s*\/Pages/.test(dict)) return [num];
    const kids = /\/Kids\s*\[([^\]]*)\]/.exec(dict)?.[1] ?? '';
    return [...kids.matchAll(/(\d+)\s+0\s+R/g)].flatMap((m) => this.#kids(Number(m[1]), seen));
  }

  pages(): number[] {
    let root: number | undefined;
    for (const [num, body] of this.#objects) {
      if (/\/Type\s*\/Catalog/.test(body)) root = num;
    }
    if (root === undefined) throw new Error('PDF has no catalog.');
    const tree = PdfReader.ref(this.dict(root), 'Pages');
    if (tree === undefined) throw new Error('PDF catalog has no page tree.');
    const pages = this.#kids(tree, new Set());
    if (pages.length === 0) throw new Error('PDF has no pages.');
    return pages;
  }

  contents(page: number): string {
    const dict = this.dict(page);
    const list = /\/Contents\s*\[([^\]]*)\]/.exec(dict);
    const nums = list
      ? [...(list[1] ?? '').matchAll(/(\d+)\s+0\s+R/g)].map((m) => Number(m[1]))
      : [PdfReader.ref(dict, 'Contents')].filter((n): n is number => n !== undefined);
    return nums.map((n) => this.stream(n)).join('\n');
  }
}

function unescapeLiteral(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? '';
    if (c !== '\\' || i + 1 >= text.length) {
      out += c;
      continue;
    }
    const n = text[i + 1] ?? '';
    const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
    const escaped = escapes[n];
    if (escaped !== undefined) {
      out += escaped;
      i += 1;
    } else if (/[0-7]/.test(n)) {
      let j = i + 1;
      let value = 0;
      while (j < text.length && j < i + 4 && /[0-7]/.test(text[j] ?? '')) {
        value = value * 8 + Number(text[j]);
        j += 1;
      }
      out += String.fromCharCode(value & 0xff);
      i = j - 1;
    } else {
      out += n;
      i += 1;
    }
  }
  return out;
}

/** The bytes of a literal `(…)` or hex `<…>` string, as a binary (Latin-1) string. */
function stringBytes(token: string): string {
  if (token.startsWith('(')) return unescapeLiteral(token.slice(1, -1));
  return hexBytes(token.slice(1, -1)).toString('latin1');
}

function decode(raw: string, decoder: Decoder): string {
  if (decoder.map === null) return raw;
  let out = '';
  for (let i = 0; i + decoder.width <= raw.length; i += decoder.width) {
    let code = 0;
    for (let k = 0; k < decoder.width; k++) code = code * 256 + raw.charCodeAt(i + k);
    out += decoder.map.get(code) ?? '';
  }
  return out;
}

/** Extracts the text lines of every page, in page-tree order. */
export function extractPdfText(bytes: Uint8Array): PdfPages {
  const reader = new PdfReader(bytes);
  return reader.pages().map((page) => {
    const lines: string[] = [];
    reader.run(reader.contents(page), reader.resources(reader.dict(page)), lines);
    return lines.map((line) => line.trim()).filter((line) => line !== '');
  });
}
