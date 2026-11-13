/**
 * Checks this project's hand transcription of the UniFi Access API reference PDF
 * (`api-specs/access/<revision>/transcription.json`, ADR 0022).
 *
 * - `structuralProblems` runs offline: the document's shape, every PDF citation, the
 *   operation set against `operations.json`, the response envelope, no vendor prose, and no
 *   field taken from a sample in a request.
 * - `pdfProblems` compares the transcription with the text of the pinned PDF in both
 *   directions: every citation matches a table row (or a sample) on its page, and every
 *   table row on a transcribed page is transcribed or declined with a reason.
 *
 * Both return problems as sentences; an empty list means the check passed.
 */
import type { InventoryOperation } from './api-specs.ts';
import type { PdfPages } from './pdf-text.ts';

type Schema = Record<string, unknown>;

/** Where a transcribed element comes from (ADR 0022 §2). */
export interface PdfCitation {
  page: number;
  /** The row's label as printed, when it differs from the element's name. */
  row?: string;
  /** The field appears only in a response sample. */
  sample?: true;
  /** No row of its own: its fields' rows are printed under its name (`plates[].id`). */
  parent?: true;
}

/** A parameter, body, response `data` or property that cites the PDF. */
export interface TranscribedElement {
  where: string;
  /** The element's name; the row label unless the citation gives another. */
  name: string;
  pdf: PdfCitation;
  schema: Schema;
  required: boolean;
  minimumVersion?: string;
  /** The page that states the version, when only the change log (§13) does. */
  minimumVersionPage?: number;
  /** Reached from a request (inline, or through a component a request uses). */
  inRequest: boolean;
}

/** A field-table row detected in the PDF text: a label directly followed by flag and type. */
export interface TableRow {
  page: number;
  label: string;
  /** The required column (`T`/`F`), empty in tables without one. */
  flag: '' | 'T' | 'F';
  type: string;
}

