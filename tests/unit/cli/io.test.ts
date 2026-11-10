/**
 * Terminal-safe output (ADR 0015).
 */
import { oneLine, terminalSafe } from '@unifi-local-mcp/cli';
import { describe, expect, it } from 'vitest';

describe('terminalSafe', () => {
  it('escapes control, C1, separator and bidi characters but keeps newlines and tabs', () => {
    expect(terminalSafe('a\u001b[31mb\rc\u0007d\u007fe\u009bf g‮h⁦i‏j')).toBe(
      'a\\u001b[31mb\\u000dc\\u0007d\\u007fe\\u009bf\\u2028g\\u202eh\\u2066i\\u200fj',
    );
    expect(terminalSafe('line 1\nline 2\tx')).toBe('line 1\nline 2\tx');
    expect(terminalSafe('Ünïcødé ✓ 名前')).toBe('Ünïcødé ✓ 名前');
  });

  it('produces JSON that parses to the same value', () => {
    const value = { name: 'x\u009b‮ y' };
    expect(JSON.parse(terminalSafe(JSON.stringify(value)))).toEqual(value);
  });
});

describe('oneLine', () => {
  it('also escapes newlines and tabs', () => {
    expect(oneLine('a\nb\tc')).toBe('a\\u000ab\\u0009c');
  });
});
