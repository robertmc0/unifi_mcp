/**
 * Translates an OpenAPI 3.1 contract into zod source code for an adapter package
 * (ADR 0006 item 6, ADR 0018). The output is our own runtime validation code: it copies no
 * vendor prose (descriptions and examples are dropped) and carries no security metadata,
 * which adapters write by hand (spec §4.3).
 *
 * Two flavours of every schema are generated, each only where it is used:
 *
 * - **Request (`…In`)**: strict. Unknown properties are rejected, enums and formats are
 *   enforced, and strings and arrays get an upper bound even where the vendor states none.
 *   Defaults are not applied: only what the client sent is forwarded.
 * - **Response (`…Out`)**: tolerant of additions but never permissive. Undocumented
 *   properties are stripped, so they cannot reach a client; unknown enum values and unknown
 *   discriminator values are accepted (as strings, or as the base object) so that a newer
 *   console does not break reads. A documented discriminator value must match its own
 *   variant: it never falls back to the base object, which would silently drop the
 *   variant's fields. Documented required properties stay required, except reviewed ones a
 *   console was observed to leave out (`optionalResponseProperties`).
 *
 * A hand transcription of a PDF contract (`transcription`, ADR 0022) is translated by the
 * same rules, with three differences: the citation extensions (`x-pdf`, `x-note`,
 * `x-minimum-version`) are accepted as annotations; a response property that cites the PDF
 * is optional and nullable, because the PDF states neither; and each operation lists the
 * request fields that need a later application version than the operation itself.
 *
 * Anything the translator does not understand throws, so nothing is translated silently
 * wrong. The vendor document must not contain cycles.
 */
import { WEBSOCKET_PATH } from './openapi-inventory.ts';

/** A parsed OpenAPI document; its structure is checked while translating. */
type OpenApiDocument = object;

type Schema = Record<string, unknown>;
type Flavour = 'in' | 'out';

/** Upper bounds for request values the vendor leaves unbounded. */
export const DEFAULT_MAX_STRING = 4096;
export const DEFAULT_MAX_ITEMS = 1000;

const ANNOTATIONS = new Set([
  'description',
  'example',
  'examples',
  'default',
  'deprecated',
  'title',
  'x-tags',
  'x-enum-descriptions',
  'x-enum-varnames',
]);
/** Annotations a transcription adds (ADR 0022 §2, §3). A vendor document may not use them. */
export const TRANSCRIPTION_ANNOTATIONS: ReadonlySet<string> = new Set([
  'x-pdf',
  'x-note',
  'x-minimum-version',
  'x-minimum-version-source',
]);
const STRUCTURAL = new Set([
  'type',
  '$ref',
  'format',
  'properties',
  'required',
  'allOf',
  'items',
  'minimum',
  'maximum',
  'discriminator',
  'enum',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'uniqueItems',
  'oneOf',
  'anyOf',
  'const',
  'additionalProperties',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'pattern',
  'minProperties',
]);
const STRING_FORMATS = new Set(['uuid', 'date-time', 'date', 'uri']);
/** Keywords that may sit next to `oneOf`/`anyOf` without changing what they mean. */
const UNION_SIBLINGS = new Set(['oneOf', 'anyOf', 'discriminator']);
const INT32 = { min: -2147483648, max: 2147483647 };
const SUCCESS = /^2\d\d$/;
const COMPONENT_REF = /^#\/components\/schemas\/(.+)$/;
const OPERATION_ID = /^[a-z][A-Za-z0-9]*$/;
/** Documented binary response media types, returned as bytes (ADR 0019). */
const BINARY_MEDIA = new Set(['image/jpeg']);

export interface GeneratorOptions {
  /** Shown in the header, e.g. `api-specs/network/11.0.97/vendor/openapi.json`. */
  source: string;
  sourceSha256: string;
  generator: string;
  /** Path parameters that are targets supplied by the dispatcher, never arguments. */
  targetParameters?: readonly string[];
  /**
   * Optional query parameters left out on purpose, by operationId and name, with the
   * reason (a reviewed deviation, ADR 0018). Generation fails if one no longer exists or
   * is no longer anomalous, so the decision is revisited.
   */
  omittedParameters?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /**
   * How generated operations are named. `operationId` (the default) uses the vendor's
   * operationId. `path` derives the name from the method and path, for contracts without
   * operationIds (`GET /v1/cameras/{id}` → `getV1CamerasById`); `OPERATIONS` is then keyed
   * by `"<METHOD> <path>"`, the inventory key.
   */
  naming?: 'operationId' | 'path';
  /**
   * Operations left out on purpose, by `"<METHOD> <path>"`, with the reason (a reviewed
   * deviation). Generation fails if one no longer exists, so the decision is revisited.
   */
  omittedOperations?: Readonly<Record<string, string>>;
  /**
   * Response properties a console was observed to leave out although the contract requires
   * them, by component schema and property, with the reason (a reviewed deviation, ADR 0019
   * §8). They are accepted when absent in responses only; requests are unchanged. Generation
   * fails if one no longer exists, is no longer required, or is not used in a response, so
   * the decision is revisited.
   */
  optionalResponseProperties?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /**
   * The document is this project's hand transcription of a PDF contract, not a vendor
   * document (ADR 0022). Enables its annotations, optional and nullable response
   * properties where they cite the PDF, and `versionedFields` on every operation.
   */
  transcription?: boolean;
  /**
   * Transcriptions only: inventory facts of each operation, by `"<METHOD> <path>"` (from
   * operations.json): the lowest application version the vendor states (ADR 0021 §3), the
   * documentation link and the vendor permission key. Every generated operation needs them.
   */
  operationFacts?: Readonly<Record<string, OperationFacts>>;
}

interface OperationInfo {
  /** The export name. */
  operationId: string;
  /** `"<METHOD> <path>"`. */
  key: string;
  method: string;
  path: string;
  pathParameters: string[];
  queryParameters: string[];
  hasBody: boolean;
}

export interface OperationFacts {
  minimumVersion: string;
  documentationUrl: string;
  vendorPermission: string;
}

/** A request field that needs a later application version than its operation. */
interface VersionedField {
  /** The argument (`expand[]`) or a path into the body (`body.user_email`, `body.items[].id`). */
  field: string;
  minimum: string;
}