export interface DeclinedRow {
  row: string;
  /** Absent: the row is declined on every page (the request header `Authorization`). */
  page?: number;
  reason: string;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const SUCCESS = /^2\d\d$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const ERROR_CODE = /^CODE_[A-Z0-9_]+$/;
const COMPONENT_REF = /^#\/components\/schemas\/(.+)$/;
/** Keys that would carry vendor prose; the transcription holds facts only (ADR 0022 §1). */
const PROSE_KEYS = new Set(['description', 'example', 'examples', 'summary', 'title']);
const ENVELOPE = new Set(['data', 'pagination']);
/**
 * A table row: an optional label, the required flag, and a type. A label may contain
 * `[]`, `[0]` and dots (`resources[0].id`, `Array[Object].user_id`); a type is never
 * followed by `.`, `[`, `]` or `_`, which would make it part of a label.
 */
const ROW =
  /^((?:[A-Za-z_][A-Za-z0-9_.[\]]*?|-)??)(T|F)?(String|Integer|Int(?![a-z])|Number|Boolean|Object(?! ?[(<])|Array of Strings|Array\[[A-Za-z]+\]|Array(?![[a-z])|File)(?![.[\]_])/;
/** The one lower-case type name in the PDF (`expand[]Fstring`), only after a flag. */
const LOWER_CASE_STRING = /^([A-Za-z_][A-Za-z0-9_.[\]]*?)(T|F)string(?![a-z])/;
/** A label and flag alone on a line, when the type is printed on the following lines. */
const SPLIT_LABEL = /^([A-Za-z_][A-Za-z0-9_.[\]]*|-)(T|F)$/;
/** Types printed over several lines, or as a phrase (`Object (Map)`, `Array of Strings`). */
const SPLIT_TYPE = /^(Array of Strings|Object \(Map\)|Object<String, String>)/;
/** Type phrases, as the canonical names a transcribed schema is compared with. */
const TYPE_NAMES: Record<string, string> = {
  'Array of Strings': 'Array[String]',
  'Object (Map)': 'Map',
  'Object<String, String>': 'Map',
};

function isObject(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pageText(pages: PdfPages, page: number): string {
  return (pages[page - 1] ?? []).join('\n');
}

/**
 * Detects field-table rows on every page. A row without a label needs a required flag; a
 * label printed as `-` is no label (the row types the whole body). Type phrases become the
 * canonical names `Array[String]` and `Map`; a type printed below its label and flag
 * (`idsT`, then `Array of`, `Strings`) is joined to them.
 */
export function detectTableRows(pages: PdfPages): TableRow[] {
  const rows: TableRow[] = [];
  pages.forEach((lines, index) => {
    lines.forEach((line, i) => {
      let label: string;
      let flag: string;
      let type: string;
      const match = ROW.exec(line);
      const lower = match === null ? LOWER_CASE_STRING.exec(line) : null;
      const split = match === null && lower === null ? SPLIT_LABEL.exec(line) : null;
      if (match !== null) {
        [label, flag, type] = [match[1] ?? '', match[2] ?? '', match[3] ?? ''];
      } else if (lower !== null) {
        [label, flag, type] = [lower[1] ?? '', lower[2] ?? '', 'String'];
      } else if (split !== null) {
        const next = SPLIT_TYPE.exec(`${lines[i + 1] ?? ''} ${lines[i + 2] ?? ''}`);
        if (next === null) return;
        [label, flag, type] = [split[1] ?? '', split[2] ?? '', next[1] ?? ''];
      } else {
        return;
      }
      if (label === '-') label = '';
      if (label === '' && flag === '') return;
      rows.push({
        page: index + 1,
        label,
        flag: flag as TableRow['flag'],
        type: TYPE_NAMES[type] ?? type,
      });
    });
  });
  return rows;
}

/** The error codes printed anywhere in the PDF (§2.4 lists them, glued to their message). */
export function errorCodesIn(pages: PdfPages): string[] {
  const codes = new Set<string>();
  for (const lines of pages) {
    for (const match of lines.join('\n').matchAll(/\bCODE_[A-Z0-9_]+?(?=[A-Z][a-z]|\s|$)/g)) {
      codes.add(match[0]);
    }
  }
  return [...codes].sort();
}

interface Walk {
  components: Record<string, Schema>;
  elements: TranscribedElement[];
  problems: string[];
  /** Every `x-pdf` value consumed by an element, to find misplaced ones. */
  cited: Set<unknown>;
}

function citation(walk: Walk, value: unknown, where: string): PdfCitation | undefined {
  if (value === undefined) {
    walk.problems.push(`${where}: no x-pdf citation.`);
    return undefined;
  }
  walk.cited.add(value);
  if (!isObject(value)) {
    walk.problems.push(`${where}: x-pdf is not an object.`);
    return undefined;
  }
  const extra = Object.keys(value).filter(
    (k) => k !== 'page' && k !== 'row' && k !== 'sample' && k !== 'parent',
  );
  const page = value['page'];
  const row = value['row'];
  const sample = value['sample'];
  const parent = value['parent'];
  if (
    extra.length > 0 ||
    typeof page !== 'number' ||
    !Number.isInteger(page) ||
    page < 1 ||
    (row !== undefined && typeof row !== 'string') ||
    (sample !== undefined && sample !== true) ||
    (parent !== undefined && parent !== true) ||
    (sample === true && (row !== undefined || parent === true))
  ) {
    walk.problems.push(`${where}: malformed x-pdf ${JSON.stringify(value)}.`);
    return undefined;
  }
  return {
    page,
    ...(typeof row === 'string' ? { row } : {}),
    ...(sample === true ? { sample: true as const } : {}),
    ...(parent === true ? { parent: true as const } : {}),
  };
}

function minimumVersion(walk: Walk, holder: Schema, where: string): string | undefined {
  const value = holder['x-minimum-version'];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !VERSION.test(value)) {
    walk.problems.push(`${where}: x-minimum-version ${JSON.stringify(value)} is not a version.`);
    return undefined;
  }
  return value;
}

/** `x-minimum-version-source`: `{ "page": n }`, the change-log page that states the version. */
function minimumVersionPage(walk: Walk, holder: Schema, where: string): number | undefined {
  const value = holder['x-minimum-version-source'];
  if (value === undefined) return undefined;
  const page = isObject(value) ? value['page'] : undefined;
  if (
    !isObject(value) ||
    Object.keys(value).length !== 1 ||
    typeof page !== 'number' ||
    !Number.isInteger(page) ||
    page < 1 ||
    holder['x-minimum-version'] === undefined
  ) {
    walk.problems.push(`${where}: malformed x-minimum-version-source ${JSON.stringify(value)}.`);
    return undefined;
  }
  return page;
}

function addElement(
  walk: Walk,
  holder: Schema,
  where: string,
  name: string,
  schema: Schema,
  required: boolean,
  inRequest: boolean,
): void {
  const pdf = citation(walk, holder['x-pdf'], where);
  const version = minimumVersion(walk, holder, where);
  const versionPage = minimumVersionPage(walk, holder, where);
  if (pdf === undefined) return;
  walk.elements.push({
    where,
    name,
    pdf,
    schema,
    required,
    inRequest,
    ...(version === undefined ? {} : { minimumVersion: version }),
    ...(versionPage === undefined ? {} : { minimumVersionPage: versionPage }),
  });
}

/** Properties below `schema` (not through references: components are walked once). */
function walkSchema(walk: Walk, schema: unknown, where: string, inRequest: boolean): void {
  if (!isObject(schema) || schema['$ref'] !== undefined) return;
  const properties = schema['properties'];
  const required = Array.isArray(schema['required']) ? (schema['required'] as unknown[]) : [];
  if (isObject(properties)) {
    for (const [name, property] of Object.entries(properties)) {
      const at = `${where}.${name}`;
      if (!isObject(property)) {
        walk.problems.push(`${at}: not a schema.`);
        continue;
      }
      addElement(walk, property, at, name, property, required.includes(name), inRequest);
      walkSchema(walk, property, at, inRequest);
    }
  }
  walkSchema(walk, schema['items'], `${where}[]`, inRequest);
  for (const keyword of ['allOf', 'oneOf', 'anyOf']) {
    const members = schema[keyword];
    if (Array.isArray(members)) for (const m of members) walkSchema(walk, m, where, inRequest);
  }
}

/** Names of the components `schema` uses, transitively. */
function referencedComponents(walk: Walk, schema: unknown, into: Set<string>): void {
  if (Array.isArray(schema)) {
    for (const item of schema) referencedComponents(walk, item, into);
    return;
  }
  if (!isObject(schema)) return;
  const ref = schema['$ref'];
  if (typeof ref === 'string') {
    const name = COMPONENT_REF.exec(ref)?.[1];
    if (name === undefined || walk.components[name] === undefined) {
      walk.problems.push(`unknown reference ${ref}.`);
    } else if (!into.has(name)) {
      into.add(name);
      referencedComponents(walk, walk.components[name], into);
    }
  }
  for (const [key, value] of Object.entries(schema)) {
    if (key !== '$ref' && key !== 'x-pdf') referencedComponents(walk, value, into);
  }
}

function mediaSchema(content: unknown): { type: string; schema: unknown } | undefined {
  if (!isObject(content)) return undefined;
  const types = Object.keys(content);
  const type = types[0];
  if (types.length !== 1 || type === undefined) return undefined;
  const media = content[type];
  return { type, schema: isObject(media) ? media['schema'] : undefined };
}

function walkOperation(walk: Walk, key: string, op: Schema, requestComponents: Set<string>): void {
  const parameters = Array.isArray(op['parameters']) ? (op['parameters'] as unknown[]) : [];
  for (const parameter of parameters) {
    if (!isObject(parameter)) {
      walk.problems.push(`${key}: a parameter is not an object.`);
      continue;
    }
    const name = String(parameter['name']);
    const at = `${key} ${String(parameter['in'])} ${name}`;
    const schema = isObject(parameter['schema']) ? parameter['schema'] : {};
    addElement(walk, parameter, at, name, schema, parameter['required'] === true, true);
    walkSchema(walk, schema, at, true);
    referencedComponents(walk, schema, requestComponents);
  }
  const body = op['requestBody'];
  if (isObject(body)) {
    const media = mediaSchema(body['content']);
    if (media === undefined || !isObject(media.schema)) {
      walk.problems.push(`${key}: the request body needs exactly one media type with a schema.`);
    } else {
      const at = `${key} body`;
      if (body['x-pdf'] !== undefined) {
        addElement(walk, body, at, '', media.schema, body['required'] === true, true);
      } else if (media.schema['type'] !== 'object') {
        walk.problems.push(`${at}: a body that is not an object must cite its row.`);
      }
      walkSchema(walk, media.schema, at, true);
      referencedComponents(walk, media.schema, requestComponents);
    }
  }
  const responses = isObject(op['responses']) ? op['responses'] : {};
  const success = Object.entries(responses).filter(([status]) => SUCCESS.test(status));
  if (success.length !== 1) {
    walk.problems.push(`${key}: exactly one success response is needed.`);
    return;
  }
  const response = success[0]?.[1];
  if (!isObject(response)) return;
  if (response['content'] === undefined) {
    if (response['x-pdf'] !== undefined) walk.problems.push(`${key}: x-pdf without data.`);
    return;
  }
  const media = mediaSchema(response['content']);
  if (media === undefined) {
    walk.problems.push(`${key}: the response needs exactly one media type.`);
    return;
  }
  if (media.type !== 'application/json') return;
  // The envelope without code and msg (ADR 0022 §4): data, pagination, and siblings of
  // data that a sample shows (§9.2's page and total).
  const envelope = media.schema;
  const properties = isObject(envelope) ? envelope['properties'] : undefined;
  const required = isObject(envelope) ? envelope['required'] : undefined;
  const sampled = (schema: unknown): boolean =>
    isObject(schema) && isObject(schema['x-pdf']) && schema['x-pdf']['sample'] === true;
  if (
    !isObject(envelope) ||
    envelope['type'] !== 'object' ||
    !isObject(properties) ||
    !Object.entries(properties).every(([name, schema]) => ENVELOPE.has(name) || sampled(schema)) ||
    !Array.isArray(required) ||
    !required.includes('data')
  ) {
    walk.problems.push(
      `${key}: the response is not the envelope {data, pagination?, sampled siblings}.`,
    );
    return;
  }
  for (const [name, schema] of Object.entries(properties)) {
    const at = `${key} ${name}`;
    if (!isObject(schema)) continue;
    if (ENVELOPE.has(name) && schema['x-pdf'] !== undefined) {
      walk.problems.push(`${at}: an envelope property cites its row on the response instead.`);
    }
    if (name === 'data' && response['x-pdf'] !== undefined) {
      addElement(walk, response, at, 'data', schema, true, false);
    }
    if (!ENVELOPE.has(name)) {
      addElement(walk, schema, at, name, schema, false, false);
    }
    walkSchema(walk, schema, at, false);
  }
}

/** Every `x-pdf` value in the document, with where it was found. */
function allCitations(value: unknown, where: string, out: Map<unknown, string>): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      allCitations(item, `${where}[${String(i)}]`, out);
    });
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'x-pdf') out.set(child, where);
    else allCitations(child, `${where}.${key}`, out);
  }
}

