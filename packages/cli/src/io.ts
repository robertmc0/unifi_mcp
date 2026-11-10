/**
 * Terminal input and output for the CLI. Human output goes to stdout, diagnostics to stderr.
 * Secrets (passwords, API keys) are read only from a terminal without echo, or from files,
 * never from command-line arguments, which would expose them in the process list and shell
 * history.
 */
export class CliError extends Error {
  override readonly name = 'CliError';
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

// C0 controls other than tab and newline, DEL, C1 controls (U+009B is an 8-bit CSI on some
// terminals), line and paragraph separators, and bidirectional formatting characters, which
// can reorder how text is displayed.
const UNSAFE =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;
const UNSAFE_ONE_LINE =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;

function escape(char: string): string {
  return `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`;
}

/**
 * Makes text safe to print on a terminal: characters that could move the cursor, change
 * colours, rewrite or reorder what the operator sees are shown as `\uXXXX`. Text from UniFi
 * and from MCP clients (names, arguments, certificate subjects) is untrusted, and the
 * approval prompt must show exactly what will run. Inside JSON strings the replacement is a
 * valid JSON escape for the same character, so `--json` output stays exact.
 */
export function terminalSafe(text: string): string {
  return text.replace(UNSAFE, escape);
}

/** Like `terminalSafe`, and also escapes newlines and tabs: for one table cell or field. */
export function oneLine(text: string): string {
  return text.replace(UNSAFE_ONE_LINE, escape);
}

/** Wraps an IO so that every line and prompt passes through `terminalSafe`. */
export function safeIo(io: CliIo): CliIo {
  return {
    out: (line) => {
      io.out(terminalSafe(line));
    },
    err: (line) => {
      io.err(terminalSafe(line));
    },
    interactive: io.interactive,
    prompt: (question) => io.prompt(terminalSafe(question)),
    promptSecret: (question) => io.promptSecret(terminalSafe(question)),
  };
}

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  /** True when stdin and stderr are a terminal (prompts possible). */
  readonly interactive: boolean;
  prompt(question: string): Promise<string>;
  promptSecret(question: string): Promise<string>;
}

function readLine(question: string, hidden: boolean): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return Promise.reject(new CliError('This command needs an interactive terminal.'));
  }
  process.stderr.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error?: Error): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
      if (error === undefined) resolve(value);
      else reject(error);
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          finish();
          return;
        }
        if (char === '\u0003' || char === '\u0004') {
          finish(new CliError('Cancelled.'));
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          if (!hidden) process.stderr.write('\b \b');
          continue;
        }
        value += char;
        if (!hidden) process.stderr.write(char);
      }
    };
    stdin.on('data', onData);
  });
}

export function processIo(): CliIo {
  return {
    out: (line) => {
      process.stdout.write(`${line}\n`);
    },
    err: (line) => {
      process.stderr.write(`${line}\n`);
    },
    interactive: process.stdin.isTTY && process.stderr.isTTY,
    prompt: (question) => readLine(question, false),
    promptSecret: (question) => readLine(question, true),
  };
}
