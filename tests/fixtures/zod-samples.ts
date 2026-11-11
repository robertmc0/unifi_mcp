/**
 * Synthetic values from zod schemas (tests only). Every documented field is filled, so
 * output checks see the largest shape an operation can return.
 *
 * - `variant` chooses union options and enum values; generating `branches(schema)`
 *   variants covers every option of every union and enum at least once.
 * - Credential fields get sentinel values from `secret`, and every object can carry an
 *   undocumented field, so a test can prove that neither reaches a client.
 * - Strings are `v:<path>`, so documented values are recognisable in results.
 */
import type * as z from 'zod';

interface Def {
  type: string;
  format?: string;
  shape?: Record<string, z.ZodType>;
  innerType?: z.ZodType;
  element?: z.ZodType;
  valueType?: z.ZodType;
  options?: z.ZodType[];
  in?: z.ZodType;
  values?: unknown[];
  entries?: Record<string, string>;
  checks?: {
    _zod: {
      def: {
        check: string;
        value?: number;
        minimum?: number;
        maximum?: number;
        format?: string;
        pattern?: RegExp;
      };
    };
  }[];
}

function def(schema: z.ZodType): Def {
  return (schema as unknown as { _zod: { def: Def } })._zod.def;
}

export interface SampleOptions {
  variant?: number;
  /** A sentinel for a credential field, or undefined. */
  secret?: (key: string) => string | undefined;
  /** An undocumented field added to every object. */
  extra?: readonly [string, unknown];
}

/** The largest option count of any union or enum: how many variants cover them all. */
export function branches(schema: z.ZodType, seen = new Set<unknown>()): number {
  if (seen.has(schema)) return 1;
  seen.add(schema);
  const d = def(schema);
  const children = [
    ...Object.values(d.shape ?? {}),
    ...(d.innerType === undefined ? [] : [d.innerType]),
    ...(d.element === undefined ? [] : [d.element]),
    ...(d.valueType === undefined ? [] : [d.valueType]),
    ...(d.in === undefined ? [] : [d.in]),
    ...(d.options ?? []),
  ];
  const own = d.options?.length ?? (d.entries === undefined ? 1 : Object.keys(d.entries).length);
  return Math.max(own, ...children.map((child) => branches(child, seen)));
}

let uuidCounter = 0;
function uuid(): string {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`;
}

/** Values tried, in order, for a string with a pattern (the first that matches wins). */
const PATTERNED = ['1234', 'NZD', 'ab12', 'camera', 'camera,light', '00000000-0000-4000-8000-0'];

function patterns(d: Def): RegExp[] {
  return (d.checks ?? []).flatMap((check) => {
    const c = check._zod.def;
    return c.check === 'string_format' && c.format === 'regex' && c.pattern !== undefined
      ? [c.pattern]
      : [];
  });
}

function bound(d: Def, kind: 'min' | 'max'): number | undefined {
  for (const check of d.checks ?? []) {
    const c = check._zod.def;
    if (kind === 'min' && (c.check === 'greater_than' || c.check === 'min_length')) {
      return c.value ?? c.minimum;
    }
    if (kind === 'max' && (c.check === 'less_than' || c.check === 'max_length')) {
      return c.value ?? c.maximum;
    }
  }
  return undefined;
}

export function sample(schema: z.ZodType, options: SampleOptions = {}, path = '$'): unknown {
  const variant = options.variant ?? 0;
  const d = def(schema);
  switch (d.type) {
    case 'object': {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(d.shape ?? {})) {
        const secret = options.secret?.(key);
        result[key] =
          secret !== undefined && def(unwrap(child)).type === 'string'
            ? secret
            : sample(child, options, `${path}.${key}`);
      }
      if (options.extra !== undefined) result[options.extra[0]] = options.extra[1];
      return result;
    }
    case 'string': {
      const regexes = patterns(d);
      if (regexes.length > 0) {
        const value = PATTERNED.find((candidate) => regexes.every((re) => re.test(candidate)));
        if (value === undefined) throw new Error(`No sample for the pattern at ${path}.`);
        return value;
      }
      // Identifiers look like the console's (UUIDs), so they can be used as targets.
      if (d.format === 'guid' || d.format === 'uuid' || /(^|\.)(id|\w+Id)$/.test(path)) {
        return uuid();
      }
      if (d.format === 'url') return `https://v.invalid/${encodeURIComponent(path)}`;
      if (d.format === 'datetime') return '2026-11-10T12:00:00Z';
      if (d.format === 'date') return '2026-11-10';
      const max = bound(d, 'max') ?? 64;
      const min = bound(d, 'min') ?? 0;
      return `v:${path}`.slice(0, max).padEnd(min, 'x');
    }
    case 'number': {
      const min = bound(d, 'min');
      const max = bound(d, 'max');
      const value = min ?? 1;
      return max === undefined ? value : Math.min(value, max);
    }
    case 'boolean':
      return true;
    case 'literal':
      return d.values?.[0];
    case 'enum': {
      const values = Object.values(d.entries ?? {});
      return values[variant % values.length];
    }
    case 'array': {
      if (d.element === undefined) return [];
      const count = Math.max(1, bound(d, 'min') ?? 1);
      return Array.from({ length: count }, (_, i) =>
        sample(
          d.element as z.ZodType,
          { ...options, variant: variant + i },
          `${path}[${String(i)}]`,
        ),
      );
    }
    case 'optional':
    case 'nullable':
      return d.innerType === undefined ? undefined : sample(d.innerType, options, path);
    case 'union': {
      const opts = d.options ?? [];
      const choice = opts[variant % opts.length];
      return choice === undefined ? undefined : sample(choice, options, path);
    }
    case 'pipe':
      return d.in === undefined ? null : sample(d.in, options, path);
    case 'record':
      return d.valueType === undefined ? {} : { k1: sample(d.valueType, options, `${path}.k1`) };
    case 'custom':
      // z.instanceof(Uint8Array): the bytes of a binary read, JPEG-looking.
      return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    case 'unknown':
      return { anything: 'v:unknown' };
    case 'null':
      return null;
    default:
      throw new Error(`No sample for zod type ${d.type} at ${path}.`);
  }
}

function unwrap(schema: z.ZodType): z.ZodType {
  const d = def(schema);
  return (d.type === 'optional' || d.type === 'nullable') && d.innerType !== undefined
    ? unwrap(d.innerType)
    : schema;
}