function proseKeys(value: unknown, where: string, out: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      proseKeys(item, `${where}[${String(i)}]`, out);
    });
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    // `info.title` names this transcription; a property may be called "description".
    const isProperty = where.endsWith('.properties');
    if (PROSE_KEYS.has(key) && !(where === 'info' && key === 'title') && !isProperty) {
      out.push(`${where}.${key}`);
    }
    proseKeys(child, where === '' ? key : `${where}.${key}`, out);
  }
}

/** The operations of a transcription, by `"<METHOD> <path>"`. */
export function transcribedOperations(doc: Schema): Map<string, Schema> {
  const out = new Map<string, Schema>();
  const paths = isObject(doc['paths']) ? doc['paths'] : {};
  for (const [path, item] of Object.entries(paths)) {
    if (!isObject(item)) continue;
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (isObject(op)) out.set(`${method.toUpperCase()} ${path}`, op);
    }
  }
  return out;
}

/** The cited elements of a transcription, with the problems found while collecting them. */
export function collectElements(doc: Schema): {
  elements: TranscribedElement[];
  problems: string[];
} {
  const components = isObject(doc['components']) ? doc['components']['schemas'] : undefined;
  const walk: Walk = {
    components: isObject(components) ? (components as Record<string, Schema>) : {},
    elements: [],
    problems: [],
    cited: new Set(),
  };
  const requestComponents = new Set<string>();
  for (const [key, op] of transcribedOperations(doc)) {
    walkOperation(walk, key, op, requestComponents);
  }
  for (const [name, schema] of Object.entries(walk.components)) {
    const start = walk.elements.length;
    walkSchema(walk, schema, `components.${name}`, false);
    if (requestComponents.has(name)) {
      for (const element of walk.elements.slice(start)) element.inRequest = true;
    }
  }
  const found = new Map<unknown, string>();
  allCitations(doc, '', found);
  for (const [value, where] of found) {
    if (!walk.cited.has(value)) walk.problems.push(`${where}: x-pdf in a place that cannot cite.`);
  }
  for (const element of walk.elements) {
    if (element.inRequest && element.pdf.sample === true) {
      walk.problems.push(
        `${element.where}: a request field cannot come from a sample (ADR 0022 §3).`,
      );
    }
  }
  return { elements: walk.elements, problems: walk.problems };
}

