/**
 * Checks of the hand transcription against its inventory and the PDF text (ADR 0022).
 * Synthetic pages, documents and inventory only: no vendor content.
 */
import { describe, expect, it } from 'vitest';
import type { InventoryOperation } from '../../../scripts/lib/api-specs.ts';
import {
  collectElements,
  detectTableRows,
  errorCodesIn,
  pdfProblems,
  structuralProblems,
} from '../../../scripts/lib/access-transcription.ts';

type Doc = Record<string, unknown>;

const CONTRACT = { name: 'reference.pdf', sha256: 'a'.repeat(64) };

const INVENTORY: InventoryOperation[] = [
  {
    key: 'PUT /api/things/{id}',
    method: 'PUT',
    path: '/api/things/{id}',
    vendorOperationId: null,
    category: 'Thing',
    summary: 'Update Thing',
    documentationUrl: null,
    vendorPermission: 'edit:thing',
    transport: 'http',
    sourceRef: 'PDF §3.3 p.2',
  },
  {
    key: 'GET /api/things',
    method: 'GET',
    path: '/api/things',
    vendorOperationId: null,
    category: 'Thing',
    summary: 'List Things',
    documentationUrl: null,
    vendorPermission: 'view:thing',
    transport: 'http',
    sourceRef: 'PDF §3.4 p.3',
  },
];

/** Page 1: the shared Thing table. Page 2: the update. Page 3: the list (pending). */
const PAGES = [
  [
    'ParameterTypeDescription',
    'IdStringIdentity ID of the thing.',
    'nameStringName of the thing.',
    'statusStringenum status {ACTIVE,DISABLED}',
    'parts[].idStringID of a part.',
    'CodeMessage',
    'CODE_PARAMS_INVALIDThe provided parameters are invalid.',
    'CODE_THING_BUSY',
  ],
  [
    '3.3 Update Thing',
    'Request URL: /api/things/:id',
    'Permission Key: edit:thing',
    'Method: PUT',
    'ParameterRequiredTypeDescription',
    'AuthorizationTStringToken required for authentication.',
    'idTString',
    'nameTStringName of the thing.',
    'colorFString',
    'Email of the thing. UniFi Access Requirement: 1.22.16 or later',
    '"updated_at": 1689150139,',
  ],
  [
    '3.4 List Things',
    'Request URL: /api/things',
    'Permission Key: view:thing',
    'Method: GET',
    'page_numFStringCurrent page number.',
  ],
];

const THING = {
  type: 'object',
  properties: {
    id: { type: 'string', 'x-pdf': { page: 1, row: 'Id' } },
    name: { type: 'string', 'x-pdf': { page: 1 } },
    status: { type: 'string', enum: ['ACTIVE', 'DISABLED'], 'x-pdf': { page: 1 } },
    parts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string', 'x-pdf': { page: 1, row: 'parts[].id' } } },
      },
      'x-pdf': { page: 1, parent: true },
    },
    updated_at: { type: 'integer', 'x-pdf': { page: 2, sample: true } },
  },
};

function transcription(): Doc {
  return {
    openapi: '3.1.0',
    info: { title: 'Synthetic transcription', version: 'test' },
    'x-transcribed-from': { artifact: CONTRACT.name, sha256: CONTRACT.sha256 },
    'x-pdf-pages': [[1, 2]],
    'x-declined': [{ row: 'Authorization', reason: 'the transport sends it' }],
    'x-error-codes': ['CODE_PARAMS_INVALID', 'CODE_THING_BUSY'],
    'x-pending': ['GET /api/things'],
    paths: {
      '/api/things/{id}': {
        put: {
          parameters: [
            {
              in: 'path',
              name: 'id',
              required: true,
              schema: { type: 'string' },
              'x-pdf': { page: 2 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', 'x-pdf': { page: 2 } },
                    color: {
                      type: 'string',
                      'x-pdf': { page: 2 },
                      'x-minimum-version': '1.22.16',
                    },
                  },
                  required: ['name'],
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
                    properties: { data: { $ref: '#/components/schemas/Thing' } },
                    required: ['data'],
                  },
                },
              },
            },
          },
        },
      },
    },
    components: { schemas: { Thing: THING } },
  };
}

/** A deep copy changed by `edit`. */
function variant(edit: (doc: Doc) => void): Doc {
  const copy = structuredClone(transcription());
  edit(copy);
  return copy;
}

/** The PUT operation of a document, for edits. */
function put(doc: Doc): Doc {
  return ((doc['paths'] as Doc)['/api/things/{id}'] as Doc)['put'] as Doc;
}

