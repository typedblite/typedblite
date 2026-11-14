import { writeSync } from 'node:fs';
import type { SpawnSyncReturns } from 'node:child_process';

/** What a crash fixture prints just before it kills itself, so the test can see it got that far. */
export const KILL_MARKER = 'typedblite-fixture: killing myself mid-transaction';

/**
 * Kill this process abruptly, where the caller stands, after saying so.
 *
 * SIGKILL rather than `process.exit`: exit runs handlers and could let SQLite tidy up, which would
 * test a graceful close instead of a crash. On Windows, which has no signals, Node makes
 * `process.kill(pid, 'SIGKILL')` a `TerminateProcess`: just as abrupt, but reported as exit code 1
 * with no signal.
 *
 * 🔴 The marker goes straight to file descriptor 1 with `writeSync`. `process.stdout` is asynchronous
 * on a Windows pipe, and the kill would drop it.
 */
export function killSelf(): never {
  writeSync(1, `${KILL_MARKER}\n`);
  process.kill(process.pid, 'SIGKILL');
  throw new Error('process.kill(process.pid, "SIGKILL") returned');
}

type Exit = Pick<SpawnSyncReturns<string>, 'status' | 'signal' | 'stdout' | 'stderr'>;

/**
 * Why a crash fixture's child does NOT count as killed at its kill point, or undefined when it does.
 *
 * 🔴 **Exit code 1 alone proves nothing on Windows.** A killed child reports exit 1 with no signal
 * there, but so does a child that threw before it got to the kill, and a crash test passing on a
 * child that never crashed would prove nothing. So the child must also have printed the marker,
 * which it does only on its way to the kill, and written nothing to stderr, where an exception goes.
 * On POSIX the signal itself is the proof.
 */
export function notKilledOnPurpose(child: Exit, platform: NodeJS.Platform = process.platform): string | undefined {
  const how = child.signal ? `signal ${child.signal}` : `exit ${child.status}`;
  if (!child.stdout.includes(KILL_MARKER)) {
    return `the child never reached its kill point (${how}). stderr:\n${child.stderr}`;
  }
  if (withoutNodeWarnings(child.stderr).trim() !== '') return `the child wrote to stderr (${how}):\n${child.stderr}`;
  const abrupt = platform === 'win32' ? child.signal === null && child.status === 1 : child.signal === 'SIGKILL';
  return abrupt ? undefined : `the child was not killed abruptly: ${how}`;
}

/**
 * stderr without the warnings Node itself prints, which say nothing about how the child died.
 *
 * 🔴 Node 22.16, the declared minimum, prints `(node:PID) ExperimentalWarning: SQLite is an
 * experimental feature…` when a child opens `node:sqlite`; Node 24 does not. Counting it as an
 * error failed every crash test on 22.16. Only Node's own warning line and its `--trace-warnings`
 * hint are dropped: anything else, such as an exception's stack, still counts.
 */
function withoutNodeWarnings(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => !/^\(node:\d+\) \w*Warning: /.test(line) && !/^\(Use `node --trace-warnings \.\.\.` /.test(line))
    .join('\n');
}