function pageRanges(doc: Schema, problems: string[]): [number, number][] {
  const ranges = doc['x-pdf-pages'];
  if (!Array.isArray(ranges)) {
    problems.push('x-pdf-pages is not a list of page ranges.');
    return [];
  }
  const out: [number, number][] = [];
  for (const range of ranges) {
    const [from, to] = Array.isArray(range) ? (range as unknown[]) : [];
    if (
      !Array.isArray(range) ||
      range.length !== 2 ||
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      (from as number) < 1 ||
      (from as number) > (to as number)
    ) {
      problems.push(`x-pdf-pages: ${JSON.stringify(range)} is not a page range [from, to].`);
      continue;
    }
    out.push([from as number, to as number]);
  }
  return out;
}

function covered(ranges: readonly [number, number][], page: number): boolean {
  return ranges.some(([from, to]) => page >= from && page <= to);
}

function declinedRows(doc: Schema, problems: string[]): DeclinedRow[] {
  const list = doc['x-declined'];
  if (!Array.isArray(list)) {
    problems.push('x-declined is not a list.');
    return [];
  }
  const out: DeclinedRow[] = [];
  for (const entry of list) {
    const ok =
      isObject(entry) &&
      typeof entry['row'] === 'string' &&
      typeof entry['reason'] === 'string' &&
      entry['reason'].trim() !== '' &&
      (entry['page'] === undefined ||
        (Number.isInteger(entry['page']) && (entry['page'] as number) >= 1)) &&
      Object.keys(entry).every((k) => k === 'row' || k === 'page' || k === 'reason');
    if (!ok) {
      problems.push(`x-declined: malformed entry ${JSON.stringify(entry)}.`);
      continue;
    }
    out.push({
      row: entry['row'] as string,
      reason: entry['reason'] as string,
      ...(entry['page'] === undefined ? {} : { page: entry['page'] as number }),
    });
  }
  return out;
}

