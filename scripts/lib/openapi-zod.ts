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
 *   console does not break reads. Documented required properties stay required.
 *
 * Anything the translator does not understand throws, so nothing is translated silently
 * wrong. The vendor document must not contain cycles.
 */
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
]);
const STRING_FORMATS = new Set(['uuid', 'date-time', 'date']);
const INT32 = { min: -2147483648, max: 2147483647 };
const SUCCESS = /^2\d\d$/;
const COMPONENT_REF = /^#\/components\/schemas\/(.+)$/;
const OPERATION_ID = /^[a-z][A-Za-z0-9]*$/;

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
}

interface OperationInfo {
  operationId: string;
  method: string;
  path: string;
  pathParameters: string[];
  queryParameters: string[];
  hasBody: boolean;
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
    if (values.length > 0) result[keyword] = values.reduce(choose);
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

  constructor(doc: OpenApiDocument) {
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
    const keywords = Object.keys(schema).filter((keyword) => !ANNOTATIONS.has(keyword));
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

  #checkKeywords(schema: Schema, where: string): void {
    for (const keyword of Object.keys(schema)) {
      if (!ANNOTATIONS.has(keyword) && !STRUCTURAL.has(keyword)) {
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
    // Responses: an unknown discriminator value still yields the documented base fields.
    const base = this.#objectCode(this.#ownParts(name), flavour, `${name} (base)`);
    return `z.union([${[...ids, base].join(', ')}])`;
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

  #objectCode(parts: Parts, flavour: Flavour, where: string): string {
    for (const name of parts.required) {
      if (!parts.props.has(name)) fail(where, `required property ${name} is not defined`);
    }
    const fields: string[] = [];
    for (const [name, schema] of parts.props) {
      const values = parts.literals.get(name);
      if (values === undefined && this.#isUnconstrained(schema)) {
        // An undocumented shape is never accepted from a client nor passed to one.
        if (flavour === 'in') fail(`${where}.${name}`, 'unconstrained request property');
        continue;
      }
      let code =
        values === undefined
          ? this.#code(schema, flavour, `${where}.${name}`)
          : values.length === 1
            ? `z.literal(${literal(values[0] ?? '')})`
            : `z.enum([${values.map(literal).join(', ')}])`;
      if (!parts.required.has(name)) code += '.optional()';
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
    if (schema['discriminator'] !== undefined) fail(where, 'inline discriminators');
    const allOf = schema['allOf'];
    if (allOf !== undefined) {
      if (!Array.isArray(allOf)) fail(where, 'allOf is not an array');
      const structural = Object.keys(schema).filter((k) => STRUCTURAL.has(k) && k !== 'allOf');
      // `allOf: [{ $ref }]` alone only attaches annotations to a reference.
      if (allOf.length === 1 && structural.length === 0 && isObject(allOf[0])) {
        return this.#code(allOf[0], flavour, where);
      }
      return this.#objectCode(this.#partsOf(schema, where), flavour, where);
    }
    const type = schema['type'];
    switch (type) {
      case 'object':
        return this.#objectCode(this.#partsOf(schema, where), flavour, where);
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
        if (schema['uniqueItems'] === true) code += '.refine(unique, { message: UNIQUE })';
        return code;
      }
      default:
        return fail(where, `unsupported type ${JSON.stringify(type)}`);
    }
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
      default:
        code = 'z.string()';
    }
    const min = schema['minLength'];
    const max = schema['maxLength'];
    if (typeof min === 'number' && min > 0) code += `.min(${String(min)})`;
    code += `.max(${String(typeof max === 'number' ? max : DEFAULT_MAX_STRING)})`;
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
  ): { info: OperationInfo; code: string } {
    const operationId = op['operationId'];
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
    if (response['content'] === undefined) {
      // Nothing documented: whatever the console sends is discarded.
      output = 'z.unknown().transform(() => null)';
    } else {
      const content = response['content'];
      if (!isObject(content)) fail(where, 'malformed response content');
      const media = (content as Record<string, Schema | undefined>)['application/json'];
      if (Object.keys(content).length !== 1 || !isObject(media) || !isObject(media['schema'])) {
        fail(where, 'only application/json responses are supported');
      }
      output = this.#code(media['schema'], 'out', `${where} (response)`);
    }
    const info: OperationInfo = {
      operationId,
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
      `  queryParameters: [${queryParameters.map(literal).join(', ')}],`,
      `  hasBody: ${String(hasBody)},`,
      `  input: z.strictObject({ ${fields.join(', ')} }),`,
      `  output: ${output},`,
      `} as const;`,
    ].join('\n');
    return { info, code };
  }

  definitions(): readonly string[] {
    return this.#definitions;
  }
}

/** Generates the complete module source (unformatted). */
export function generateZodModule(doc: OpenApiDocument, options: GeneratorOptions): string {
  const generator = new OpenApiZodGenerator(doc);
  const targets = new Set(options.targetParameters ?? []);
  const paths = (doc as { paths?: unknown }).paths;
  if (!isObject(paths)) throw new Error('The document has no paths.');
  const operations: { info: OperationInfo; code: string }[] = [];
  for (const pathTemplate of Object.keys(paths).sort()) {
    const item = paths[pathTemplate];
    if (!isObject(item)) continue;
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!isObject(op)) continue;
      const id = typeof op['operationId'] === 'string' ? op['operationId'] : '';
      operations.push(
        generator.operation(
          pathTemplate,
          method,
          item,
          op,
          targets,
          options.omittedParameters?.[id],
        ),
      );
    }
  }
  operations.sort((a, b) => a.info.operationId.localeCompare(b.info.operationId));
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
    ` */`,
    `import * as z from 'zod';`,
    ``,
    `const UNIQUE = 'Items must be unique.';`,
    `function unique(items: readonly unknown[]): boolean {`,
    `  return new Set(items.map((item) => JSON.stringify(item))).size === items.length;`,
    `}`,
    ``,
    ...generator.definitions(),
    ``,
    ...operations.map((operation) => operation.code),
    ``,
    `/** Every documented operation, by vendor operationId. */`,
    `export const OPERATIONS = { ${operations.map((o) => o.info.operationId).join(', ')} } as const;`,
    ``,
  ].join('\n');
}