function bodyProperties(doc: Doc): Doc {
  const body = put(doc)['requestBody'] as Doc;
  const media = (body['content'] as Doc)['application/json'] as Doc;
  return (media['schema'] as Doc)['properties'] as Doc;
}

function thingProperties(doc: Doc): Doc {
  return (((doc['components'] as Doc)['schemas'] as Doc)['Thing'] as Doc)['properties'] as Doc;
}

describe('table row detection', () => {
  it('finds label, required flag and type, including nested and unlabelled rows', () => {
    const rows = detectTableRows([
      [
        'first_nameTStringFirst name.',
        'statusStringenum status {A,B}',
        'resources[0].idFString',
        'Array[Object].user_idTStringIdentity ID.',
        'TArray[String]',
        'IdTString',
        'onboard_timeFInteger',
        'countInt',
        'expand[]Fstring',
        'bundlesArrayReserved for future use.',
        '-TArray of StringsList of plates',
        'idsT',
        'Array of',
        'Strings',
        'emailsF',
        'Object',
        '(Map)',
        'headersF',
        'Object<String,',
        'String>',
        'CODE_NAME_EXIST',
        'The name already',
        'String',
        'Interval between polls',
        'ParameterRequiredTypeDescription',
      ],
    ]);
    expect(rows.map((r) => [r.label, r.flag, r.type])).toEqual([
      ['first_name', 'T', 'String'],
      ['status', '', 'String'],
      ['resources[0].id', 'F', 'String'],
      ['Array[Object].user_id', 'T', 'String'],
      ['', 'T', 'Array[String]'],
      ['Id', 'T', 'String'],
      ['onboard_time', 'F', 'Integer'],
      ['count', '', 'Int'],
      ['expand[]', 'F', 'String'],
      ['bundles', '', 'Array'],
      ['', 'T', 'Array[String]'],
      ['ids', 'T', 'Array[String]'],
      ['emails', 'F', 'Map'],
      ['headers', 'F', 'Map'],
    ]);
  });

  it('finds error codes printed directly before their message', () => {
    expect(errorCodesIn(PAGES)).toEqual(['CODE_PARAMS_INVALID', 'CODE_THING_BUSY']);
  });
});