/** Offline checks (ADR 0022 §1–§4, §7). */
export function structuralProblems(
  doc: Schema,
  inventory: readonly InventoryOperation[],
  contract: { name: string; sha256: string },
): string[] {
  const problems: string[] = [];
  if (typeof doc['openapi'] !== 'string' || !doc['openapi'].startsWith('3.1.')) {
    problems.push('openapi must be 3.1.x.');
  }
  const from = doc['x-transcribed-from'];
  if (!isObject(from) || from['artifact'] !== contract.name || from['sha256'] !== contract.sha256) {
    problems.push(
      `x-transcribed-from must name ${contract.name} with SHA-256 ${contract.sha256} ` +
        '(a changed PDF needs a new review).',
    );
  }
  const codes = doc['x-error-codes'];
  if (
    !Array.isArray(codes) ||
    !codes.every((c) => typeof c === 'string' && ERROR_CODE.test(c)) ||
    new Set(codes).size !== codes.length
  ) {
    problems.push('x-error-codes must be a list of distinct CODE_… strings.');
  }
  const ranges = pageRanges(doc, problems);
  declinedRows(doc, problems);

  const expected = new Set(inventory.map((op) => op.key));
  const transcribed = new Set(transcribedOperations(doc).keys());
  const pendingList = doc['x-pending'];
  const pending = Array.isArray(pendingList) ? pendingList : [];
  if (!Array.isArray(pendingList) || !pending.every((k) => typeof k === 'string')) {
    problems.push('x-pending is not a list of operation keys.');
  }
  if (new Set(pending).size !== pending.length) problems.push('x-pending lists a key twice.');
  for (const key of pending as string[]) {
    if (transcribed.has(key)) problems.push(`${key}: both transcribed and pending.`);
    if (!expected.has(key)) problems.push(`${key}: pending but not in operations.json.`);
  }
  for (const key of transcribed) {
    if (!expected.has(key)) problems.push(`${key}: transcribed but not in operations.json.`);
  }
  for (const key of expected) {
    if (!transcribed.has(key) && !(pending as string[]).includes(key)) {
      problems.push(`${key}: in operations.json but neither transcribed nor pending.`);
    }
  }

  const prose: string[] = [];
  proseKeys(doc, '', prose);
  for (const where of prose) problems.push(`${where}: vendor prose is not transcribed.`);

  const { elements, problems: walkProblems } = collectElements(doc);
  problems.push(...walkProblems);
  for (const element of elements) {
    // Samples take no part in the reverse check, so only rows must be on transcribed pages.
    if (element.pdf.sample !== true && !covered(ranges, element.pdf.page)) {
      problems.push(`${element.where}: cites p.${String(element.pdf.page)}, outside x-pdf-pages.`);
    }
  }
  return problems;
}

