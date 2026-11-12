/**
 * The reviewed Protect event streams (ADR 0020 §6) against the contract: every documented
 * event type and device kind is reviewed, equivalents are registered reads, the reordering
 * of the device message forms is justified by the vendor documents, and no generated
 * union lets an earlier branch swallow a later documented one.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEVICE_KINDS,
  DEVICE_MESSAGE,
  EVENT_TYPES,
  PROTECT_EVENT_STREAMS,
  PROTECT_READS,
  subscribeDevices,
  subscribeEvents,
} from '@unifi-local-mcp/unifi-protect';
import { describe, expect, it } from 'vitest';
import type * as z from 'zod';
import * as official from '../../packages/unifi-protect/src/generated/protect-7.3.74.ts';
import * as newest from '../../packages/unifi-protect/src/generated/protect-7.4.96.ts';
import { branches, sample } from '../fixtures/zod-samples.ts';

const ROOT = join(import.meta.dirname, '../..');
type Schemas = Record<string, Record<string, unknown>>;

async function vendor(revision: string): Promise<Schemas> {
  const doc = JSON.parse(
    await readFile(join(ROOT, 'api-specs/protect', revision, 'vendor/openapi.json'), 'utf8'),
  ) as { components: { schemas: Schemas } };
  return doc.components.schemas;
}

function mappingKeys(schemas: Schemas, name: string): string[] {
  const discriminator = schemas[name]?.['discriminator'] as { mapping: Record<string, string> };
  return Object.keys(discriminator.mapping).sort();
}

interface Def {
  type: string;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  innerType?: z.ZodType;
  valueType?: z.ZodType;
  options?: z.ZodType[];
  in?: z.ZodType;
  out?: z.ZodType;
}
const def = (schema: z.ZodType): Def => (schema as unknown as { _zod: { def: Def } })._zod.def;

/** Every union reachable from a schema, with a readable path. */
function unions(schema: z.ZodType, path: string, seen: Set<unknown>, out: [string, z.ZodType][]) {
  if (seen.has(schema)) return;
  seen.add(schema);
  const d = def(schema);
  if (d.type === 'union') out.push([path, schema]);
  for (const [key, child] of Object.entries(d.shape ?? {}))
    unions(child, `${path}.${key}`, seen, out);
  for (const child of [d.element, d.innerType, d.valueType, d.in, d.out]) {
    if (child !== undefined) unions(child, path, seen, out);
  }
  for (const [i, child] of (d.options ?? []).entries())
    unions(child, `${path}|${String(i)}`, seen, out);
}

/**
 * Pairs (earlier, later) of union options where the earlier option accepts a documented
 * value of the later one but returns less of it: the later branch can never be reached
 * with that value (zod returns the first branch that matches).
 */
function shadowed(union: z.ZodType): { pair: string; lost: unknown }[] {
  const options = def(union).options ?? [];
  const found: { pair: string; lost: unknown }[] = [];
  for (let later = 1; later < options.length; later++) {
    const laterOption = options[later] as z.ZodType;
    const variants = Math.min(branches(laterOption), 60);
    for (let variant = 0; variant < variants; variant++) {
      const value = sample(laterOption, { variant });
      const own = laterOption.safeParse(value);
      if (!own.success) continue;
      for (let earlier = 0; earlier < later; earlier++) {
        const first = (options[earlier] as z.ZodType).safeParse(value);
        if (first.success && JSON.stringify(first.data) !== JSON.stringify(own.data)) {
          found.push({ pair: `${String(earlier)}<${String(later)}`, lost: own.data });
        }
      }
    }
  }
  return found;
}

function shadows(union: z.ZodType): string[] {
  return [...new Set(shadowed(union).map((s) => s.pair))];
}

