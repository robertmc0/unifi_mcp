/**
 * Removes named properties at any depth (spec §6.4). Adapters use it to keep credentials
 * out of results after every projection, whatever the nesting: each adapter names its
 * own fields (ADR 0018 §4, ADR 0019).
 */
export function withoutFields(value: unknown, names: ReadonlySet<string>): unknown {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (node === null || typeof node !== 'object' || node instanceof Uint8Array) return node;
    return Object.fromEntries(
      Object.entries(node).flatMap(([key, child]) => (names.has(key) ? [] : [[key, strip(child)]])),
    );
  };
  return strip(value);
}