function resolve(schema: Schema, components: Record<string, Schema>): Schema {
  let current = schema;
  for (let depth = 0; depth < 16; depth++) {
    const ref = current['$ref'];
    const name = typeof ref === 'string' ? COMPONENT_REF.exec(ref)?.[1] : undefined;
    const target = name === undefined ? undefined : components[name];
    if (target === undefined) return current;
    current = target;
  }
  return current;
}

function baseType(schema: Schema): unknown {
  const type = schema['type'];
  if (Array.isArray(type)) return type.find((t) => t !== 'null');
  if (type === undefined && isObject(schema['properties'])) return 'object';
  return type;
}

const SCALAR_TYPES: Record<string, readonly string[]> = {
  string: ['String'],
  integer: ['Integer', 'Int'],
  number: ['Number'],
  boolean: ['Boolean'],
  object: ['Object'],
};

/** The PDF type names a transcribed schema may be printed as (ADR 0022 §3). */
export function pdfTypes(schema: Schema, components: Record<string, Schema>): readonly string[] {
  const resolved = resolve(schema, components);
  const type = baseType(resolved);
  if (type === 'string' && resolved['format'] === 'binary') return ['File'];
  if (type === 'array' && isObject(resolved['items'])) {
    const items = resolve(resolved['items'], components);
    const itemType = baseType(items);
    if (itemType === 'object') return ['Array[Object]', 'Array[object]', 'Array'];
    const names = typeof itemType === 'string' ? (SCALAR_TYPES[itemType] ?? []) : [];
    return [...names.map((name) => `Array[${name}]`), 'Array'];
  }
  if (type === 'object' && isObject(resolved['additionalProperties'])) return ['Map'];
  return typeof type === 'string' ? (SCALAR_TYPES[type] ?? []) : [];
}