describe('Protect event streams', () => {
  it('are the two documented 7.3.74 subscriptions, reviewed as low-risk reads', () => {
    expect(PROTECT_EVENT_STREAMS.map((s) => [s.operationId, s.pathTemplate, s.permission])).toEqual(
      [
        ['protect.events.subscribe', '/v1/subscribe/events', 'protect.events.read'],
        ['protect.devices.subscribe', '/v1/subscribe/devices', 'protect.devices.read'],
      ],
    );
    for (const stream of PROTECT_EVENT_STREAMS) {
      expect(stream).toMatchObject({
        moduleId: 'protect',
        effect: 'read',
        risk: 'low',
        approvalRequired: false,
        siteScoped: false,
        sensitivityTags: [],
        contractRevision: '7.3.74',
        apiVersionRange: '>=7.3.74 <8',
      });
    }
  });

  it('review every documented event type and device kind of both revisions', async () => {
    for (const revision of ['7.3.74', '7.4.96']) {
      const schemas = await vendor(revision);
      expect(Object.keys(EVENT_TYPES).sort(), revision).toEqual(mappingKeys(schemas, 'event'));
      expect(Object.keys(DEVICE_KINDS).sort(), revision).toEqual(mappingKeys(schemas, 'device'));
    }
  });

  it('require identity grants exactly for the events that name a person', () => {
    const tagged = Object.entries(EVENT_TYPES)
      .filter(([, tags]) => tags.length > 0)
      .map(([type, tags]) => [type, [...tags].sort()]);
    expect(tagged).toEqual([
      ['nfcCardScanned', ['biometric_or_access_identity', 'personal_identifier']],
      ['fingerprintIdentified', ['biometric_or_access_identity', 'personal_identifier']],
    ]);
  });

  it('map each device kind to the registered read of that kind, or to none', () => {
    const reads = new Set(PROTECT_READS);
    for (const [kind, equivalent] of Object.entries(DEVICE_KINDS)) {
      if (equivalent === null) {
        expect(['aiport', 'aiprocessor'], kind).toContain(kind);
        continue;
      }
      expect(reads.has(equivalent as never), kind).toBe(true);
      expect(equivalent.effect, kind).toBe('read');
    }
    expect(DEVICE_KINDS['fob']?.sensitivityTags).toEqual(['location']);
  });

  it('classify only reviewed kinds and actions', () => {
    expect(subscribeEvents.classify({ type: 'add', item: { type: 'ring' } } as never)).toEqual({
      kind: 'ring',
      sensitivityTags: [],
    });
    expect(
      subscribeEvents.classify({ type: 'remove', item: { type: 'ring' } } as never),
    ).toBeUndefined();
    expect(
      subscribeEvents.classify({ type: 'add', item: { type: 'newKind' } } as never),
    ).toBeUndefined();
    expect(
      subscribeEvents.classify({ type: 'add', item: { type: 'constructor' } } as never),
    ).toBeUndefined();
    expect(subscribeEvents.classify({ type: 'add' })).toBeUndefined();
    expect(
      subscribeDevices.classify({ type: 'remove', item: { modelKey: 'camera' } } as never),
    ).toMatchObject({
      kind: 'camera_remove',
    });
    expect(
      subscribeDevices.classify({ type: 'add', item: { modelKey: 'aiport' } } as never),
    ).toBeUndefined();
    expect(
      subscribeDevices.classify({ type: 'add', item: { modelKey: 'toString' } } as never),
    ).toBeUndefined();
  });

  it('try the bulk device forms first, which the contract makes a superset of the single forms', async () => {
    for (const revision of ['7.3.74', '7.4.96']) {
      const schemas = await vendor(revision);
      const resolve = (node: Record<string, unknown>): Record<string, unknown> => {
        let current = node;
        while (typeof current['$ref'] === 'string') {
          current = schemas[current['$ref'].split('/').at(-1) ?? ''] ?? {};
        }
        return current;
      };
      const byKind = (name: string) =>
        new Map(
          (schemas[name]?.['oneOf'] as Record<string, unknown>[]).map((member) => {
            const resolved = resolve(member);
            const props = resolved['properties'] as Record<string, Record<string, unknown>>;
            return [resolve(props['modelKey'] ?? {})['const'] as string, resolved];
          }),
        );
      for (const [single, bulk] of [
        ['device', 'deviceBulk'],
        ['devicePartialWithReference', 'deviceBulkPartialWithReference'],
        ['deviceReference', 'deviceBulkReference'],
      ] as const) {
        const singles = byKind(single);
        const bulks = byKind(bulk);
        expect([...bulks.keys()].sort(), `${revision} ${bulk}`).toEqual([...singles.keys()].sort());
        for (const [kind, form] of singles) {
          const other = bulks.get(kind) ?? {};
          const props = form['properties'] as Record<string, unknown>;
          const otherProps = other['properties'] as Record<string, unknown>;
          expect(Object.keys(otherProps).sort(), `${revision} ${kind}`).toEqual(
            Object.keys(props).sort(),
          );
          expect(other['required'], `${revision} ${kind}`).toEqual(form['required']);
          for (const name of Object.keys(props).filter((n) => n !== 'id')) {
            expect(otherProps[name], `${revision} ${kind}.${name}`).toEqual(props[name]);
          }
        }
      }
    }
  });

  it('keep every field of single and bulk device messages', () => {
    const single = { type: 'update', item: { id: 'c1', modelKey: 'camera', name: 'Front' } };
    const bulk = { type: 'update', item: { id: ['c1', 'c2'], modelKey: 'camera', name: 'Front' } };
    expect(DEVICE_MESSAGE.parse(single)).toEqual(single);
    expect(DEVICE_MESSAGE.parse(bulk)).toEqual(bulk);
    // The generated order keeps only the bulk message's model key: its id and fields are lost.
    expect(official.OPERATIONS['GET /v1/subscribe/devices'].output.parse(bulk)).toEqual({
      type: 'update',
      item: { modelKey: 'camera' },
    });
  });

  it('leave no generated union where an earlier branch swallows a later one, except the reordered device message', () => {
    const found: string[] = [];
    for (const [revision, operations] of [
      ['7.3.74', official.OPERATIONS],
      ['7.4.96', newest.OPERATIONS],
    ] as const) {
      const seen = new Set<unknown>();
      for (const [key, operation] of Object.entries(
        operations as Record<string, { output: z.ZodType }>,
      )) {
        const all: [string, z.ZodType][] = [];
        unions(operation.output, key, seen, all);
        for (const [path, union] of all) {
          for (const pair of shadows(union)) found.push(`${revision} ${path} ${pair}`);
        }
      }
    }
    expect(found).toEqual([
      '7.3.74 GET /v1/subscribe/devices 0<1',
      '7.4.96 GET /v1/subscribe/devices 0<1',
      // Not implemented (ADR 0020 §6); to be resolved before it is.
      '7.4.96 GET /v1/subscribe/updates 0<1',
      '7.4.96 GET /v1/subscribe/updates 0<2',
      '7.4.96 GET /v1/subscribe/updates 1<2',
    ]);
    expect(PROTECT_EVENT_STREAMS.map((s) => s.pathTemplate)).not.toContain('/v1/subscribe/updates');
    // In the reordered message, the only values the bulk forms take from the single forms
    // are the single forms' fallback for an undocumented device kind, which is never
    // delivered either way.
    const fixed: [string, z.ZodType][] = [];
    unions(DEVICE_MESSAGE, 'DEVICE_MESSAGE', new Set(), fixed);
    const lost = fixed.flatMap(([, union]) => shadowed(union));
    expect(lost.length).toBeGreaterThan(0);
    for (const { lost: single } of lost) {
      expect(subscribeDevices.classify(single as never), JSON.stringify(single)).toBeUndefined();
      const modelKey = (single as { item?: { modelKey?: unknown } }).item?.modelKey;
      expect(Object.keys(DEVICE_KINDS)).not.toContain(modelKey);
    }
  });
});
