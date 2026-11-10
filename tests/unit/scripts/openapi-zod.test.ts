/**
 * The OpenAPI → zod translator (ADR 0018). Synthetic documents only: no vendor content.
 */
import { stripTypeScriptTypes } from 'node:module';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  DEFAULT_MAX_ITEMS,
  DEFAULT_MAX_STRING,
  generateZodModule,
  identifierFor,
  type GeneratorOptions,
} from '../../../scripts/lib/openapi-zod.ts';

const OPTIONS: GeneratorOptions = {
  source: 'synthetic.json',
  sourceSha256: '0'.repeat(64),
  generator: 'test',
  targetParameters: ['siteId'],
};

type Doc = Record<string, unknown>;

function doc(schemas: Record<string, unknown>, paths: Record<string, unknown>): Doc {
  return { openapi: '3.1.0', components: { schemas }, paths };
}

function get(responseRef: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    get: {
      operationId: 'getThing',
      responses: {
        '200': { content: { 'application/json': { schema: { $ref: responseRef } } } },
      },
      ...extra,
    },
  };
}

function post(bodyRef: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    post: {
      operationId: 'createThing',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: bodyRef } } },
      },
      responses: { '201': { content: { 'application/json': { schema: { $ref: bodyRef } } } } },
      ...extra,
    },
  };
}

interface GeneratedOperation {
  method: string;
  path: string;
  queryParameters: readonly string[];
  hasBody: boolean;
  input: z.ZodType;
  output: z.ZodType;
}

/**
 * Evaluates a generated module: types stripped, `zod` injected. The code comes only from
 * the synthetic documents in this file, which is why evaluating it is acceptable here.
 */