function enumValues(schema: Schema, components: Record<string, Schema>): unknown[] {
  const resolved = resolve(schema, components);
  const own: unknown[] = Array.isArray(resolved['enum']) ? (resolved['enum'] as unknown[]) : [];
  const items = isObject(resolved['items']) ? resolve(resolved['items'], components) : {};
  const ofItems: unknown[] = Array.isArray(items['enum']) ? (items['enum'] as unknown[]) : [];
  return [...own, ...ofItems];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Checks each inventory operation's method, path and permission against its page. */
function operationProblems(pages: PdfPages, inventory: readonly InventoryOperation[]): string[] {
  const problems: string[] = [];
  const flat = (page: number): string => pageText(pages, page).replace(/\s+/g, '');
  for (const op of inventory) {
    const page = Number(/p\.(\d+)/.exec(op.sourceRef ?? '')?.[1]);
    if (!Number.isInteger(page)) {
      problems.push(`${op.key}: sourceRef names no page.`);
      continue;
    }
    // The method and permission lines follow the URL, sometimes on the next page and with
    // a sample printed in between; the window ends at the next operation's URL.
    const text = flat(page) + flat(page + 1);
    const path = (op.documentedPath ?? op.path).replace(/\{([^}]+)\}/g, ':$1');
    const url = new RegExp(`RequestURL:${escapeRegExp(path)}(?![a-z0-9_/:])`, 'g');
    const found = [...text.matchAll(url)].some((match) => {
      const start = match.index + match[0].length;
      const next = text.indexOf('RequestURL:', start);
      const window = text.slice(start, next < 0 ? undefined : next);
      return (
        window.includes(`Method:${op.method}`) &&
        (op.vendorPermission === undefined ||
          window.includes(`PermissionKey:${op.vendorPermission}`))
      );
    });
    if (!found) {
      problems.push(
        `${op.key}: no "Request URL: ${path}" with its method and permission on ` +
          `p.${String(page)}–${String(page + 1)}.`,
      );
    }
  }
  return problems;
}