interface Parts {
  props: Map<string, Schema>;
  required: Set<string>;
  /** Property name → literal values that replace its schema (discriminator variants). */
  literals: Map<string, string[]>;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

function isObject(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(where: string, message: string): never {
  throw new Error(`OpenAPI translation failed at ${where}: ${message}`);
}

function refName(ref: unknown, where: string): string {
  const match = typeof ref === 'string' ? COMPONENT_REF.exec(ref) : null;
  if (match?.[1] === undefined) fail(where, `unsupported $ref ${String(ref)}`);
  return match[1];
}

/** `Site overview page` → `SiteOverviewPage`; `IntegrationFooDto` stays as it is. */
export function identifierFor(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter((word) => word !== '');
  const id = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('');
  if (!/^[A-Z][A-Za-z0-9]*$/.test(id)) throw new Error(`No identifier for schema "${name}".`);
  return id;
}

const PRIMITIVE_KEYWORDS = new Set([
  'type',
  'format',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'enum',
]);

/**
 * Both schemas must hold (allOf): the intersection of two primitive schemas of the same
 * type, with the tighter bounds and the common enum values. Anything else is refused.
 */
export function intersectPrimitive(a: Schema, b: Schema, where: string): Schema {
  for (const schema of [a, b]) {
    for (const keyword of Object.keys(schema)) {
      if (!PRIMITIVE_KEYWORDS.has(keyword) && !ANNOTATIONS.has(keyword)) {
        fail(where, 'conflicting non-primitive property definitions in allOf');
      }
    }
  }
  if (a['type'] !== b['type']) fail(where, 'conflicting types in allOf');
  if (a['format'] !== undefined && b['format'] !== undefined && a['format'] !== b['format']) {
    fail(where, 'conflicting formats in allOf');
  }
  const result: Schema = { type: a['type'] };
  const format = a['format'] ?? b['format'];
  if (format !== undefined) result['format'] = format;
  const pick = (keyword: string, choose: (x: number, y: number) => number): void => {
    const values = [a[keyword], b[keyword]].filter((v): v is number => typeof v === 'number');
    // Not `reduce(choose)`: reduce also passes the index and the array, and Math.max of an
    // array is NaN.
    if (values.length > 0) result[keyword] = values.reduce((x, y) => choose(x, y));
    if (typeof result[keyword] === 'number' && !Number.isFinite(result[keyword])) {
      fail(where, `${keyword} is not a finite number`);
    }
  };
  pick('minLength', Math.max);
  pick('maxLength', Math.min);
  pick('minimum', Math.max);
  pick('maximum', Math.min);
  const enums = [a['enum'], b['enum']].filter((v): v is unknown[] => Array.isArray(v));
  if (enums.length === 2) {
    const [first = [], second = []] = enums;
    result['enum'] = first.filter((v) => second.includes(v));
  } else if (enums.length === 1) {
    result['enum'] = enums[0];
  }
  if (Array.isArray(result['enum']) && result['enum'].length === 0) fail(where, 'empty enum');
  return result;
}

/** `GET /v1/cameras/{id}/snapshot` → `getV1CamerasByIdSnapshot`. */
export function operationName(method: string, path: string): string {
  const words = [method.toLowerCase()];
  for (const segment of path.split('/').filter((part) => part !== '')) {
    const parameter = /^\{(.+)\}$/.exec(segment);
    if (parameter !== null) words.push('by');
    words.push(...(parameter?.[1] ?? segment).split(/[^A-Za-z0-9]+/).filter((w) => w !== ''));
  }
  return words.map((w, i) => (i === 0 ? w : `${w[0]?.toUpperCase() ?? ''}${w.slice(1)}`)).join('');
}

function key(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function literal(value: string | number): string {
  return JSON.stringify(value);
}

export class OpenApiZodGenerator {
  readonly #components: Record<string, Schema>;
  readonly #ids = new Map<string, string>();
  /** Variant component → its discriminator bases (the vendor duplicates some bases). */
  readonly #variantOf = new Map<string, Set<string>>();
  /** Variant component → base → discriminator values that select it. */
  readonly #variantKeys = new Map<string, Map<string, string[]>>();
  readonly #emitted = new Map<string, string>();
  readonly #inProgress = new Set<string>();
  readonly #definitions: string[] = [];
  /** Whether a schema uses the `unique` helper (emitted only then, for the linter). */
  usesUnique = false;
  /** Whether a schema uses the `unlisted` helper (emitted only then, for the linter). */
  usesUnlisted = false;
  /** Reviewed response properties that may be absent: `"<schema>.<property>"` → reason. */
  readonly #absentAllowed: ReadonlyMap<string, string>;
  /** Those of them that were applied to a response schema. */
  readonly absentApplied = new Set<string>();
  /** Whether the document is a hand transcription (ADR 0022). */
  readonly #transcription: boolean;
  readonly #facts: Readonly<Record<string, OperationFacts>>;

  constructor(
    doc: OpenApiDocument,
    options: Pick<
      GeneratorOptions,
      'optionalResponseProperties' | 'transcription' | 'operationFacts'
    > = {},
  ) {
    this.#transcription = options.transcription === true;
    this.#facts = options.operationFacts ?? {};
    this.#absentAllowed = new Map(
      Object.entries(options.optionalResponseProperties ?? {}).flatMap(([schema, properties]) =>
        Object.entries(properties).map(([property, reason]) => [`${schema}.${property}`, reason]),
      ),
    );
    const components = (doc as { components?: { schemas?: unknown } }).components?.schemas;
    if (!isObject(components)) throw new Error('The document has no components.schemas.');
    this.#components = components as Record<string, Schema>;
    // Names that differ only in case or punctuation (the vendor has e.g. "IP Address
    // selector" and "IP address selector") get a numeric suffix in sorted order.
    const used = new Set<string>();
    for (const name of Object.keys(this.#components).sort()) {
      const base = identifierFor(name);
      let id = base;
      for (let n = 2; used.has(id); n++) id = `${base}${String(n)}`;
      used.add(id);
      this.#ids.set(name, id);
    }
    for (const [name, schema] of Object.entries(this.#components)) {
      const discriminator = schema['discriminator'];
      if (discriminator === undefined) continue;
      if (!isObject(discriminator) || !isObject(discriminator['mapping'])) {
        fail(name, 'a discriminator needs an explicit mapping');
      }
      for (const [value, ref] of Object.entries(discriminator['mapping'])) {
        const variant = refName(ref, `${name}.discriminator`);
        const bases = this.#variantOf.get(variant) ?? new Set<string>();
        bases.add(name);
        this.#variantOf.set(variant, bases);
        const byBase = this.#variantKeys.get(variant) ?? new Map<string, string[]>();
        byBase.set(name, [...(byBase.get(name) ?? []), value].sort());
        this.#variantKeys.set(variant, byBase);
      }
    }
  }

  /**
   * `{}` or annotations only, directly or through references: any value. Allowed only
   * where a variant narrows it.
   */
  #isUnconstrained(schema: Schema): boolean {
    const keywords = Object.keys(schema).filter((keyword) => !this.#isAnnotation(keyword));
    if (keywords.length === 0) return true;
    if (keywords.length === 1 && keywords[0] === '$ref') {
      const target = refName(schema['$ref'], 'unconstrained check');
      return this.#isUnconstrained(this.#component(target, target));
    }
    return false;
  }

  #component(name: string, where: string): Schema {
    const schema = this.#components[name];
    if (schema === undefined) fail(where, `unknown schema ${name}`);
    return schema;
  }

  #isAnnotation(keyword: string): boolean {
    return (
      ANNOTATIONS.has(keyword) || (this.#transcription && TRANSCRIPTION_ANNOTATIONS.has(keyword))
    );
  }

  #checkKeywords(schema: Schema, where: string): void {
    for (const keyword of Object.keys(schema)) {
      if (!this.#isAnnotation(keyword) && !STRUCTURAL.has(keyword)) {
        fail(where, `unsupported keyword "${keyword}"`);
      }
    }
  }

  /** Emits (once) the const for a component in a flavour and returns its identifier. */
  ref(name: string, flavour: Flavour, where: string): string {
    const id = `${this.#ids.get(name) ?? fail(where, `unknown schema ${name}`)}${flavour === 'in' ? 'In' : 'Out'}`;
    const token = `${name}\u0000${flavour}`;
    if (this.#emitted.has(token)) return id;
    if (this.#inProgress.has(token)) fail(name, 'recursive schemas are not supported');
    this.#inProgress.add(token);
    const code = this.#componentCode(name, flavour);
    this.#inProgress.delete(token);
    this.#emitted.set(token, id);
    this.#definitions.push(`const ${id} = ${code};`);
    return id;
  }

  #componentCode(name: string, flavour: Flavour): string {
    const schema = this.#component(name, name);
    if (schema['discriminator'] !== undefined) return this.#unionCode(name, flavour);
    if (this.#variantOf.has(name)) return this.#objectCode(this.#variantParts(name), flavour, name);
    return this.#code(schema, flavour, name);
  }

  #unionCode(name: string, flavour: Flavour): string {
    const schema = this.#component(name, name);
    const discriminator = schema['discriminator'] as Schema;
    const property = discriminator['propertyName'];
    if (typeof property !== 'string') fail(name, 'discriminator without propertyName');
    const variants = [
      ...new Set(
        Object.values(discriminator['mapping'] as Record<string, unknown>).map((ref) =>
          refName(ref, name),
        ),
      ),
    ];
    const ids = variants.map((variant) => this.ref(variant, flavour, `${name}→${variant}`));
    if (flavour === 'in') return `z.discriminatedUnion(${literal(property)}, [${ids.join(', ')}])`;
    // Responses: an unknown discriminator value still yields the documented base fields,
    // and at least the discriminator (a oneOf-style base has no fields of its own). A
    // documented value must match its variant instead.
    const parts = this.#ownParts(name);
    if (!parts.props.has(property)) {
      parts.props.set(property, { type: 'string' });
      parts.required.add(property);
    }
    const unlisted = { property, values: Object.keys(discriminator['mapping'] as Schema) };
    const base = this.#objectCode(parts, flavour, `${name} (base)`, unlisted);
    return `z.union([${[...ids, base].join(', ')}])`;
  }

  /**
   * A discriminator in a response's fallback branch: any string except the documented
   * values, so that a documented variant that misses its own schema is refused rather than
   * reduced to the base fields. The check aborts: otherwise zod would report only this
   * branch's issue for a union, hiding the field the selected variant is missing.
   */
  #unlistedCode(values: readonly string[]): string {
    this.usesUnlisted = true;
    const sorted = [...new Set(values)].sort();
    return `z.string().refine(unlisted([${sorted.map(literal).join(', ')}]), UNLISTED)`;
  }

  /** Properties and required names of an object schema (merging allOf). */
  #ownParts(name: string): Parts {
    return this.#partsOf(this.#component(name, name), name);
  }

  /**
   * An instance must satisfy the base schema *and* the variant the discriminator selects
   * (JSON Schema semantics). The vendor does not always repeat the base in the variant's
   * allOf, so the base's own properties are merged in explicitly.
   */
  #variantParts(variant: string): Parts {
    const bases = this.#variantOf.get(variant) ?? fail(variant, 'not a variant');
    const parts: Parts = { props: new Map(), required: new Set(), literals: new Map() };
    for (const base of [...bases].sort()) this.#merge(parts, this.#ownParts(base), variant);
    this.#merge(parts, this.#partsOf(this.#component(variant, variant), variant, true), variant);
    const properties = [...bases].map(
      (base) => (this.#component(base, base)['discriminator'] as Schema)['propertyName'],
    );
    const discriminator = properties[0];
    if (typeof discriminator !== 'string' || properties.some((p) => p !== discriminator)) {
      fail(variant, 'its bases disagree on the discriminator property');
    }
    const keySets = [...(this.#variantKeys.get(variant)?.values() ?? [])].map((keys) =>
      keys.join('\u0000'),
    );
    if (new Set(keySets).size !== 1) fail(variant, 'its bases select it by different values');
    parts.required.add(discriminator);
    parts.literals.set(discriminator, keySets[0]?.split('\u0000') ?? []);
    return parts;
  }

  /**
   * Properties and required names of an object schema, merging allOf. Inside a variant
   * (`inVariant`), a referenced polymorphic base contributes its own properties; anywhere
   * else, merging a polymorphic schema would lose its union and is refused.
   */
  #partsOf(schema: Schema, where: string, inVariant = false): Parts {
    this.#checkKeywords(schema, where);
    if (schema['$ref'] !== undefined) {
      const target = refName(schema['$ref'], where);
      const component = this.#component(target, where);
      if (component['discriminator'] !== undefined) {
        if (!inVariant) fail(where, `cannot merge the polymorphic schema ${target}`);
        return this.#ownParts(target);
      }
      if (this.#variantOf.has(target)) {
        if (!inVariant) return this.#variantParts(target);
        fail(where, `a variant extending the variant ${target} is not supported`);
      }
      return this.#ownParts(target);
    }
    if (schema['type'] !== undefined && schema['type'] !== 'object') {
      fail(where, 'only objects can be merged');
    }
    const parts: Parts = { props: new Map(), required: new Set(), literals: new Map() };
    for (const member of (schema['allOf'] as unknown[] | undefined) ?? []) {
      if (!isObject(member)) fail(where, 'allOf member is not a schema');
      this.#merge(parts, this.#partsOf(member, where, inVariant), where);
    }
    const properties = schema['properties'];
    if (properties !== undefined) {
      if (!isObject(properties)) fail(where, 'properties is not an object');
      for (const [name, value] of Object.entries(properties)) {
        if (!isObject(value)) fail(`${where}.${name}`, 'property schema is not an object');
        parts.props.set(name, value);
      }
    }
    for (const name of (schema['required'] as string[] | undefined) ?? []) parts.required.add(name);
    return parts;
  }

  #merge(into: Parts, from: Parts, where: string): void {
    for (const [name, schema] of from.props) {
      const existing = into.props.get(name);
      if (existing === undefined || this.#isUnconstrained(existing)) {
        into.props.set(name, schema);
      } else if (
        this.#isUnconstrained(schema) ||
        from.literals.has(name) ||
        into.literals.has(name)
      ) {
        // Never weaken; a discriminator literal replaces the property anyway.
      } else if (JSON.stringify(existing) !== JSON.stringify(schema)) {
        into.props.set(name, intersectPrimitive(existing, schema, `${where}.${name}`));
      }
    }
    for (const name of from.required) into.required.add(name);
    for (const [name, values] of from.literals) into.literals.set(name, values);
  }

