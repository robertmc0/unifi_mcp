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
  operationName,
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
  transport: string;
  queryParameters: readonly string[];
  hasBody: boolean;
  responseType: string;
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

  it('refuse a documented variant that misses its own schema, rather than reduce it to the base', () => {
    const output = ops['getThing']?.output;
    // `A` requires `a`: the base branch must not accept it and drop A's fields.
    expect(output?.safeParse({ kind: 'A', name: 'n' }).success).toBe(false);
    expect(output?.safeParse({ kind: 'A', name: 'n', a: 'not a number' }).success).toBe(false);
    expect(output?.safeParse({ kind: 'B', name: 'n', a: 1 }).success).toBe(false);
    expect(output?.safeParse({ kind: 'NEW', name: 'n' }).success).toBe(true);
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
    ['an unsupported keyword', object({ s: { type: 'string', not: { const: 'a' } } }), /"not"/],
    [
      'an open object without properties',
      object({ m: { type: 'object', additionalProperties: {} } }),
      /open object without properties/,
    ],
    [
      'an open object (additionalProperties: true)',
      object({ m: { type: 'object', additionalProperties: true } }),
      /open object without properties/,
    ],
    [
      'a typed map in a request',
      object({ m: { type: 'object', additionalProperties: { type: 'string' } } }),
      /typed maps in requests/,
    ],
    [
      'oneOf next to other structure',
      object({ u: { type: 'object', properties: {}, oneOf: [{ type: 'string' }] } }),
      /oneOf\/anyOf next to/,
    ],
    ['an object const', object({ c: { const: { a: 1 } } }), /unsupported const/],
    [
      'a type list other than [T, "null"]',
      object({ t: { type: ['string', 'number'] } }),
      /unsupported type/,
    ],
    [
      'an invalid pattern',
      object({ s: { type: 'string', pattern: '(' } }),
      /not a valid regular expression/,
    ],
    [
      'a discriminator that maps to a non-member',
      {
        A: { type: 'object', properties: { kind: { const: 'a' } } },
        T: {
          type: 'object',
          properties: {
            u: {
              oneOf: [{ $ref: '#/components/schemas/A' }],
              discriminator: { propertyName: 'kind', mapping: { b: '#/components/schemas/B' } },
            },
          },
        },
      },
      /not a member/,
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
    const media = (type: string, schema: unknown) =>
      generate(
        doc(T, {
          '/v1/t': get('#/components/schemas/T', {
            responses: { '200': { content: { [type]: { schema } } } },
          }),
        }),
      );
    expect(() => media('text/plain', { type: 'string' })).toThrow(/unsupported response media/);
    expect(() => media('image/jpeg', { type: 'object' })).toThrow(/binary string/);
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

describe('reviewed response properties that may be absent', () => {
  const mode = {
    type: 'object',
    properties: { status: { type: 'string' }, profileId: { type: ['string', 'null'] } },
    required: ['status', 'profileId'],
  };
  const reviewed = { Mode: { profileId: 'a console was observed to leave it out' } };
  const both = doc({ Mode: mode }, { '/v1/mode': post('#/components/schemas/Mode') });

  it('are optional in responses only, and the reason is recorded', () => {
    const source = generate(both, { optionalResponseProperties: reviewed });
    expect(source).toContain(
      'Response property "Mode.profileId" accepted when absent: a console was observed',
    );
    const op = load(source)['createThing'];
    expect(op?.output.safeParse({ status: 'on' }).success).toBe(true);
    expect(op?.output.safeParse({ status: 'on', profileId: null }).success).toBe(true);
    expect(op?.output.safeParse({ status: 'on', profileId: 7 }).success).toBe(false);
    expect(op?.output.safeParse({ profileId: 'p' }).success).toBe(false);
    // The request schema keeps the contract: the property is still required.
    expect(op?.input.safeParse({ body: { status: 'on' } }).success).toBe(false);
    expect(load(generate(both))['createThing']?.output.safeParse({ status: 'on' }).success).toBe(
      false,
    );
  });

  it('fail when the property is gone, no longer required, or never in a response', () => {
    const generateWith = (
      document: Doc,
      options: GeneratorOptions['optionalResponseProperties'] = reviewed,
    ) => generate(document, { optionalResponseProperties: options });
    expect(() => generateWith(both, { Mode: { gone: 'x' } })).toThrow(
      /Mode\.gone: a property accepted when absent must exist in a response schema/,
    );
    expect(() => generateWith(both, { Other: { profileId: 'x' } })).toThrow(/must exist/);
    const optional = doc(
      { Mode: { ...mode, required: ['status'] } },
      { '/v1/mode': get('#/components/schemas/Mode') },
    );
    expect(() => generateWith(optional)).toThrow(/Mode\.profileId: is no longer required/);
    const requestOnly = doc(
      { Mode: mode, Ok: { type: 'object', properties: { ok: { type: 'boolean' } } } },
      {
        '/v1/mode': {
          post: {
            operationId: 'setMode',
            requestBody: {
              required: true,
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Mode' } } },
            },
            responses: {
              '200': {
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Ok' } } },
              },
            },
          },
        },
      },
    );
    expect(() => generateWith(requestOnly)).toThrow(/must exist in a response schema/);
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

describe('contracts without operationIds (naming: path)', () => {
  const bare = (op: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(op).filter(([name]) => name !== 'operationId'));
  const T = { T: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } };
  const document = doc(T, {
    '/v1/things/{id}': {
      get: bare(get('#/components/schemas/T')['get'] as Record<string, unknown>),
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
    },
    '/v1/subscribe/things': {
      get: bare(get('#/components/schemas/T')['get'] as Record<string, unknown>),
    },
    '/v1/files/{fileType}': {
      post: {
        parameters: [{ in: 'path', name: 'fileType', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: { 'multipart/form-data': { schema: { type: 'string', format: 'binary' } } },
        },
        responses: {
          '200': {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/T' } } },
          },
        },
      },
    },
    '/v1/things/{id}/picture': {
      get: {
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { content: { 'image/jpeg': { schema: { type: 'string', format: 'binary' } } } },
        },
      },
    },
  });
  const options = {
    naming: 'path' as const,
    omittedOperations: { 'POST /v1/files/{fileType}': 'the form field is not documented' },
  };

  it('derive names from method and path, and key OPERATIONS by the inventory key', () => {
    expect(operationName('GET', '/v1/cameras/{id}/snapshot')).toBe('getV1CamerasByIdSnapshot');
    expect(operationName('PATCH', '/v1/arm-profiles/settings')).toBe('patchV1ArmProfilesSettings');
    const source = generate(document, options);
    const ops = load(source);
    expect(Object.keys(ops).sort()).toEqual([
      'OPERATIONS',
      'getV1SubscribeThings',
      'getV1ThingsById',
      'getV1ThingsByIdPicture',
    ]);
    expect(source).toContain(`'GET /v1/things/{id}': getV1ThingsById`.replace(/'/g, '"'));
  });

  it('mark WebSocket subscriptions and record the response type', () => {
    const ops = load(generate(document, options));
    expect(ops['getV1SubscribeThings']).toMatchObject({
      transport: 'websocket',
      responseType: 'json',
    });
    expect(ops['getV1ThingsById']).toMatchObject({ transport: 'http', responseType: 'json' });
  });

  it('return a documented binary response as bytes', () => {
    const picture = load(generate(document, options))['getV1ThingsByIdPicture'];
    expect(picture?.responseType).toBe('image/jpeg');
    expect(picture?.output.safeParse(new Uint8Array([0xff, 0xd8])).success).toBe(true);
    expect(picture?.output.safeParse('not bytes').success).toBe(false);
  });

  it('leave a reviewed omission out, say why, and fail when it no longer exists', () => {
    const source = generate(document, options);
    expect(source).toContain('// Operation "POST /v1/files/{fileType}" omitted: the form field');
    expect(() => generate(document, { naming: 'path' })).toThrow(/multipart|request bodies/);
    expect(() =>
      generate(document, {
        ...options,
        omittedOperations: { ...options.omittedOperations, 'DELETE /v1/gone': 'x' },
      }),
    ).toThrow(/omitted operation must exist/);
  });

  it('refuse two operations that would get the same name', () => {
    const twins = doc(T, {
      '/v1/a-b': bare(get('#/components/schemas/T')['get'] as Record<string, unknown>),
      '/v1/a_b': bare(get('#/components/schemas/T')['get'] as Record<string, unknown>),
    });
    const asGet = (d: Doc) => {
      const paths = d['paths'] as Record<string, unknown>;
      for (const key of Object.keys(paths)) paths[key] = { get: paths[key] };
      return d;
    };
    expect(() => generate(asGet(twins), { naming: 'path' })).toThrow(/two operations are named/);
  });
});

describe('JSON Schema constructs of the Protect contract', () => {
  const ops = (schemas: Record<string, unknown>) =>
    load(generate(doc(schemas, { '/v1/t': post('#/components/schemas/T') })))['createThing'];
  const accepts = (schema: z.ZodType | undefined, value: unknown) =>
    schema?.safeParse(value).success;
  const body = (op: GeneratedOperation | undefined) =>
    (op?.input as z.ZodObject | undefined)?.shape['body'] as z.ZodType | undefined;
  const object = (properties: Record<string, unknown>, required: string[] = []) => ({
    T: { type: 'object', properties, required },
  });

  it('nullable types: [T, "null"], anyOf with null, and null itself', () => {
    const op = ops(
      object({
        a: { type: ['string', 'null'] },
        b: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
        c: { type: 'null' },
      }),
    );
    for (const schema of [body(op), op?.output]) {
      expect(accepts(schema, { a: null, b: null, c: null })).toBe(true);
      expect(accepts(schema, { a: 'x', b: 1 })).toBe(true);
      expect(accepts(schema, { c: 'x' })).toBe(false);
    }
    expect(accepts(body(op), { b: 'x' })).toBe(false);
  });

  it('const is a literal in both flavours; a union of string consts is an enum', () => {
    const op = ops(
      object({
        k: { type: 'string', const: 'fixed' },
        e: {
          anyOf: [
            { type: 'string', const: 'on' },
            { type: 'string', const: 'off' },
          ],
        },
      }),
    );
    expect(accepts(body(op), { k: 'fixed', e: 'on' })).toBe(true);
    expect(accepts(body(op), { k: 'other' })).toBe(false);
    expect(accepts(body(op), { e: 'dim' })).toBe(false);
    expect(accepts(op?.output, { k: 'other' })).toBe(false);
    expect(accepts(op?.output, { e: 'dim' })).toBe(true); // like enums: new values pass
  });

  it('oneOf unions accept exactly the documented members', () => {
    const op = ops(
      object({
        v: {
          oneOf: [
            { type: 'string', maxLength: 3 },
            { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] },
          ],
        },
      }),
    );
    expect(accepts(body(op), { v: 'abc' })).toBe(true);
    expect(accepts(body(op), { v: { n: 1 } })).toBe(true);
    expect(accepts(body(op), { v: 'abcd' })).toBe(false);
    expect(accepts(body(op), { v: { n: 1, extra: true } })).toBe(false);
    expect(op?.output.parse({ v: { n: 1, extra: true } })).toEqual({ v: { n: 1 } });
  });

  const variants = {
    Add: {
      type: 'object',
      properties: { type: { type: 'string', const: 'add' }, item: { type: 'string' } },
      required: ['type', 'item'],
    },
    Remove: {
      type: 'object',
      properties: { type: { type: 'string', const: 'remove' }, id: { type: 'integer' } },
      required: ['type', 'id'],
    },
  };

  it('inline discriminated oneOf: an unknown value keeps only the discriminator in responses', () => {
    const op = ops({
      ...variants,
      T: {
        type: 'object',
        properties: {
          m: {
            oneOf: [{ $ref: '#/components/schemas/Add' }, { $ref: '#/components/schemas/Remove' }],
            discriminator: {
              propertyName: 'type',
              mapping: { add: '#/components/schemas/Add', remove: '#/components/schemas/Remove' },
            },
          },
        },
      },
    });
    expect(accepts(body(op), { m: { type: 'add', item: 'x' } })).toBe(true);
    expect(accepts(body(op), { m: { type: 'move', item: 'x' } })).toBe(false);
    expect(op?.output.parse({ m: { type: 'add', item: 'x', secret: 's' } })).toEqual({
      m: { type: 'add', item: 'x' },
    });
    expect(op?.output.parse({ m: { type: 'move', secret: 's' } })).toEqual({
      m: { type: 'move' },
    });
    // A documented value never falls back to the discriminator-only branch.
    expect(accepts(op?.output, { m: { type: 'add' } })).toBe(false);
    expect(accepts(op?.output, { m: { type: 'remove', id: 'x' } })).toBe(false);
  });

  it('component oneOf with a discriminator mapping (no allOf inheritance)', () => {
    const op = ops({
      ...variants,
      T: {
        oneOf: [{ $ref: '#/components/schemas/Add' }, { $ref: '#/components/schemas/Remove' }],
        discriminator: {
          propertyName: 'type',
          mapping: { add: '#/components/schemas/Add', remove: '#/components/schemas/Remove' },
        },
      },
    });
    expect(accepts(body(op), { type: 'remove', id: 1 })).toBe(true);
    expect(accepts(body(op), { type: 'remove', item: 'x' })).toBe(false);
    expect(op?.output.parse({ type: 'later', extra: 1 })).toEqual({ type: 'later' });
    expect(accepts(op?.output, { type: 'remove', item: 'x' })).toBe(false);
  });

  it('pattern, exclusiveMinimum and minProperties bind requests only', () => {
    const op = ops({
      T: {
        type: 'object',
        minProperties: 1,
        properties: {
          pin: { type: 'string', pattern: '^\\d{4,6}$' },
          gap: { type: 'number', exclusiveMinimum: 0 },
        },
      },
    });
    expect(accepts(body(op), { pin: '1234', gap: 0.5 })).toBe(true);
    expect(accepts(body(op), { pin: '12a4' })).toBe(false);
    expect(accepts(body(op), { gap: 0 })).toBe(false);
    expect(accepts(body(op), {})).toBe(false);
    expect(accepts(op?.output, { pin: '12a4', gap: 0 })).toBe(true);
    expect(accepts(op?.output, {})).toBe(true);
  });

  it('typed maps in responses validate values and strip their undocumented fields', () => {
    const op = load(
      generate(
        doc(
          {
            T: {
              type: 'object',
              properties: {
                pins: {
                  type: 'object',
                  additionalProperties: {
                    type: 'object',
                    properties: { state: { type: 'string', enum: ['on', 'off'] } },
                    required: ['state'],
                  },
                },
              },
            },
          },
          { '/v1/t': get('#/components/schemas/T') },
        ),
      ),
    )['getThing'];
    expect(op?.output.parse({ pins: { '1': { state: 'on', x: 1 } } })).toEqual({
      pins: { '1': { state: 'on' } },
    });
    expect(accepts(op?.output, { pins: { '1': { x: 1 } } })).toBe(false);
  });

  it('format uri is a URL in requests and a string in responses', () => {
    const op = ops(object({ u: { type: 'string', format: 'uri' } }));
    expect(accepts(body(op), { u: 'rtsps://h.invalid:7441/x' })).toBe(true);
    expect(accepts(body(op), { u: 'not a url' })).toBe(false);
    expect(accepts(op?.output, { u: 'not a url' })).toBe(true);
  });

  it('allOf with one primitive reference and constraints narrows it; typeless string enums', () => {
    const op = ops({
      Volume: { type: 'number', minimum: 0, maximum: 100 },
      T: {
        type: 'object',
        properties: {
          v: { allOf: [{ $ref: '#/components/schemas/Volume' }], minimum: 1 },
          s: { enum: ['a', 'b'] },
        },
      },
    });
    expect(accepts(body(op), { v: 1, s: 'a' })).toBe(true);
    expect(accepts(body(op), { v: 0 })).toBe(false);
    expect(accepts(body(op), { v: 101 })).toBe(false);
    expect(accepts(body(op), { s: 'c' })).toBe(false);
  });
});

describe('hand transcriptions of a PDF contract (ADR 0022)', () => {
  const cite = (page: number) => ({ page });
  const document = doc(
    {
      Plate: {
        type: 'object',
        properties: {
          id: { type: 'string', 'x-pdf': cite(3) },
          added: { type: 'string', 'x-pdf': cite(3), 'x-minimum-version': '3.3.10' },
        },
        required: ['id'],
      },
      User: {
        type: 'object',
        properties: {
          id: { type: 'string', 'x-pdf': { page: 2, row: 'Id' } },
          email: { type: 'string', 'x-pdf': cite(2), 'x-minimum-version': '1.22.16' },
          plates: {
            type: 'array',
            items: { $ref: '#/components/schemas/Plate' },
            'x-pdf': { page: 3, parent: true },
          },
        },
        required: ['id'],
      },
    },
    {
      '/api/users/{id}': {
        put: {
          'x-note': 'our own words about a transcription choice',
          parameters: [
            {
              in: 'path',
              name: 'id',
              required: true,
              schema: { type: 'string' },
              'x-pdf': cite(4),
            },
            {
              in: 'query',
              name: 'expand[]',
              schema: { type: 'string' },
              'x-pdf': cite(4),
              'x-minimum-version': '1.22.16',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    first_name: { type: 'string', 'x-pdf': cite(4) },
                    plates: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/Plate' },
                      'x-pdf': { page: 4, parent: true },
                    },
                  },
                  required: ['first_name'],
                },
              },
            },
          },
          responses: {
            '200': {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { data: { $ref: '#/components/schemas/User' } },
                    required: ['data'],
                  },
                },
              },
            },
          },
        },
      },
    },
  );
  const options = { naming: 'path' as const, transcription: true };

  it('are refused as vendor documents: the citation extensions are not vendor keywords', () => {
    expect(() => generate(document, { naming: 'path' })).toThrow(/unsupported keyword "x-pdf"/);
  });

  it('make cited response properties optional and nullable; the envelope keeps data required', () => {
    const op = load(generate(document, options))['putApiUsersById'];
    expect(op?.output.safeParse({ data: { id: null, email: null, plates: null } }).success).toBe(
      true,
    );
    expect(op?.output.parse({ data: {} })).toEqual({ data: {} });
    expect(op?.output.safeParse({}).success).toBe(false);
    // Typed values are still enforced, and undocumented fields still stripped.
    expect(op?.output.safeParse({ data: { id: 7 } }).success).toBe(false);
    expect(op?.output.parse({ data: { id: 'u', secret: 'x' } })).toEqual({ data: { id: 'u' } });
  });

  it('keep requests strict: required as transcribed, no null, no unknown fields', () => {
    const op = load(generate(document, options))['putApiUsersById'];
    const ok = { id: 'u', body: { first_name: 'A', plates: [{ id: 'p' }] } };
    expect(op?.input.safeParse(ok).success).toBe(true);
    expect(op?.input.safeParse({ id: 'u', body: {} }).success).toBe(false);
    expect(op?.input.safeParse({ id: 'u', body: { first_name: null } }).success).toBe(false);
    expect(op?.input.safeParse({ id: 'u', body: { first_name: 'A', pin_code: '1' } }).success).toBe(
      false,
    );
    expect(op?.input.safeParse({ id: 'u', body: { first_name: 'A', plates: [{}] } }).success).toBe(
      false,
    );
  });

  it('list request fields that need a later version, through references and arrays', () => {
    const source = generate(document, options);
    const op = load(source)['putApiUsersById'] as unknown as {
      versionedFields: readonly { field: string; minimum: string }[];
    };
    expect(op.versionedFields).toEqual([
      { field: 'body.plates[].added', minimum: '3.3.10' },
      { field: 'expand[]', minimum: '1.22.16' },
    ]);
    expect(source).toContain('hand transcription of a PDF contract, not a vendor');
    expect(generate(doc({}, {}), { naming: 'path' })).not.toContain('versionedFields');
  });

  it('copy no annotations into the generated code', () => {
    const source = generate(document, options);
    expect(source).not.toMatch(/x-pdf|x-note|our own words|"page"/);
  });
});
