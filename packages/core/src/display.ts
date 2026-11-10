/**
 * Safe display of untrusted text (ADR 0015, ADR 0016).
 *
 * Text from UniFi and from MCP clients (names, request arguments, certificate subjects) is
 * shown to the human who decides whether a request runs, in the CLI and in the admin UI.
 * Characters that move the cursor, change colours, clear or rewrite lines, or reorder how
 * text is displayed are replaced with a visible `\uXXXX`: C0 controls other than newline
 * and tab, DEL, C1 controls (U+009B is an 8-bit CSI on some terminals), U+2028 and U+2029,
 * and the bidirectional formatting characters. Inside JSON strings the replacement is a
 * valid JSON escape for the same character, so JSON output stays exact.
 */
const UNSAFE =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;
const UNSAFE_ONE_LINE =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;

function visible(char: string): string {
  return `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`;
}

/** Shows unsafe characters as `\uXXXX`; keeps newlines and tabs. */
export function displaySafe(text: string): string {
  return text.replace(UNSAFE, visible);
}

/** Like `displaySafe`, and also shows newlines and tabs, for one field or table cell. */
export function displaySafeLine(text: string): string {
  return text.replace(UNSAFE_ONE_LINE, visible);
}