  #objectCode(
    parts: Parts,
    flavour: Flavour,
    where: string,
    /** The fallback branch of a response union: its discriminator and the documented values. */
    unlisted?: { property: string; values: readonly string[] },
  ): string {
    for (const name of parts.required) {
      if (!parts.props.has(name)) fail(where, `required property ${name} is not defined`);
    }
    const fields: string[] = [];
    for (const [name, schema] of parts.props) {
      const values = parts.literals.get(name);
      const fallback = flavour === 'out' && unlisted?.property === name;
      if (!fallback && values === undefined && this.#isUnconstrained(schema)) {
        // An undocumented shape is never accepted from a client nor passed to one.
        if (flavour === 'in') fail(`${where}.${name}`, 'unconstrained request property');
        continue;
      }
      let code = fallback
        ? this.#unlistedCode(unlisted.values)
        : values === undefined
          ? this.#code(schema, flavour, `${where}.${name}`)
          : values.length === 1
            ? `z.literal(${literal(values[0] ?? '')})`
            : `z.enum([${values.map(literal).join(', ')}])`;
      // `where` is the component name for a component's own object (ADR 0019 §8).
      const reviewed = `${where}.${name}`;
      if (flavour === 'out' && this.#transcription && schema['x-pdf'] !== undefined) {
        // The PDF marks no response field required and states no nullability (ADR 0022 §3).
        if (!code.endsWith('.nullable()')) code += '.nullable()';
        code += '.optional()';
      } else if (flavour === 'out' && this.#absentAllowed.has(reviewed)) {
        if (!parts.required.has(name)) fail(reviewed, 'is no longer required: revisit its review');
        this.absentApplied.add(reviewed);
        code += '.optional()';
      } else if (!parts.required.has(name)) {
        code += '.optional()';
      }
      fields.push(`${key(name)}: ${code}`);
    }
    return `${flavour === 'in' ? 'z.strictObject' : 'z.object'}({ ${fields.join(', ')} })`;
  }

  #code(schema: Schema, flavour: Flavour, where: string): string {
    this.#checkKeywords(schema, where);
    if (schema['$ref'] !== undefined) {
      const structural = Object.keys(schema).filter((k) => STRUCTURAL.has(k) && k !== '$ref');
      if (structural.length > 0) fail(where, '$ref with structural siblings');
      return this.ref(refName(schema['$ref'], where), flavour, where);
    }
    if (this.#isUnconstrained(schema)) fail(where, 'unconstrained schema');
    if (schema['oneOf'] !== undefined || schema['anyOf'] !== undefined) {
      return this.#unionOf(schema, flavour, where);
    }
    if (schema['discriminator'] !== undefined) fail(where, 'a discriminator without oneOf');
    const allOf = schema['allOf'];
    if (allOf !== undefined) {
      if (!Array.isArray(allOf)) fail(where, 'allOf is not an array');
      const structural = Object.keys(schema).filter((k) => STRUCTURAL.has(k) && k !== 'allOf');
      // `allOf: [{ $ref }]` alone only attaches annotations to a reference.
      if (allOf.length === 1 && structural.length === 0 && isObject(allOf[0])) {
        return this.#code(allOf[0], flavour, where);
      }
      // `allOf: [{ $ref: <primitive> }]` with constraints beside it narrows the primitive
      // (`minimum: 1` on a 0–100 volume, an enum on a string): both must hold.
      const member = allOf.length === 1 && isObject(allOf[0]) ? allOf[0] : undefined;
      if (member?.['$ref'] !== undefined && structural.every((k) => PRIMITIVE_KEYWORDS.has(k))) {
        const target = this.#component(refName(member['$ref'], where), where);
        const type = target['type'];
        if (type === 'string' || type === 'number' || type === 'integer') {
          const siblings = Object.fromEntries(structural.map((k) => [k, schema[k]]));
          return this.#code(
            intersectPrimitive(target, { ...siblings, type }, where),
            flavour,
            where,
          );
        }
      }
      return this.#withMinProperties(
        this.#objectCode(this.#partsOf(schema, where), flavour, where),
        schema,
        flavour,
        where,
      );
    }
    if (schema['const'] !== undefined) return this.#constCode(schema, where);
    const type = schema['type'];
    // An enum without a type whose values are all strings is a string enum.
    const values = schema['enum'];
    if (type === undefined && Array.isArray(values) && values.every((v) => typeof v === 'string')) {
      return this.#stringCode(schema, flavour, where);
    }
    if (Array.isArray(type)) {
      // `type: [T, "null"]`: T or null.
      const others = type.filter((t) => t !== 'null');
      if (type.length !== 2 || others.length !== 1 || typeof others[0] !== 'string') {
        fail(where, `unsupported type ${JSON.stringify(type)}`);
      }
      return `${this.#code({ ...schema, type: others[0] }, flavour, where)}.nullable()`;
    }
    switch (type) {
      case 'null':
        return 'z.null()';
      case 'object': {
        const open = schema['additionalProperties'];
        if (
          schema['properties'] === undefined &&
          (open === true || (isObject(open) && this.#isUnconstrained(open)))
        ) {
          // Any object at all: nothing to forward to a console or pass to a client.
          fail(where, 'an open object without properties');
        }
        const map = this.#mapValues(schema, where);
        if (map !== undefined) {
          if (flavour === 'in') fail(where, 'typed maps in requests are not supported');
          return `z.record(z.string(), ${this.#code(map, flavour, `${where}{}`)})`;
        }
        return this.#withMinProperties(
          this.#objectCode(this.#partsOf(schema, where), flavour, where),
          schema,
          flavour,
          where,
        );
      }
      case 'string':
        return this.#stringCode(schema, flavour, where);
      case 'integer':
      case 'number':
        return this.#numberCode(schema, flavour, where, type);
      case 'boolean':
        if (schema['enum'] !== undefined) fail(where, 'boolean enums');
        return 'z.boolean()';
      case 'array': {
        const items = schema['items'];
        if (!isObject(items)) fail(where, 'array without items');
        let code = `z.array(${this.#code(items, flavour, `${where}[]`)})`;
        if (flavour === 'out') return code;
        const min = schema['minItems'];
        const max = schema['maxItems'];
        if (typeof min === 'number' && min > 0) code += `.min(${String(min)})`;
        code += `.max(${String(typeof max === 'number' ? max : DEFAULT_MAX_ITEMS)})`;
        if (schema['uniqueItems'] === true) {
          code += '.refine(unique, { message: UNIQUE })';
          this.usesUnique = true;
        }
        return code;
      }
      default:
        return fail(where, `unsupported type ${JSON.stringify(type)}`);
    }
  }

  /**
   * `oneOf`/`anyOf`. A `{ type: "null" }` member makes the rest nullable. A union of string
   * constants is an enum (relaxed to a string in responses, like enums). With an inline
   * discriminator, responses also accept an unknown discriminator value, keeping only the
   * discriminator. Request unions accept a value that matches any member: members are
   * strict objects or distinct primitives, so `oneOf` and `anyOf` do not differ in practice.
   */
  #unionOf(schema: Schema, flavour: Flavour, where: string): string {
    if (schema['oneOf'] !== undefined && schema['anyOf'] !== undefined) {
      fail(where, 'oneOf and anyOf together');
    }
    const extra = Object.keys(schema).filter((k) => STRUCTURAL.has(k) && !UNION_SIBLINGS.has(k));
    if (extra.length > 0) fail(where, `oneOf/anyOf next to ${extra.join(', ')}`);
    const members = schema['oneOf'] ?? schema['anyOf'];
    if (!Array.isArray(members) || members.length === 0 || !members.every(isObject)) {
      fail(where, 'oneOf/anyOf must be a non-empty list of schemas');
    }
    const isNull = (m: Schema) =>
      m['type'] === 'null' && Object.keys(m).every((k) => k === 'type' || this.#isAnnotation(k));
    const nullable = members.some(isNull);
    const others = members.filter((m) => !isNull(m));
    if (others.length === 0) fail(where, 'a union of null only');
    const suffix = nullable ? '.nullable()' : '';
    const constants = others.map((m) =>
      typeof m['const'] === 'string' &&
      (m['type'] === undefined || m['type'] === 'string') &&
      Object.keys(m).every((k) => k === 'const' || k === 'type' || this.#isAnnotation(k))
        ? m['const']
        : undefined,
    );
    if (others.length > 1 && constants.every((c) => c !== undefined)) {
      if (flavour === 'out') return `z.string()${suffix}`;
      return `z.enum([${constants.map((c) => literal(c)).join(', ')}])${suffix}`;
    }
    const codes = others.map((m, i) => this.#code(m, flavour, `${where}|${String(i)}`));
    const discriminator = schema['discriminator'];
    if (discriminator !== undefined) {
      if (!isObject(discriminator) || typeof discriminator['propertyName'] !== 'string') {
        fail(where, 'discriminator without propertyName');
      }
      if (!isObject(discriminator['mapping']))
        fail(where, 'a discriminator needs an explicit mapping');
      const refs = new Set(others.map((m) => m['$ref']));
      for (const ref of Object.values(discriminator['mapping'])) {
        if (!refs.has(ref)) fail(where, `the discriminator maps to ${String(ref)}, not a member`);
      }
      if (flavour === 'out') {
        const values = this.#unlistedCode(Object.keys(discriminator['mapping']));
        codes.push(`z.object({ ${key(discriminator['propertyName'])}: ${values} })`);
      }
    }
    return `${codes.length === 1 ? (codes[0] ?? '') : `z.union([${codes.join(', ')}])`}${suffix}`;
  }

  #constCode(schema: Schema, where: string): string {
    const value = schema['const'];
    const type = schema['type'];
    if (value === null) return 'z.null()';
    if (typeof value === 'string' && (type === undefined || type === 'string')) {
      return `z.literal(${literal(value)})`;
    }
    if (
      typeof value === 'number' &&
      (type === undefined || type === 'number' || type === 'integer')
    ) {
      return `z.literal(${String(value)})`;
    }
    if (typeof value === 'boolean' && (type === undefined || type === 'boolean')) {
      return `z.literal(${String(value)})`;
    }
    return fail(where, `unsupported const ${JSON.stringify(value)}`);
  }

  /** The value schema of a typed map (`additionalProperties` with a schema, no properties). */
  #mapValues(schema: Schema, where: string): Schema | undefined {
    const values = schema['additionalProperties'];
    if (!isObject(values) || this.#isUnconstrained(values)) return undefined;
    if (schema['properties'] !== undefined || schema['allOf'] !== undefined) {
      fail(where, 'properties together with typed additionalProperties');
    }
    return values;
  }

  #withMinProperties(code: string, schema: Schema, flavour: Flavour, where: string): string {
    const min = schema['minProperties'];
    if (min === undefined || flavour === 'out') return code;
    if (typeof min !== 'number' || !Number.isInteger(min) || min < 0) {
      fail(where, 'minProperties must be a non-negative integer');
    }
    return `${code}.refine((value) => Object.keys(value).length >= ${String(min)}, { message: ${literal(`At least ${String(min)} properties.`)} })`;
  }

  #stringCode(schema: Schema, flavour: Flavour, where: string): string {
    const format = schema['format'];
    if (format !== undefined && (typeof format !== 'string' || !STRING_FORMATS.has(format))) {
      fail(where, `unsupported string format ${JSON.stringify(format)}`);
    }
    const values = schema['enum'];
    if (flavour === 'out') return 'z.string()';
    if (values !== undefined) {
      if (!Array.isArray(values) || !values.every((v) => typeof v === 'string')) {
        fail(where, 'string enum values must be strings');
      }
      return `z.enum([${values.map((v) => literal(v)).join(', ')}])`;
    }
    let code: string;
    switch (format) {
      case 'uuid':
        return 'z.guid()';
      case 'date-time':
        return 'z.iso.datetime({ offset: true })';
      case 'date':
        return 'z.iso.date()';
      case 'uri':
        code = 'z.url()';
        break;
      default:
        code = 'z.string()';
    }
    const min = schema['minLength'];
    const max = schema['maxLength'];
    if (typeof min === 'number' && min > 0) code += `.min(${String(min)})`;
    code += `.max(${String(typeof max === 'number' ? max : DEFAULT_MAX_STRING)})`;
    const pattern = schema['pattern'];
    if (pattern !== undefined) {
      if (typeof pattern !== 'string') fail(where, 'pattern is not a string');
      try {
        new RegExp(pattern, 'u');
      } catch {
        fail(where, `pattern ${JSON.stringify(pattern)} is not a valid regular expression`);
      }
      code += `.regex(new RegExp(${literal(pattern)}, 'u'))`;
    }
    return code;
  }

  #numberCode(schema: Schema, flavour: Flavour, where: string, type: 'integer' | 'number'): string {
    if (flavour === 'out') return 'z.number()';
    const values = schema['enum'];
    if (values !== undefined) {
      // The vendor writes some integer enums as numeric strings.
      if (!Array.isArray(values)) fail(where, 'enum is not an array');
      const numbers: unknown[] = values.map((v: unknown) =>
        typeof v === 'string' ? Number(v) : v,
      );
      if (!numbers.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        fail(where, 'numeric enum with non-numeric values');
      }
      return numbers.length === 1
        ? `z.literal(${String(numbers[0])})`
        : `z.union([${numbers.map((n) => `z.literal(${String(n)})`).join(', ')}])`;
    }
    const format = schema['format'];
    let min = schema['minimum'];
    let max = schema['maximum'];
    if (type === 'integer') {
      if (format !== undefined && format !== 'int32' && format !== 'int64') {
        fail(where, `unsupported integer format ${JSON.stringify(format)}`);
      }
      if (format === 'int32') {
        min ??= INT32.min;
        max ??= INT32.max;
      }
    } else if (format !== undefined && format !== 'double' && format !== 'float') {
      fail(where, `unsupported number format ${JSON.stringify(format)}`);
    }
    let code = type === 'integer' ? 'z.int()' : 'z.number()';
    if (typeof min === 'number') code += `.min(${String(min)})`;
    if (typeof max === 'number') code += `.max(${String(max)})`;
    for (const [keyword, method] of [
      ['exclusiveMinimum', 'gt'],
      ['exclusiveMaximum', 'lt'],
    ] as const) {
      const bound = schema[keyword];
      if (bound === undefined) continue;
      if (typeof bound !== 'number') fail(where, `${keyword} must be a number`);
      code += `.${method}(${String(bound)})`;
    }
    return code;
  }

  /** Request and response schemas of one operation. */
  operation(
    pathTemplate: string,
    method: (typeof HTTP_METHODS)[number],
    item: Schema,
    op: Schema,
    targets: ReadonlySet<string>,
    omitted: Readonly<Record<string, string>> = {},
    name?: string,
  ): { info: OperationInfo; code: string } {
    const operationId = name ?? op['operationId'];
    if (typeof operationId !== 'string' || !OPERATION_ID.test(operationId)) {
      fail(`${method} ${pathTemplate}`, 'missing or unusable operationId');
    }
    const where = operationId;
    const parameters = new Map<string, Schema>();
    for (const parameter of [
      ...((item['parameters'] as unknown[] | undefined) ?? []),
      ...((op['parameters'] as unknown[] | undefined) ?? []),
    ]) {
      if (!isObject(parameter)) fail(where, 'parameter is not an object');
      if (parameter['$ref'] !== undefined) fail(where, 'parameter references');
      parameters.set(`${String(parameter['in'])}:${String(parameter['name'])}`, parameter);
    }
    const fields: string[] = [];
    const notes: string[] = [];
    const pathParameters: string[] = [];
    const queryParameters: string[] = [];
    for (const name of Object.keys(omitted)) {
      const parameter = parameters.get(`query:${name}`);
      if (parameter === undefined || parameter['required'] === true) {
        fail(`${where}.${name}`, 'an omitted parameter must exist and be optional');
      }
    }
    for (const parameter of parameters.values()) {
      const name = parameter['name'];
      const location = parameter['in'];
      const schema = parameter['schema'];
      if (typeof name !== 'string' || !isObject(schema)) fail(where, 'malformed parameter');
      const reason = location === 'query' ? omitted[name] : undefined;
      if (reason !== undefined) {
        notes.push(`// Query parameter "${name}" omitted: ${reason}`);
        continue;
      }
      if (name === 'body') fail(where, 'a parameter named "body" collides with the body argument');
      if (location === 'path') {
        if (parameter['required'] !== true) fail(`${where}.${name}`, 'optional path parameter');
        if (!pathTemplate.includes(`{${name}}`)) fail(`${where}.${name}`, 'not in the path');
        pathParameters.push(name);
        if (targets.has(name)) continue;
        fields.push(`${key(name)}: ${this.#code(schema, 'in', `${where}.${name}`)}`);
      } else if (location === 'query') {
        queryParameters.push(name);
        const code = this.#code(schema, 'in', `${where}.${name}`);
        fields.push(`${key(name)}: ${code}${parameter['required'] === true ? '' : '.optional()'}`);
      } else {
        fail(`${where}.${name}`, `parameters in ${String(location)} are not supported`);
      }
    }
    for (const match of pathTemplate.matchAll(/\{([^}]+)\}/g)) {
      if (!pathParameters.includes(match[1] ?? '')) fail(where, `undeclared {${match[1] ?? ''}}`);
    }
    const versioned: VersionedField[] = [];
    if (this.#transcription) {
      for (const parameter of parameters.values()) {
        const name = String(parameter['name']);
        if (parameter['in'] === 'query' && omitted[name] !== undefined) continue;
        const minimum = parameter['x-minimum-version'];
        if (minimum === undefined) continue;
        if (typeof minimum !== 'string')
          fail(`${where}.${name}`, 'x-minimum-version is not a string');
        versioned.push({ field: name, minimum });
      }
    }
    const requestBody = op['requestBody'];
    let hasBody = false;
    if (requestBody !== undefined) {
      if (!isObject(requestBody) || !isObject(requestBody['content'])) {
        fail(where, 'malformed requestBody');
      }
      const types = Object.keys(requestBody['content']);
      const media = (requestBody['content'] as Record<string, Schema | undefined>)[
        'application/json'
      ];
      if (types.length !== 1 || !isObject(media) || !isObject(media['schema'])) {
        fail(where, 'only application/json request bodies are supported');
      }
      hasBody = true;
      if (this.#transcription) this.#versionedFields(media['schema'], 'body', versioned, new Set());
      const code = this.#code(media['schema'], 'in', `${where}.body`);
      fields.push(`body: ${code}${requestBody['required'] === true ? '' : '.optional()'}`);
    }
    const responses = op['responses'];
    if (!isObject(responses)) fail(where, 'no responses');
    const success = Object.entries(responses).filter(([status]) => SUCCESS.test(status));
    if (success.length !== 1) fail(where, 'exactly one documented 2xx response is supported');
    const response = success[0]?.[1];
    if (!isObject(response)) fail(where, 'malformed response');
    let output: string;
    let responseType: string;
    if (response['content'] === undefined) {
      // Nothing documented: whatever the console sends is discarded.
      output = 'z.unknown().transform(() => null)';
      responseType = 'none';
    } else {
      const content = response['content'];
      if (!isObject(content)) fail(where, 'malformed response content');
      const types = Object.keys(content);
      const mediaType = types[0] ?? '';
      const media = (content as Record<string, Schema | undefined>)[mediaType];
      if (types.length !== 1 || !isObject(media) || !isObject(media['schema'])) {
        fail(where, 'exactly one documented response media type with a schema is supported');
      }
      if (mediaType === 'application/json') {
        output = this.#code(media['schema'], 'out', `${where} (response)`);
        responseType = 'json';
      } else if (BINARY_MEDIA.has(mediaType)) {
        const schema = media['schema'];
        if (schema['type'] !== 'string' || schema['format'] !== 'binary') {
          fail(where, `a ${mediaType} response must be documented as a binary string`);
        }
        output = 'z.instanceof(Uint8Array)';
        responseType = mediaType;
      } else {
        fail(where, `unsupported response media type ${mediaType}`);
      }
    }
    const info: OperationInfo = {
      operationId,
      key: `${method.toUpperCase()} ${pathTemplate}`,
      method: method.toUpperCase(),
      path: pathTemplate,
      pathParameters,
      queryParameters,
      hasBody,
    };
    const code = [
      ...notes,
      `export const ${operationId} = {`,
      `  method: ${literal(info.method)},`,
      `  path: ${literal(pathTemplate)},`,
      `  transport: ${literal(WEBSOCKET_PATH.test(pathTemplate) ? 'websocket' : 'http')},`,
      `  queryParameters: [${queryParameters.map(literal).join(', ')}],`,
      `  hasBody: ${String(hasBody)},`,
      `  responseType: ${literal(responseType)},`,
      ...(this.#transcription
        ? [
            ...((facts: OperationFacts) => [
              `  minimumVersion: ${literal(facts.minimumVersion)},`,
              `  documentationUrl: ${literal(facts.documentationUrl)},`,
              `  vendorPermission: ${literal(facts.vendorPermission)},`,
            ])(this.#facts[info.key] ?? fail(where, 'no inventory facts')),
            `  versionedFields: [${versioned
              .sort((a, b) => a.field.localeCompare(b.field))
              .map((v) => `{ field: ${literal(v.field)}, minimum: ${literal(v.minimum)} }`)
              .join(', ')}],`,
          ]
        : []),
      `  input: z.strictObject({ ${fields.join(', ')} }),`,
      `  output: ${output},`,
      `} as const;`,
    ].join('\n');
    return { info, code };
  }

  /** Request fields below `schema` that state their own minimum version (ADR 0022 §3). */
  #versionedFields(
    schema: Schema,
    field: string,
    out: VersionedField[],
    seen: ReadonlySet<string>,
  ): void {
    if (schema['$ref'] !== undefined) {
      const name = refName(schema['$ref'], field);
      if (seen.has(name)) fail(field, 'recursive schemas are not supported');
      const component = this.#component(name, field);
      this.#versionedFields(component, field, out, new Set([...seen, name]));
      return;
    }
    for (const keyword of ['allOf', 'oneOf', 'anyOf']) {
      const members = schema[keyword];
      if (!Array.isArray(members)) continue;
      for (const member of members) {
        if (isObject(member)) this.#versionedFields(member, field, out, seen);
      }
    }
    const properties = schema['properties'];
    if (isObject(properties)) {
      for (const [name, value] of Object.entries(properties)) {
        if (!isObject(value)) continue;
        const path = `${field}.${name}`;
        const minimum = value['x-minimum-version'];
        if (minimum !== undefined) {
          if (typeof minimum !== 'string') fail(path, 'x-minimum-version is not a string');
          out.push({ field: path, minimum });
        }
        this.#versionedFields(value, path, out, seen);
      }
    }
    const items = schema['items'];
    if (isObject(items)) this.#versionedFields(items, `${field}[]`, out, seen);
  }

  definitions(): readonly string[] {
    return this.#definitions;
  }
}