/** Checks the transcription against the text of the pinned PDF (ADR 0022 §6). */
export function pdfProblems(
  doc: Schema,
  pages: PdfPages,
  inventory: readonly InventoryOperation[],
): string[] {
  const problems = operationProblems(pages, inventory);
  const components = isObject(doc['components']) ? doc['components']['schemas'] : undefined;
  const schemas = isObject(components) ? (components as Record<string, Schema>) : {};

  const listed = Array.isArray(doc['x-error-codes']) ? (doc['x-error-codes'] as unknown[]) : [];
  const printed = errorCodesIn(pages);
  for (const code of printed) {
    if (!listed.includes(code)) problems.push(`${code}: printed in the PDF, not in x-error-codes.`);
  }
  for (const code of listed) {
    if (!printed.includes(code as string)) {
      problems.push(`${String(code)}: in x-error-codes, not printed in the PDF.`);
    }
  }

  const rows = detectTableRows(pages);
  const { elements } = collectElements(doc);
  const claims = new Set<string>();
  for (const element of elements) {
    const { page } = element.pdf;
    const text = pageText(pages, page);
    if (element.pdf.sample === true) {
      if (!new RegExp(`"${escapeRegExp(element.name)}"\\s*:`).test(text)) {
        problems.push(
          `${element.where}: "${element.name}" is not in a sample on p.${String(page)}.`,
        );
      }
    } else if (element.pdf.parent === true) {
      const label = element.pdf.row ?? element.name;
      const type = baseType(resolve(element.schema, schemas));
      const child = new RegExp(`^${escapeRegExp(label)}${type === 'array' ? '\\[\\d*\\]' : ''}\\.`);
      if (
        (type !== 'array' && type !== 'object') ||
        !rows.some((row) => row.page === page && child.test(row.label))
      ) {
        problems.push(
          `${element.where}: no rows of fields under "${label}" on p.${String(page)} ` +
            `(as ${type === 'array' ? `${label}[].…` : `${label}.…`}).`,
        );
      }
    } else {
      const label = element.pdf.row ?? element.name;
      claims.add(`${String(page)}\u0000${label}`);
      const candidates = rows.filter((row) => row.page === page && row.label === label);
      const types = pdfTypes(element.schema, schemas);
      const typed = candidates.filter((row) => types.includes(row.type));
      const flagged = typed.filter((row) =>
        row.flag === '' ? !element.required : (row.flag === 'T') === element.required,
      );
      if (candidates.length === 0) {
        problems.push(`${element.where}: no table row "${label}" on p.${String(page)}.`);
      } else if (typed.length === 0) {
        problems.push(
          `${element.where}: row "${label}" on p.${String(page)} has type ` +
            `${candidates.map((row) => row.type).join('/')}, transcribed as ` +
            `${types.join('/') || 'an unmappable type'}.`,
        );
      } else if (flagged.length === 0) {
        problems.push(
          `${element.where}: row "${label}" on p.${String(page)} is marked ` +
            `${typed.map((row) => row.flag || 'without a flag').join('/')}, transcribed as ` +
            `${element.required ? 'required' : 'optional'}.`,
        );
      }
    }
    for (const value of enumValues(element.schema, schemas)) {
      if (
        (typeof value !== 'string' && typeof value !== 'number') ||
        !text.includes(String(value))
      ) {
        problems.push(
          `${element.where}: enum value ${JSON.stringify(value)} not on p.${String(page)}.`,
        );
      }
    }
    if (element.minimumVersion !== undefined) {
      // A requirement is printed once, beside the field's row in one table (the schema's,
      // for instance); a request table of the same field may not repeat it.
      const label = element.pdf.row ?? element.name;
      const same = rows.filter((row) => row.label === label).map((row) => row.page);
      const source = element.minimumVersionPage;
      const searched = source === undefined ? [page, page + 1, ...same] : [source, source + 1];
      const near = searched.map((p) => pageText(pages, p)).join('\n');
      if (!near.includes(element.minimumVersion)) {
        problems.push(
          `${element.where}: minimum version ${element.minimumVersion} not on ` +
            (source === undefined
              ? `p.${String(page)}–${String(page + 1)} or beside another "${label}" row.`
              : `its source p.${String(source)}–${String(source + 1)}.`),
        );
      }
    }
  }

  const ranges = pageRanges(doc, []);
  const declined = declinedRows(doc, []);
  for (const entry of declined) {
    const matches = rows.some(
      (row) => row.label === entry.row && (entry.page === undefined || row.page === entry.page),
    );
    if (!matches) {
      problems.push(
        `x-declined: no table row "${entry.row}"` +
          `${entry.page === undefined ? '' : ` on p.${String(entry.page)}`}.`,
      );
    }
  }
  for (const row of rows) {
    if (!covered(ranges, row.page)) continue;
    const claimed =
      claims.has(`${String(row.page)}\u0000${row.label}`) ||
      declined.some(
        (entry) => entry.row === row.label && (entry.page === undefined || entry.page === row.page),
      );
    if (!claimed) {
      problems.push(
        `p.${String(row.page)}: table row "${row.label}" (${row.flag}${row.type}) is neither ` +
          'transcribed nor declined.',
      );
    }
  }
  return problems;
}
