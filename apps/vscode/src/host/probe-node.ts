import { execFile } from 'node:child_process';

/** The oldest Node that has `node:sqlite` unflagged, and so the oldest the engine host can run on. */
export const MIN_NODE = { major: 22, minor: 16 } as const;

export type NodeProbe = { readonly ok: true; readonly version: string } | { readonly ok: false; readonly reason: string };

/** What running the probe produced. Injectable, so the logic is tested without spawning anything. */
export interface ProbeRun {
  readonly spawnError?: string;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}
export type RunProbe = (command: string) => Promise<ProbeRun>;

/** Prints the Node's version, and whether it has `node:sqlite`: what the engine host needs of it. */
const SCRIPT = "let sqlite=false;try{require('node:sqlite');sqlite=true}catch{}console.log(JSON.stringify({version:process.versions.node,sqlite}))";

export const runProbe: RunProbe = (command) =>
  new Promise((resolve) => {
    execFile(command, ['-e', SCRIPT], { timeout: 10_000, windowsHide: true }, (error, stdout, stderr) => {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      resolve({
        ...(error && typeof code === 'string' ? { spawnError: code } : {}),
        status: error ? (typeof code === 'number' ? code : null) : 0,
        stdout,
        stderr,
      });
    });
  });

/** Whether `version` (`22.16.0`) is at least {@link MIN_NODE}. */
export function atLeastMinimum(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map((part) => Number.parseInt(part, 10));
  return major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor);
}

/**
 * Asks a `node` whether it can run the engine host: it starts, it is new enough, and it has `node:sqlite`.
 *
 * 🔴 The editor's own Node is not assumed. A VS Code before about 1.100 ships Node 20, which has no `node:sqlite`,
 * and a host that failed with `No such built-in module` would say nothing about what to do. This says it.
 */
export async function probeNode(command: string, run: RunProbe = runProbe): Promise<NodeProbe> {
  const result = await run(command);
  if (result.spawnError === 'ENOENT') return { ok: false, reason: `'${command}' was not found` };
  if (result.spawnError) return { ok: false, reason: `'${command}' could not be started (${result.spawnError})` };
  if (result.status !== 0) return { ok: false, reason: `'${command}' did not run as Node: ${result.stderr.trim().split('\n')[0] || `exit ${result.status}`}` };
  let report: { version?: unknown; sqlite?: unknown };
  try {
    report = JSON.parse(result.stdout) as typeof report;
  } catch {
    return { ok: false, reason: `'${command}' is not Node: it printed ${JSON.stringify(result.stdout.slice(0, 60))}` };
  }
  const version = typeof report.version === 'string' ? report.version : '';
  if (!atLeastMinimum(version)) return { ok: false, reason: `'${command}' is Node ${version || 'of an unknown version'}, and the host needs ${MIN_NODE.major}.${MIN_NODE.minor} or newer` };
  if (report.sqlite !== true) return { ok: false, reason: `'${command}' is Node ${version}, which has no node:sqlite` };
  return { ok: true, version };
}