/** Generates the complete module source (unformatted). */
export function generateZodModule(doc: OpenApiDocument, options: GeneratorOptions): string {
  const generator = new OpenApiZodGenerator(doc, {
    ...(options.optionalResponseProperties === undefined
      ? {}
      : { optionalResponseProperties: options.optionalResponseProperties }),
    ...(options.transcription === undefined ? {} : { transcription: options.transcription }),
    ...(options.operationFacts === undefined ? {} : { operationFacts: options.operationFacts }),
  });
  const targets = new Set(options.targetParameters ?? []);
  const paths = (doc as { paths?: unknown }).paths;
  if (!isObject(paths)) throw new Error('The document has no paths.');
  const byPath = options.naming === 'path';
  const omittedOperations = new Map(Object.entries(options.omittedOperations ?? {}));
  const notes: string[] = [];
  const operations: { info: OperationInfo; code: string }[] = [];
  for (const pathTemplate of Object.keys(paths).sort()) {
    const item = paths[pathTemplate];
    if (!isObject(item)) continue;
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!isObject(op)) continue;
      const opKey = `${method.toUpperCase()} ${pathTemplate}`;
      const reason = omittedOperations.get(opKey);
      if (reason !== undefined) {
        notes.push(`// Operation "${opKey}" omitted: ${reason}`);
        omittedOperations.delete(opKey);
        continue;
      }
      const name = byPath ? operationName(method, pathTemplate) : undefined;
      const id = name ?? (typeof op['operationId'] === 'string' ? op['operationId'] : '');
      operations.push(
        generator.operation(
          pathTemplate,
          method,
          item,
          op,
          targets,
          options.omittedParameters?.[id],
          name,
        ),
      );
    }
  }
  for (const opKey of omittedOperations.keys()) {
    throw new Error(`OpenAPI translation failed at ${opKey}: an omitted operation must exist`);
  }
  for (const [schema, properties] of Object.entries(options.optionalResponseProperties ?? {})) {
    for (const [property, reason] of Object.entries(properties)) {
      const reviewed = `${schema}.${property}`;
      if (!generator.absentApplied.has(reviewed)) {
        throw new Error(
          `OpenAPI translation failed at ${reviewed}: a property accepted when absent must ` +
            'exist in a response schema',
        );
      }
      notes.push(`// Response property "${reviewed}" accepted when absent: ${reason}`);
    }
  }
  const names = operations.map((o) => o.info.operationId);
  const duplicate = names.find((name, i) => names.indexOf(name) !== i);
  if (duplicate !== undefined) {
    throw new Error(`OpenAPI translation failed: two operations are named ${duplicate}`);
  }
  operations.sort((a, b) =>
    byPath
      ? a.info.key.localeCompare(b.info.key)
      : a.info.operationId.localeCompare(b.info.operationId),
  );
  return [
    `/**`,
    ` * GENERATED by ${options.generator}. Do not edit; regenerate instead.`,
    ` *`,
    ` * Source: ${options.source}`,
    ` * SHA-256: ${options.sourceSha256}`,
    ` *`,
    ` * Request schemas (…In) are strict; response schemas (…Out) strip undocumented fields.`,
    ` * Vendor descriptions and examples are not copied (ADR 0006). Security metadata is not`,
    ` * here: it is reviewed by hand in the adapter (spec §4.3).`,
    ...(options.transcription === true
      ? [
          ` *`,
          ` * The source is this project's hand transcription of a PDF contract, not a vendor`,
          ` * document (ADR 0022). Response properties that cite the PDF are optional and`,
          ` * nullable; \`versionedFields\` lists request fields that need a later application`,
          ` * version than their operation.`,
        ]
      : []),
    ` */`,
    // A transcription with every operation still pending has nothing to validate yet.
    ...(operations.length > 0 || generator.definitions().length > 0
      ? [`import * as z from 'zod';`, ``]
      : []),
    ...(generator.usesUnique
      ? [
          `const UNIQUE = 'Items must be unique.';`,
          `function unique(items: readonly unknown[]): boolean {`,
          `  return new Set(items.map((item) => JSON.stringify(item))).size === items.length;`,
          `}`,
          ``,
        ]
      : []),
    ...(generator.usesUnlisted
      ? [
          `const UNLISTED = { message: 'A documented variant must match its own schema.', abort: true };`,
          `function unlisted(values: readonly string[]): (value: string) => boolean {`,
          `  return (value) => !values.includes(value);`,
          `}`,
          ``,
        ]
      : []),
    ...generator.definitions(),
    ``,
    ...operations.map((operation) => operation.code),
    ...notes,
    ``,
    byPath
      ? `/** Every documented operation that is generated, by "<METHOD> <path>". */`
      : `/** Every documented operation that is generated, by vendor operationId. */`,
    byPath
      ? `export const OPERATIONS = { ${operations.map((o) => `${literal(o.info.key)}: ${o.info.operationId}`).join(', ')} } as const;`
      : `export const OPERATIONS = { ${operations.map((o) => o.info.operationId).join(', ')} } as const;`,
    ``,
  ].join('\n');
}
