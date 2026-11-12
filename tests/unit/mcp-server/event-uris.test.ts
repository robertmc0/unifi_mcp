/**
 * Event resource URIs are parsed strictly (ADR 0020 §5): only the documented shape, and
 * for reads only `after` (a cursor) and `limit` (1–100).
 */
import { parseEventUri } from '@unifi-local-mcp/mcp-server';
import { describe, expect, it } from 'vitest';

const BASE = 'unifi://consoles/0b6f7c1e-2f1d-4c1a-9a51-3f2b5a1d9e10/protect/events';
const CURSOR = 'AbCdEfGhIjKlMnOpQrStUv';

describe('event resource URIs', () => {
  it('parse the subscription form and the read form', () => {
    expect(parseEventUri(BASE)).toEqual({
      consoleId: '0b6f7c1e-2f1d-4c1a-9a51-3f2b5a1d9e10',
      moduleId: 'protect',
      streamId: 'events',
      base: BASE,
    });
    expect(parseEventUri(`${BASE}?after=${CURSOR}&limit=100`, true)).toMatchObject({
      base: BASE,
      after: CURSOR,
      limit: 100,
    });
  });

  it.each([
    ['a query where none is allowed', `${BASE}?limit=5`, false],
    ['another scheme', BASE.replace('unifi://', 'https://'), true],
    ['an extra segment', `${BASE}/more`, true],
    ['an encoded slash', BASE.replace('/protect/', '%2Fprotect/'), true],
    ['an upper-case module', BASE.replace('/protect/', '/Protect/'), true],
    ['an unknown parameter', `${BASE}?after=${CURSOR}&debug=1`, true],
    ['a repeated parameter', `${BASE}?limit=1&limit=2`, true],
    ['a malformed cursor', `${BASE}?after=../../etc`, true],
    ['a limit of 0', `${BASE}?limit=0`, true],
    ['a limit over 100', `${BASE}?limit=101`, true],
    ['two queries', `${BASE}?limit=1?limit=2`, true],
    ['an overlong URI', `${BASE}?after=${'A'.repeat(600)}`, true],
  ])('refuse %s', (_label, uri, allowQuery) => {
    expect(parseEventUri(uri, allowQuery)).toBeUndefined();
  });
});
