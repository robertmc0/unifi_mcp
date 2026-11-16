/**
 * Static checks of a tree before it is released (spec §14; ADR 0029): the facts that
 * must agree with each other, and the pins that keep the build reproducible. Each check
 * is a pure function of file contents, so it can be tested, and returns the problems it
 * found. `scripts/verify-release.ts` runs them on the repository.
 */

export interface TreeFacts {
  rootPackage: { version: string; engines?: { node?: string } };
  /** Workspace package name → version. */
  workspaceVersions: Record<string, string>;
  /** `SERVICE_VERSION` in packages/mcp-server/src/service.ts. */
  serviceVersion: string | undefined;
  nodeVersionFile: string;
  dockerfile: string;
  changelog: string;
  /** Workflow file name → content. */
  workflows: Record<string, string>;
  trackedFiles: string[];
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** One version everywhere: the root, every workspace, and the running service. */
export function versionProblems(facts: TreeFacts, expected?: string): string[] {
  const problems: string[] = [];
  const version = facts.rootPackage.version;
  if (!SEMVER.test(version)) problems.push(`package.json version "${version}" is not SemVer.`);
  if (expected !== undefined && expected !== version) {
    problems.push(`package.json is ${version}, but ${expected} is being released.`);
  }
  for (const [name, workspace] of Object.entries(facts.workspaceVersions)) {
    if (workspace !== version) problems.push(`${name} is ${workspace}, the root is ${version}.`);
  }
  if (facts.serviceVersion !== version) {
    problems.push(
      `SERVICE_VERSION is ${facts.serviceVersion ?? 'missing'}, package.json is ${version}.`,
    );
  }
  return problems;
}

/** A released version has its own changelog section; development has "Unreleased". */
export function changelogProblems(changelog: string, version: string): string[] {
  const heading = version === '0.0.0' ? '## [Unreleased]' : `## [${version}]`;
  return changelog.split('\n').some((line) => line.startsWith(heading))
    ? []
    : [`CHANGELOG.md has no "${heading}" section.`];
}

/** The Node.js version is stated once and repeated correctly. */
export function runtimeProblems(facts: TreeFacts): string[] {
  const problems: string[] = [];
  const node = facts.nodeVersionFile.trim();
  if (!/^\d+\.\d+\.\d+$/.test(node)) problems.push('.node-version is not an exact version.');
  const base = /^ARG NODE_IMAGE=node:(\d+\.\d+\.\d+)-[a-z]+-slim@sha256:[0-9a-f]{64}$/m.exec(
    facts.dockerfile,
  );
  if (base === null) {
    problems.push(
      'The Dockerfile base image is not pinned as node:<version>-…-slim@sha256:<digest>.',
    );
  } else if (base[1] !== node) {
    problems.push(`The Dockerfile uses Node.js ${base[1] ?? ''}, .node-version says ${node}.`);
  }
  const engines = facts.rootPackage.engines?.node ?? '';
  if (!engines.includes(`>=${node}`)) {
    problems.push(`package.json engines.node ("${engines}") does not start at ${node}.`);
  }
  return problems;
}

/**
 * Every action is pinned by a full commit SHA, with the tag in a comment, and no workflow
 * asks for more than read access unless a job says so itself.
 */
export function workflowProblems(workflows: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const [name, text] of Object.entries(workflows)) {
    text.split('\n').forEach((line, index) => {
      const uses = /^\s*-?\s*uses:\s*(\S+)(.*)$/.exec(line);
      if (uses === null) return;
      const reference = uses[1] ?? '';
      if (reference.startsWith('./')) return;
      if (!/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(reference)) {
        problems.push(
          `${name}:${String(index + 1)}: "${reference}" is not pinned by a commit SHA.`,
        );
      } else if (!/#\s*v\d/.test(uses[2] ?? '')) {
        problems.push(`${name}:${String(index + 1)}: the pinned action has no version comment.`);
      }
    });
    if (!/^permissions:\n {2}contents: read$/m.test(text)) {
      problems.push(`${name}: the workflow does not default to "permissions: contents: read".`);
    }
    if (/pull_request_target/.test(text)) {
      problems.push(
        `${name}: pull_request_target runs untrusted code with secrets; do not use it.`,
      );
    }
  }
  return problems;
}

/** Nothing that must stay out of the repository is tracked. */
export function trackedFileProblems(trackedFiles: readonly string[]): string[] {
  const forbidden: [RegExp, string][] = [
    [/^api-specs\/.*\/vendor\//, 'a vendor artefact (ADR 0006)'],
    [/(^|\/)\.env(\.(?!example$)[^/]*)?$/, 'an environment file'],
    [/\.(pem|key|crt|p12|pfx)$/, 'a key or certificate'],
    [/\.(db|sqlite|sqlite3)(-wal|-shm|-journal)?$/, 'a database'],
    [/(^|\/)(secrets|data)\//, 'a secrets or data directory'],
    [/(^|\/)node_modules\//, 'installed dependencies'],
  ];
  const problems: string[] = [];
  for (const file of trackedFiles) {
    for (const [pattern, what] of forbidden) {
      if (pattern.test(file)) problems.push(`${file} is tracked: ${what}.`);
    }
  }
  for (const required of [
    'LICENSE',
    'NOTICE',
    'SECURITY.md',
    'CHANGELOG.md',
    'package-lock.json',
  ]) {
    if (!trackedFiles.includes(required)) problems.push(`${required} is missing.`);
  }
  return problems;
}
