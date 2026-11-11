/**
 * Forward compatibility of an older contract revision (ADR 0019 §7): only additive
 * differences are allowed. Synthetic documents only.
 */
import { describe, expect, it } from 'vitest';
import { operationBreaks, schemaBreaks } from '../../../scripts/lib/revision-compat.ts';

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
});

describe('schema differences', () => {
  it('accept additions in responses: properties, required properties, enum values', () => {
    const older = object({ mode: { type: 'string', enum: ['a', 'b'] } }, ['mode']);
    const newer = object(
      { mode: { type: 'string', enum: ['a', 'b', 'c'] }, flags: { type: 'object' } },
      ['mode', 'flags'],
    );
    expect(schemaBreaks(older, newer, 'response')).toEqual([]);
  });

  it('refuse in responses: removed properties, dropped requirements, new types, nullability', () => {
    const older = object({ a: { type: 'string' }, b: { type: 'integer' } }, ['a', 'b']);
    expect(schemaBreaks(older, object({ b: { type: 'integer' } }, ['b']), 'response')).toEqual([
      '.properties.a: removed',
      '.required: "a" no longer required',
    ]);
    expect(
      schemaBreaks(
        older,
        object({ a: { type: ['string', 'null'] }, b: { type: 'string' } }, ['a', 'b']),
        'response',
      ),
    ).toEqual(['.properties.a.type: changed', '.properties.b.type: changed']);
  });

  it('accept in requests: new optional properties and enum values; refuse new requirements', () => {
    const older = object({ mode: { type: 'string', enum: ['a'] } });
    expect(
      schemaBreaks(
        older,
        object({ mode: { type: 'string', enum: ['a', 'b'] }, x: { type: 'string' } }),
        'request',
      ),
    ).toEqual([]);
    expect(
      schemaBreaks(older, object({ mode: { type: 'string', enum: ['a'] } }, ['mode']), 'request'),
    ).toEqual(['.required: "mode" now required']);
    expect(
      schemaBreaks(older, object({ mode: { type: 'string', enum: ['b'] } }), 'request'),
    ).toEqual(['.properties.mode.enum: "a" removed']);
  });

  it('refuse a new constraint on requests, and changed union members anywhere', () => {
    expect(schemaBreaks({ type: 'string' }, { type: 'string', maxLength: 8 }, 'request')).toEqual([
      '.maxLength: added',
    ]);
    expect(schemaBreaks({ type: 'string' }, { type: 'string', enum: ['a'] }, 'request')).toEqual([
      '.enum: added',
    ]);
    expect(
      schemaBreaks(
        { anyOf: [{ type: 'string' }] },
        { anyOf: [{ type: 'string' }, { type: 'null' }] },
        'response',
      ),
    ).toEqual(['.anyOf: members changed']);
    expect(
      schemaBreaks(
        { oneOf: [object({ a: { type: 'string' } })] },
        { oneOf: [object({ a: { type: 'string' }, b: { type: 'string' } }, ['b'])] },
        'response',
      ),
    ).toEqual([]);
  });
});

describe('operation differences', () => {
  const doc = (op: Record<string, unknown>, schemas: Record<string, unknown> = {}) => ({
    paths: { '/v1/t/{id}': { patch: op } },
    components: { schemas },
  });
  const op = (parameters: unknown[], body: unknown, response: unknown) => ({
    parameters,
    requestBody: { content: { 'application/json': { schema: body } } },
    responses: { '200': { content: { 'application/json': { schema: response } } } },
  });
  const id = { in: 'path', name: 'id', required: true, schema: { type: 'string' } };

  it('resolve references before comparing, and accept an additive revision', () => {
    const older = doc(
      op([id], { $ref: '#/components/schemas/B' }, { $ref: '#/components/schemas/R' }),
      {
        B: object({ name: { type: 'string' } }),
        R: object({ id: { type: 'string' } }, ['id']),
      },
    );
    const newer = doc(
      op(
        [id, { in: 'query', name: 'x', schema: { type: 'string' } }],
        { $ref: '#/components/schemas/B' },
        { $ref: '#/components/schemas/R' },
      ),
      {
        B: object({ name: { type: 'string' }, extra: { type: 'boolean' } }),
        R: object({ id: { type: 'string' }, added: { type: 'string' } }, ['id', 'added']),
      },
    );
    expect(operationBreaks(older, newer, 'PATCH /v1/t/{id}')).toEqual([]);
  });

  it('report a removed operation, a removed parameter and a new required one', () => {
    const older = doc(op([id], object({}), object({})));
    expect(operationBreaks(older, { paths: {} }, 'PATCH /v1/t/{id}')).toEqual([
      'PATCH /v1/t/{id}: removed',
    ]);
    const newer = doc(
      op(
        [{ in: 'query', name: 'q', required: true, schema: { type: 'string' } }],
        object({}),
        object({}),
      ),
    );
    expect(operationBreaks(older, newer, 'PATCH /v1/t/{id}')).toEqual([
      'PATCH /v1/t/{id} parameter path:id: removed',
      'PATCH /v1/t/{id} parameter query:q: new and required',
    ]);
  });
});
