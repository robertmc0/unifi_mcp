/**
 * Application version ranges (spec §4.3 apiVersionRange, decision 23).
 */
import { parseRange, parseVersion, satisfies } from '@unifi-local-mcp/core';
import { describe, expect, it } from 'vitest';

describe('versions', () => {
  it('parse dotted versions and ignore build suffixes', () => {
    expect(parseVersion('11.0.97')).toEqual([11, 0, 97]);
    expect(parseVersion('v7.3.74-beta.1')).toEqual([7, 3, 74]);
    expect(parseVersion('11')).toEqual([11]);
    expect(parseVersion('eleven')).toBeUndefined();
    expect(parseVersion('1.2.3.4.5')).toBeUndefined();
  });

  it.each([
    ['11.0.97', '>=10.1 <12', true],
    ['12.0.0', '>=10.1 <12', false],
    ['10.0.99', '>=10.1 <12', false],
    ['10.1', '>=10.1.0', true],
    ['7.3.74', '=7.3.74', true],
    ['7.3.75', '7.3.74', false],
    ['9.1.120', '>9 <=9.1.120', true],
    ['garbage', '>=1', false],
    ['1.0.0', 'latest', false],
    ['1.0.0', '', false],
  ])('%s satisfies %j: %s', (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  it('rejects malformed ranges', () => {
    expect(parseRange('>=10 || <9')).toBeUndefined();
    expect(parseRange('~1.2')).toBeUndefined();
    expect(parseRange('>= 10')).toBeUndefined();
  });
});