describe('structural checks (offline)', () => {
  it('accept a well-formed transcription', () => {
    expect(structuralProblems(transcription(), INVENTORY, CONTRACT)).toEqual([]);
  });

  it('require the operation set to equal the inventory, with pending ones listed', () => {
    const missing = variant((d) => {
      d['x-pending'] = [];
    });
    expect(structuralProblems(missing, INVENTORY, CONTRACT)).toContain(
      'GET /api/things: in operations.json but neither transcribed nor pending.',
    );
    const both = variant((d) => {
      d['x-pending'] = ['GET /api/things', 'PUT /api/things/{id}'];
    });
    expect(structuralProblems(both, INVENTORY, CONTRACT)).toContain(
      'PUT /api/things/{id}: both transcribed and pending.',
    );
    const unknown = variant((d) => {
      d['x-pending'] = ['GET /api/things', 'DELETE /api/gone'];
    });
    expect(structuralProblems(unknown, INVENTORY, CONTRACT)).toContain(
      'DELETE /api/gone: pending but not in operations.json.',
    );
  });

  it('require the transcription to name the pinned PDF', () => {
    const problems = structuralProblems(transcription(), INVENTORY, {
      ...CONTRACT,
      sha256: 'b'.repeat(64),
    });
    expect(problems.join('\n')).toMatch(/x-transcribed-from must name reference\.pdf/);
  });

  it('require a citation on every parameter and property, and refuse malformed ones', () => {
    const uncited = variant((d) => {
      delete (bodyProperties(d)['name'] as Doc)['x-pdf'];
    });
    expect(structuralProblems(uncited, INVENTORY, CONTRACT)).toContain(
      'PUT /api/things/{id} body.name: no x-pdf citation.',
    );
    const malformed = variant((d) => {
      (thingProperties(d)['name'] as Doc)['x-pdf'] = { page: 1, sample: true, row: 'x' };
    });
    expect(structuralProblems(malformed, INVENTORY, CONTRACT).join('\n')).toMatch(
      /components\.Thing\.name: malformed x-pdf/,
    );
    const misplaced = variant((d) => {
      const parts = thingProperties(d)['parts'] as Doc;
      (parts['items'] as Doc)['x-pdf'] = { page: 1 };
    });
    expect(structuralProblems(misplaced, INVENTORY, CONTRACT).join('\n')).toMatch(
      /x-pdf in a place that cannot cite/,
    );
  });

  it('refuse request fields taken from a sample, inline or through a component', () => {
    const inline = variant((d) => {
      (bodyProperties(d)['color'] as Doc)['x-pdf'] = { page: 2, sample: true };
    });
    expect(structuralProblems(inline, INVENTORY, CONTRACT)).toContain(
      'PUT /api/things/{id} body.color: a request field cannot come from a sample (ADR 0022 §3).',
    );
    const throughComponent = variant((d) => {
      bodyProperties(d)['thing'] = { $ref: '#/components/schemas/Thing', 'x-pdf': { page: 2 } };
    });
    expect(structuralProblems(throughComponent, INVENTORY, CONTRACT)).toContain(
      'components.Thing.updated_at: a request field cannot come from a sample (ADR 0022 §3).',
    );
  });

  it('require the response envelope {data, pagination?} with data required', () => {
    const notEnvelope = variant((d) => {
      const media = ((put(d)['responses'] as Doc)['200'] as Doc)['content'] as Doc;
      media['application/json'] = { schema: { $ref: '#/components/schemas/Thing' } };
    });
    expect(structuralProblems(notEnvelope, INVENTORY, CONTRACT)).toContain(
      'PUT /api/things/{id}: the response is not the envelope {data, pagination?, sampled siblings}.',
    );
    const envelopeOf = (d: Doc): Doc => {
      const content = ((put(d)['responses'] as Doc)['200'] as Doc)['content'] as Doc;
      return ((content['application/json'] as Doc)['schema'] as Doc)['properties'] as Doc;
    };
    const sibling = variant((d) => {
      envelopeOf(d)['total'] = { type: 'integer', 'x-pdf': { page: 2, sample: true } };
    });
    expect(structuralProblems(sibling, INVENTORY, CONTRACT)).toEqual([]);
    const uncited = variant((d) => {
      envelopeOf(d)['total'] = { type: 'integer' };
    });
    expect(structuralProblems(uncited, INVENTORY, CONTRACT).join('\n')).toMatch(
      /is not the envelope/,
    );
  });

  it('refuse vendor prose and citations outside the transcribed pages', () => {
    const prose = variant((d) => {
      (bodyProperties(d)['name'] as Doc)['description'] = 'copied vendor text';
    });
    expect(structuralProblems(prose, INVENTORY, CONTRACT).join('\n')).toMatch(
      /properties\.name\.description: vendor prose is not transcribed/,
    );
    const outside = variant((d) => {
      d['x-pdf-pages'] = [[1, 1]];
    });
    const outsideProblems = structuralProblems(outside, INVENTORY, CONTRACT);
    expect(outsideProblems).toContain(
      'PUT /api/things/{id} path id: cites p.2, outside x-pdf-pages.',
    );
    // A sample is not a row: it may sit on a page whose rows are not transcribed yet.
    expect(outsideProblems.join('\n')).not.toMatch(/updated_at/);
  });

  it('collect required flags and minimum versions with each element', () => {
    const { elements } = collectElements(transcription());
    const color = elements.find((e) => e.where === 'PUT /api/things/{id} body.color');
    expect(color).toMatchObject({ required: false, minimumVersion: '1.22.16', inRequest: true });
    const name = elements.find((e) => e.where === 'PUT /api/things/{id} body.name');
    expect(name).toMatchObject({ required: true });
  });
});

