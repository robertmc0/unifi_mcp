/**
 * Whether operations reviewed against an older contract revision stay valid on a newer one
 * (ADR 0019 §7). An adapter may serve a newer console with the older revision's schemas
 * only when every difference is additive:
 *
 * - **Responses**: new properties (required or not) and new enum values are fine, because
 *   the older response schemas strip unknown properties and accept unknown enum values.
 *   Removed properties, properties that are no longer required, changed types and changed
 *   unions are breaking.
 * - **Requests**: new optional properties and parameters and new enum values are fine,
 *   because a request valid under the older schema is still valid. Newly required
 *   properties or parameters, removed enum values, new constraints, removed properties and
 *   changed types are breaking.
 *
 * Schemas are compared with every `$ref` resolved and annotations dropped. Anything the
 * rules above do not cover counts as breaking, so nothing passes by omission.
 */
type Json = unknown;
type Mode = 'request' | 'response';

const ANNOTATIONS = new Set([
  'description',
  'example',
  'examples',
  'title',
  'deprecated',
  'x-enum-descriptions',
  'x-enum-varnames',
]);

interface Document {
  paths?: Record<string, Record<string, Json>>;
  components?: { schemas?: Record<string, Json> };
}

function isObject(value: Json): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The schema with every `$ref` inlined and annotations dropped. Cycles are marked. */
export function resolveSchema(doc: Document, node: Json, seen: readonly string[] = []): Json {
  if (Array.isArray(node)) return node.map((item) => resolveSchema(doc, item, seen));
  if (!isObject(node)) return node;
  const ref = node['$ref'];
  if (typeof ref === 'string') {
    const name = ref.replace('#/components/schemas/', '');
    if (seen.includes(name)) return { $recursive: name };
    return resolveSchema(doc, doc.components?.schemas?.[name], [...seen, name]);
  }
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => !ANNOTATIONS.has(key))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, resolveSchema(doc, value, seen)]),
  );
}

const same = (a: Json, b: Json): boolean => JSON.stringify(a) === JSON.stringify(b);

function strings(value: Json): string[] {
  return Array.isArray(value) ? value.map((v) => JSON.stringify(v)) : [];
}

/** Non-additive differences between two resolved schemas, as `path: what`. */
export function schemaBreaks(older: Json, newer: Json, mode: Mode, path = ''): string[] {
  if (!isObject(older) || !isObject(newer)) {
    return same(older, newer) ? [] : [`${path || '(root)'}: changed`];
  }
  const out: string[] = [];
  for (const key of new Set([...Object.keys(older), ...Object.keys(newer)])) {
    const a = older[key];
    const b = newer[key];
    const at = `${path}.${key}`;
    if (key === 'properties') {
      const before = isObject(a) ? a : {};
      const after = isObject(b) ? b : {};
      for (const name of Object.keys(before)) {
        if (!(name in after)) out.push(`${at}.${name}: removed`);
        else out.push(...schemaBreaks(before[name], after[name], mode, `${at}.${name}`));
      }
      // Added properties are additive in both directions (optional ones in requests are
      // checked through `required`).
    } else if (key === 'required') {
      const before = new Set(strings(a));
      const after = new Set(strings(b));
      if (mode === 'response') {
        for (const name of before)
          if (!after.has(name)) out.push(`${at}: ${name} no longer required`);
      } else {
        for (const name of after) if (!before.has(name)) out.push(`${at}: ${name} now required`);
      }
    } else if (key === 'enum') {
      // Responses accept unknown enum values; removed ones are never sent.
      if (mode === 'request' && a === undefined) out.push(`${at}: added`);
      else if (mode === 'request' && b !== undefined) {
        const after = new Set(strings(b));
        for (const value of strings(a)) if (!after.has(value)) out.push(`${at}: ${value} removed`);
      }
    } else if (key === 'items') {
      out.push(...schemaBreaks(a, b, mode, `${at}[]`));
    } else if ((key === 'anyOf' || key === 'oneOf' || key === 'allOf') && Array.isArray(a)) {
      // Members are compared in order; a member added, removed or moved is breaking.
      if (!Array.isArray(b) || a.length !== b.length) out.push(`${at}: members changed`);
      else
        a.forEach((member, i) =>
          out.push(...schemaBreaks(member, b[i], mode, `${at}[${String(i)}]`)),
        );
    } else if (a === undefined) {
      // A keyword only in the newer revision: a new constraint on requests is breaking.
      if (mode === 'request') out.push(`${at}: added`);
    } else if (b === undefined) {
      // A keyword dropped: a removed constraint loosens requests, but may change a response.
      if (mode === 'response') out.push(`${at}: removed`);
    } else if (isObject(a) && isObject(b)) {
      out.push(...schemaBreaks(a, b, mode, at));
    } else if (!same(a, b)) {
      out.push(`${at}: changed`);
    }
  }
  return out;
}

interface Parameter {
  in?: string;
  name?: string;
  required?: boolean;
  schema?: Json;
}

/**
 * Non-additive differences of one operation (`"<METHOD> <path>"`) between two revisions:
 * parameters, the JSON request body and the success responses.
 */
export function operationBreaks(older: Document, newer: Document, key: string): string[] {
  const [method = '', path = ''] = key.split(' ');
  const lower = method.toLowerCase();
  const a = older.paths?.[path]?.[lower];
  const b = newer.paths?.[path]?.[lower];
  if (!isObject(a)) return [`${key}: not in the older revision`];
  if (!isObject(b)) return [`${key}: removed`];
  const out: string[] = [];
  const params = (op: Record<string, Json>) =>
    new Map(
      ((op['parameters'] as Parameter[] | undefined) ?? []).map((p) => [
        `${p.in ?? ''}:${p.name ?? ''}`,
        p,
      ]),
    );
  const before = params(a);
  const after = params(b);
  for (const [id, p] of before) {
    const q = after.get(id);
    if (q === undefined) out.push(`parameter ${id}: removed`);
    else
      out.push(
        ...schemaBreaks(
          resolveSchema(older, p.schema),
          resolveSchema(newer, q.schema),
          'request',
          `parameter ${id}`,
        ),
      );
  }
  for (const [id, q] of after) {
    if (!before.has(id) && q.required === true) out.push(`parameter ${id}: new and required`);
  }
  const body = (doc: Document, op: Record<string, Json>) =>
    resolveSchema(doc, (op['requestBody'] as { content?: Json } | undefined)?.content ?? {});
  out.push(...schemaBreaks(body(older, a), body(newer, b), 'request', 'body'));
  const success = (doc: Document, op: Record<string, Json>) =>
    Object.fromEntries(
      Object.entries((op['responses'] as Record<string, { content?: Json }> | undefined) ?? {})
        .filter(([status]) => /^2\d\d$/.test(status))
        .map(([status, response]) => [status, resolveSchema(doc, response.content ?? {})]),
    );
  const okA = success(older, a);
  const okB = success(newer, b);
  if (!same(Object.keys(okA).sort(), Object.keys(okB).sort())) out.push('success statuses changed');
  for (const status of Object.keys(okA)) {
    if (status in okB)
      out.push(...schemaBreaks(okA[status], okB[status], 'response', `response ${status}`));
  }
  return out.map((line) => `${key} ${line}`);
}
