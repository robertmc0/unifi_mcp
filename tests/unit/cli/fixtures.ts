/**
 * CLI test harness: runs `unifi-mcp` commands in-process against a temporary data directory
 * and master key file, with scripted prompts and captured output.
 */
import { join } from 'node:path';
import { COMMANDS, runCli, type CliIo } from '@unifi-local-mcp/cli';
import { writeNewMasterKeyFile } from '@unifi-local-mcp/storage';

export interface CliRun {
  code: number;
  out: string;
  err: string;
}

export interface RunOptions {
  answers?: string[];
  interactive?: boolean;
  /** Environment overrides for this run only. */
  env?: NodeJS.ProcessEnv;
}

export interface CliHarness {
  dir: string;
  env: NodeJS.ProcessEnv;
  run(argv: string[], options?: RunOptions): Promise<CliRun>;
  json<T>(argv: string[]): Promise<T>;
}

export async function cliHarness(
  dir: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<CliHarness> {
  const keyFile = join(dir, 'master.key');
  await writeNewMasterKeyFile(keyFile);
  const env: NodeJS.ProcessEnv = {
    UNIFI_MCP_DATA_DIR: join(dir, 'data'),
    UNIFI_MCP_MASTER_KEY_FILE: keyFile,
    ...extraEnv,
  };
  const run = async (argv: string[], options: RunOptions = {}): Promise<CliRun> => {
    const out: string[] = [];
    const err: string[] = [];
    const answers = [...(options.answers ?? [])];
    const io: CliIo = {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      interactive: options.interactive ?? false,
      prompt: () => Promise.resolve(answers.shift() ?? ''),
      promptSecret: () => Promise.resolve(answers.shift() ?? ''),
    };
    const code = await runCli(COMMANDS, argv, io, { ...env, ...options.env });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  return {
    dir,
    env,
    run,
    json: async <T>(argv: string[]) => {
      const result = await run([...argv, '--json']);
      if (result.code !== 0) throw new Error(`${argv.join(' ')} failed: ${result.err}`);
      return JSON.parse(result.out) as T;
    },
  };
}