describe('checks against the PDF text', () => {
  it('pass for a transcription that matches its pages', () => {
    expect(pdfProblems(transcription(), PAGES, INVENTORY)).toEqual([]);
  });

  it('find a cited row that is missing, typed differently or flagged differently', () => {
    const missing = variant((d) => {
      (bodyProperties(d)['name'] as Doc)['x-pdf'] = { page: 1, row: 'title' };
    });
    expect(pdfProblems(missing, PAGES, INVENTORY)).toContain(
      'PUT /api/things/{id} body.name: no table row "title" on p.1.',
    );
    const typed = variant((d) => {
      (bodyProperties(d)['name'] as Doc)['type'] = 'integer';
    });
    expect(pdfProblems(typed, PAGES, INVENTORY).join('\n')).toMatch(
      /body\.name: row "name" on p\.2 has type String, transcribed as Integer\/Int/,
    );
    const flagged = variant((d) => {
      (((put(d)['requestBody'] as Doc)['content'] as Doc)['application/json'] as Doc)['schema'] = {
        type: 'object',
        properties: bodyProperties(d),
        required: ['name', 'color'],
      };
    });
    expect(pdfProblems(flagged, PAGES, INVENTORY).join('\n')).toMatch(
      /body\.color: row "color" on p\.2 is marked F, transcribed as required/,
    );
  });

  it('find samples, enum values, minimum versions and parents that are not on the page', () => {
    const doc = variant((d) => {
      (thingProperties(d)['updated_at'] as Doc)['x-pdf'] = { page: 1, sample: true };
      (thingProperties(d)['status'] as Doc)['enum'] = ['ACTIVE', 'ARCHIVED'];
      (bodyProperties(d)['color'] as Doc)['x-minimum-version'] = '3.3.10';
      (thingProperties(d)['parts'] as Doc)['x-pdf'] = { page: 2, parent: true };
    });
    const problems = pdfProblems(doc, PAGES, INVENTORY).join('\n');
    expect(problems).toMatch(/updated_at: "updated_at" is not in a sample on p\.1/);
    expect(problems).toMatch(/status: enum value "ARCHIVED" not on p\.1/);
    expect(problems).toMatch(
      /body\.color: minimum version 3\.3\.10 not on p\.2–3 or beside another "color" row/,
    );
    expect(problems).toMatch(/parts: no rows of fields under "parts" on p\.2 \(as parts\[\]\.…\)/);
  });

  it('check a version stated only in the change log on the page named as its source', () => {
    const sourced = (version: string) =>
      variant((d) => {
        Object.assign(bodyProperties(d)['color'] as Doc, {
          'x-minimum-version': version,
          'x-minimum-version-source': { page: 1 },
        });
      });
    const pages = [
      [...(PAGES[0] ?? []), 'v3.3.21 Supports custom color fields. (#3.3)'],
      ...PAGES.slice(1),
    ];
    expect(pdfProblems(sourced('3.3.21'), pages, INVENTORY)).toEqual([]);
    expect(pdfProblems(sourced('4.0.10'), pages, INVENTORY).join('\n')).toMatch(
      /body\.color: minimum version 4\.0\.10 not on its source p\.1–2/,
    );
    const malformed = variant((d) => {
      (bodyProperties(d)['name'] as Doc)['x-minimum-version-source'] = { page: 1 };
    });
    expect(structuralProblems(malformed, INVENTORY, CONTRACT).join('\n')).toMatch(
      /body\.name: malformed x-minimum-version-source/,
    );
  });

  it('find rows on transcribed pages that are neither transcribed nor declined', () => {
    const undeclared = variant((d) => {
      d['x-declined'] = [];
    });
    const problems = pdfProblems(undeclared, PAGES, INVENTORY);
    expect(problems).toContain(
      'p.2: table row "Authorization" (TString) is neither transcribed nor declined.',
    );
    // Page 3 is not transcribed yet: its rows are not reported.
    expect(problems.join('\n')).not.toMatch(/page_num/);
    const uncovered = variant((d) => {
      d['x-pdf-pages'] = [[1, 3]];
    });
    expect(pdfProblems(uncovered, PAGES, INVENTORY)).toContain(
      'p.3: table row "page_num" (FString) is neither transcribed nor declined.',
    );
  });

  it('find a declined row that matches nothing', () => {
    const stale = variant((d) => {
      d['x-declined'] = [
        { row: 'Authorization', reason: 'the transport sends it' },
        { row: 'gone', page: 2, reason: 'no longer printed' },
      ];
    });
    expect(pdfProblems(stale, PAGES, INVENTORY)).toContain(
      'x-declined: no table row "gone" on p.2.',
    );
  });

  it('check every inventory operation against its page, and the error codes both ways', () => {
    const inventory = INVENTORY.map((op) =>
      op.method === 'GET' ? { ...op, vendorPermission: 'edit:thing' } : op,
    );
    expect(pdfProblems(transcription(), PAGES, inventory)).toContain(
      'GET /api/things: no "Request URL: /api/things" with its method and permission on p.3–4.',
    );
    const codes = variant((d) => {
      d['x-error-codes'] = ['CODE_PARAMS_INVALID', 'CODE_NOT_PRINTED'];
    });
    const problems = pdfProblems(codes, PAGES, INVENTORY);
    expect(problems).toContain('CODE_THING_BUSY: printed in the PDF, not in x-error-codes.');
    expect(problems).toContain('CODE_NOT_PRINTED: in x-error-codes, not printed in the PDF.');
  });
});