function load(source: string): Record<string, GeneratedOperation> {
  const names = [...source.matchAll(/^export const (\w+) = \{/gm)].map((m) => m[1] ?? '');
  const body = stripTypeScriptTypes(source)
    .replace(/^import \* as z from 'zod';$/m, '')
    .replace(/^export const /gm, 'const ');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func -- see above
  const factory = new Function('z', `${body}\nreturn { ${names.join(', ')} };`) as (
    zod: typeof z,
  ) => Record<string, GeneratedOperation>;
  return factory(z);
}

function generate(document: Doc, options: Partial<GeneratorOptions> = {}): string {
  return generateZodModule(document, { ...OPTIONS, ...options });
}

const THING = {
  type: 'object',
  description: 'VENDOR PROSE THAT MUST NOT BE COPIED',
  properties: {
    id: { type: 'string', format: 'uuid', example: 'VENDOR-EXAMPLE' },
    name: { type: 'string', minLength: 1, maxLength: 32 },
    state: { type: 'string', enum: ['ON', 'OFF'] },
    count: { type: 'integer', format: 'int32', minimum: 0 },
    big: { type: 'integer', format: 'int64' },
    ratio: { type: 'number', format: 'double', maximum: 1 },
    flag: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' }, uniqueItems: true, minItems: 1 },
    level: { type: 'integer', enum: ['1', '2'] },
    at: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'name'],
};

describe('generated request schemas', () => {
  const ops = load(
    generate(
      doc(
        { Thing: THING },
        {
          '/v1/sites/{siteId}/things/{thingId}': {
            parameters: [
              { in: 'path', name: 'siteId', required: true, schema: { type: 'string' } },
            ],
            ...post('#/components/schemas/Thing', {
              parameters: [
                {
                  in: 'path',
                  name: 'thingId',
                  required: true,
                  schema: { type: 'string', format: 'uuid' },
                },
                { in: 'query', name: 'force', schema: { type: 'boolean' } },
              ],
            }),
          },
        },
      ),
    ),
  );
  const op = ops['createThing'];
  const ok = { thingId: '00000000-0000-0000-0000-000000000001' };
  const body = { id: '00000000-0000-0000-0000-000000000002', name: 'a' };

  it('records method, path, query and body placement; siteId is a target', () => {
    expect(op).toMatchObject({
      method: 'POST',
      path: '/v1/sites/{siteId}/things/{thingId}',
      queryParameters: ['force'],
      hasBody: true,
    });
    expect(op?.input.safeParse({ ...ok, body, siteId: 'x' }).success).toBe(false);
    expect(op?.input.safeParse({ ...ok, body, force: true }).success).toBe(true);
  });

  it('rejects unknown properties at every level', () => {
    expect(op?.input.safeParse({ ...ok, body, extra: 1 }).success).toBe(false);
    expect(op?.input.safeParse({ ...ok, body: { ...body, extra: 1 } }).success).toBe(false);
  });

  it('enforces required fields, enums, formats and documented bounds', () => {
    const bad = (patch: Record<string, unknown>): boolean =>
      op?.input.safeParse({ ...ok, body: { ...body, ...patch } }).success === false;
    expect(op?.input.safeParse({ ...ok }).success).toBe(false);
    expect(bad({ name: '' })).toBe(true);
    expect(bad({ name: 'x'.repeat(33) })).toBe(true);
    expect(bad({ state: 'MAYBE' })).toBe(true);
    expect(bad({ id: 'not-a-uuid' })).toBe(true);
    expect(bad({ count: -1 })).toBe(true);
    expect(bad({ count: 1.5 })).toBe(true);
    expect(bad({ count: 2 ** 31 })).toBe(true);
    expect(bad({ big: 2 ** 53 })).toBe(true);
    expect(bad({ ratio: 2 })).toBe(true);
    expect(bad({ tags: [] })).toBe(true);
    expect(bad({ tags: ['a', 'a'] })).toBe(true);
    expect(bad({ at: 'yesterday' })).toBe(true);
    expect(bad({ level: 1 })).toBe(false);
    expect(bad({ level: '1' })).toBe(true); // numeric-string enum values become numbers
    expect(bad({ level: 3 })).toBe(true);
  });

  it('bounds strings and arrays that the contract leaves unbounded', () => {
    const tags = (n: number): unknown => ({
      ...ok,
      body: { ...body, tags: Array.from({ length: n }, (_, i) => String(i)) },
    });
    expect(op?.input.safeParse(tags(DEFAULT_MAX_ITEMS)).success).toBe(true);
    expect(op?.input.safeParse(tags(DEFAULT_MAX_ITEMS + 1)).success).toBe(false);
    const unbounded = load(
      generate(
        doc(
          { S: { type: 'object', properties: { s: { type: 'string' } } } },
          { '/v1/s': post('#/components/schemas/S') },
        ),
      ),
    )['createThing'];
    expect(
      unbounded?.input.safeParse({ body: { s: 'x'.repeat(DEFAULT_MAX_STRING) } }).success,
    ).toBe(true);
    expect(
      unbounded?.input.safeParse({ body: { s: 'x'.repeat(DEFAULT_MAX_STRING + 1) } }).success,
    ).toBe(false);
  });
});

describe('generated response schemas', () => {
  const op = load(
    generate(doc({ Thing: THING }, { '/v1/things': get('#/components/schemas/Thing') })),
  )['getThing'];

  it('strip undocumented fields and accept unknown enum values', () => {
    const parsed = op?.output.parse({
      id: 'x',
      name: 'n',
      state: 'NEW_VALUE',
      passphrase: 'undocumented secret',
    });
    expect(parsed).toEqual({ id: 'x', name: 'n', state: 'NEW_VALUE' });
  });

  it('still require documented required fields', () => {
    expect(op?.output.safeParse({ id: 'x' }).success).toBe(false);
  });

  it('copy no vendor prose or examples', () => {
    const source = generate(
      doc({ Thing: THING }, { '/v1/things': get('#/components/schemas/Thing') }),
    );
    expect(source).not.toContain('VENDOR');
  });

  it('turn an undocumented success body into null', () => {
    const ops = load(
      generate(
        doc(
          {},
          {
            '/v1/things/{thingId}': {
              delete: {
                operationId: 'deleteThing',
                parameters: [
                  { in: 'path', name: 'thingId', required: true, schema: { type: 'string' } },
                ],
                responses: { '200': { description: 'OK' } },
              },
            },
          },
        ),
      ),
    );
    expect(ops['deleteThing']?.output.parse({ anything: 'at all' })).toBeNull();
  });
});

describe('discriminated unions', () => {
  const schemas = {
    Base: {
      type: 'object',
      discriminator: {
        propertyName: 'kind',
        mapping: { A: '#/components/schemas/VariantA', B: '#/components/schemas/VariantB' },
      },
      properties: { kind: { type: 'string' }, name: { type: 'string' }, filter: {} },
      required: ['name'],
    },
    // Extends the base explicitly and narrows `name` and the unconstrained `filter`.
    VariantA: {
      allOf: [
        { $ref: '#/components/schemas/Base' },
        {
          type: 'object',
          properties: {
            a: { type: 'integer' },
            name: { type: 'string', maxLength: 5 },
            filter: { type: 'string' },
          },
        },
      ],
      required: ['a'],
    },
    // Does not repeat the base: its properties still apply (JSON Schema semantics).
    VariantB: { type: 'object', properties: { b: { type: 'boolean' } }, required: ['b'] },
  };
  const narrowedB = {
    ...schemas,
    VariantB: {
      type: 'object',
      properties: { b: { type: 'boolean' }, filter: { type: 'string' } },
      required: ['b'],
    },
  };
  const ops = load(
    generate(
      doc(narrowedB, {
        '/v1/things': {
          ...get('#/components/schemas/Base'),
          ...post('#/components/schemas/Base'),
        },
      }),
    ),
  );

  it('select the variant by its literal, merging the base properties', () => {
    const input = ops['createThing']?.input;
    expect(input?.safeParse({ body: { kind: 'A', name: 'n', a: 1 } }).success).toBe(true);
    expect(input?.safeParse({ body: { kind: 'B', name: 'n', b: true } }).success).toBe(true);
    expect(input?.safeParse({ body: { kind: 'B', b: true } }).success).toBe(false); // base `name`
    expect(input?.safeParse({ body: { kind: 'A', name: 'n', b: true } }).success).toBe(false);
    expect(input?.safeParse({ body: { kind: 'C', name: 'n' } }).success).toBe(false);
    expect(input?.safeParse({ body: { name: 'n', a: 1 } }).success).toBe(false);
  });

  it('intersect a narrowed property with the base (tighter bound wins)', () => {
    const input = ops['createThing']?.input;
    expect(input?.safeParse({ body: { kind: 'A', name: 'toolong', a: 1 } }).success).toBe(false);
  });

  it('fall back to the base fields for an unknown discriminator in responses', () => {
    const output = ops['getThing']?.output;
    expect(output?.parse({ kind: 'A', name: 'n', a: 1, x: 1 })).toEqual({
      kind: 'A',
      name: 'n',
      a: 1,
    });
    expect(output?.parse({ kind: 'NEW', name: 'n', a: 1, filter: 'f' })).toEqual({
      kind: 'NEW',
      name: 'n',
    });
  });

  it('refuse an unconstrained request property that no variant narrows', () => {
    expect(() =>
      generate(doc(schemas, { '/v1/things': post('#/components/schemas/Base') })),
    ).toThrow(/VariantB\.filter: unconstrained request property/);
  });

  it('accept a variant shared by bases that select it by the same value', () => {
    const shared = {
      One: {
        type: 'object',
        discriminator: { propertyName: 'k', mapping: { X: '#/components/schemas/V' } },
        properties: { k: { type: 'string' } },
      },
      Two: {
        type: 'object',
        discriminator: { propertyName: 'k', mapping: { X: '#/components/schemas/V' } },
        properties: { k: { type: 'string' } },
      },
      V: {
        allOf: [
          { $ref: '#/components/schemas/One' },
          { $ref: '#/components/schemas/Two' },
          { type: 'object', properties: { v: { type: 'string' } } },
        ],
      },
      Holder: {
        type: 'object',
        properties: {
          one: { $ref: '#/components/schemas/One' },
          two: { $ref: '#/components/schemas/Two' },
        },
      },
    };
    const op = load(generate(doc(shared, { '/v1/h': post('#/components/schemas/Holder') })))[
      'createThing'
    ];
    expect(op?.input.safeParse({ body: { one: { k: 'X', v: 's' } } }).success).toBe(true);
    const disagree = {
      ...shared,
      Two: {
        ...shared.Two,
        discriminator: { propertyName: 'k', mapping: { Y: '#/components/schemas/V' } },
      },
    };
    expect(() => generate(doc(disagree, { '/v1/h': post('#/components/schemas/Holder') }))).toThrow(
      /select it by different values/,
    );
  });
});

describe('the translator fails loudly', () => {
  const object = (properties: Record<string, unknown>): Record<string, unknown> => ({
    T: { type: 'object', properties },
  });
  it.each([
    ['an unsupported keyword', object({ s: { type: 'string', pattern: '^a' } }), /"pattern"/],
    ['oneOf', object({ s: { oneOf: [{ type: 'string' }] } }), /"oneOf"/],
    [
      'additionalProperties',
      object({ m: { type: 'object', additionalProperties: {} } }),
      /additionalProperties/,
    ],
    ['an unknown string format', object({ s: { type: 'string', format: 'ipv4' } }), /format/],
    ['an unknown integer format', object({ n: { type: 'integer', format: 'int8' } }), /format/],
    [
      'recursion',
      { T: { type: 'object', properties: { child: { $ref: '#/components/schemas/T' } } } },
      /recursive/,
    ],
    [
      'conflicting allOf members',
      {
        T: {
          allOf: [
            { type: 'object', properties: { a: { type: 'string' } } },
            { type: 'object', properties: { a: { type: 'integer' } } },
          ],
        },
      },
      /conflicting types/,
    ],
    [
      'a required property without a definition',
      { T: { type: 'object', required: ['x'] } },
      /required property x/,
    ],
  ])('on %s', (_name, schemas, pattern) => {
    expect(() => generate(doc(schemas, { '/v1/t': post('#/components/schemas/T') }))).toThrow(
      pattern,
    );
  });

  it('on header parameters, non-JSON bodies and several success responses', () => {
    const T = { T: { type: 'object', properties: {} } };
    expect(() =>
      generate(
        doc(T, {
          '/v1/t': get('#/components/schemas/T', {
            parameters: [{ in: 'header', name: 'X-Thing', schema: { type: 'string' } }],
          }),
        }),
      ),
    ).toThrow(/header are not supported/);
    expect(() =>
      generate(
        doc(T, {
          '/v1/t': post('#/components/schemas/T', {
            requestBody: { content: { 'text/plain': { schema: { type: 'string' } } } },
          }),
        }),
      ),
    ).toThrow(/application\/json request bodies/);
    expect(() =>
      generate(
        doc(T, {
          '/v1/t': get('#/components/schemas/T', {
            responses: {
              '200': { content: { 'application/json': { schema: { type: 'string' } } } },
              '202': { content: { 'application/json': { schema: { type: 'string' } } } },
            },
          }),
        }),
      ),
    ).toThrow(/exactly one documented 2xx/);
  });
});

describe('reviewed parameter omissions', () => {
  const T = { T: { type: 'object', properties: { a: { type: 'string' } } } };
  const withFilter = doc(T, {
    '/v1/t': get('#/components/schemas/T', {
      parameters: [{ in: 'query', name: 'filter', schema: { $ref: '#/components/schemas/T' } }],
    }),
  });

  it('leave the parameter out and record the reason in the output', () => {
    const source = generate(withFilter, {
      omittedParameters: { getThing: { filter: 'ambiguous in the contract' } },
    });
    expect(source).toContain('Query parameter "filter" omitted: ambiguous in the contract');
    const op = load(source)['getThing'];
    expect(op?.queryParameters).toEqual([]);
    expect(op?.input.safeParse({ filter: 'x' }).success).toBe(false);
  });

  it('fail when the omitted parameter no longer exists', () => {
    expect(() =>
      generate(doc(T, { '/v1/t': get('#/components/schemas/T') }), {
        omittedParameters: { getThing: { filter: 'gone' } },
      }),
    ).toThrow(/must exist and be optional/);
  });
});

describe('identifiers', () => {
  it('are PascalCase and disambiguated deterministically', () => {
    expect(identifierFor('Site overview page')).toBe('SiteOverviewPage');
    const source = generate(
      doc(
        {
          'IP Address selector': { type: 'object', properties: { a: { type: 'string' } } },
          'IP address selector': { type: 'object', properties: { b: { type: 'string' } } },
          Holder: {
            type: 'object',
            properties: {
              x: { $ref: '#/components/schemas/IP Address selector' },
              y: { $ref: '#/components/schemas/IP address selector' },
            },
          },
        },
        { '/v1/h': get('#/components/schemas/Holder') },
      ),
    );
    expect(source).toContain('const IPAddressSelectorOut =');
    expect(source).toContain('const IPAddressSelector2Out =');
  });
});
