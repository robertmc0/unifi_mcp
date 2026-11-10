/**
 * Keeps stdout for MCP protocol frames only (spec §12, §16 Phase 1 gate): every `console`
 * method writes to the given stream (stderr in the bridge) instead. This protects against
 * dependencies that print diagnostics.
 */
import { format } from 'node:util';

const METHODS = ['log', 'info', 'debug', 'warn', 'error', 'trace', 'dir'] as const;

export function redirectConsole(target: { write(text: string): unknown }): () => void {
  const original = new Map(
    METHODS.map((method) => [method, console[method].bind(console)] as const),
  );
  for (const method of METHODS) {
    console[method] = (...args: unknown[]) => {
      target.write(`${format(...args)}\n`);
    };
  }
  return () => {
    for (const [method, saved] of original) console[method] = saved;
  };
}
