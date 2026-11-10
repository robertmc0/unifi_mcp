/**
 * HTML output with escaping by default (spec §13.1; ADR 0016).
 *
 * Every interpolated value is escaped unless it is already `SafeHtml`. Before entity
 * escaping, control, C1 and bidirectional formatting characters are made visible as
 * `\uXXXX` (`displaySafe` in core), so text from UniFi or from an MCP client cannot reorder
 * or hide what the administrator reads on the approval page.
 */
import { displaySafe } from '@unifi-local-mcp/core';

export class SafeHtml {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }

  toString(): string {
    return this.value;
  }
}

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return displaySafe(text).replace(/[&<>"']/g, (char) => ENTITIES[char] ?? char);
}

function render(value: unknown): string {
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  if (value === undefined || value === null || value === false) return '';
  if (typeof value === 'string') return escapeHtml(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return escapeHtml(String(value));
  }
  // JSON.stringify returns undefined for these, despite its declared type.
  if (typeof value === 'function' || typeof value === 'symbol') return '';
  return escapeHtml(JSON.stringify(value));
}

/** Tagged template: `html\`<p>${name}</p>\`` escapes `name`. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0] ?? '';
  values.forEach((value, index) => {
    out += render(value) + (strings[index + 1] ?? '');
  });
  return new SafeHtml(out);
}
