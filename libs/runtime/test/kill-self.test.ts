import { describe, expect, it } from 'vitest';
import { KILL_MARKER, notKilledOnPurpose } from './fixtures/kill-self.js';

/**
 * The crash tests' proof that a child really died at its kill point. A crash test that passed on a
 * child which never crashed would prove nothing about durability, so this is pinned for both kinds of
 * platform. Windows is simulated here: there, a killed process exits 1 with no signal.
 */
describe('telling a deliberate kill from any other exit', () => {
  const marker = `${KILL_MARKER}\n`;

  it('accepts SIGKILL after the marker on POSIX', () => {
    expect(notKilledOnPurpose({ signal: 'SIGKILL', status: null, stdout: marker, stderr: '' }, 'linux')).toBeUndefined();
  });

  it('accepts exit 1, no signal, after the marker and with a silent stderr on Windows', () => {
    expect(notKilledOnPurpose({ signal: null, status: 1, stdout: marker, stderr: '' }, 'win32')).toBeUndefined();
  });

  it('refuses an exception, which also exits 1 with no signal on Windows', () => {
    const thrown = { signal: null, status: 1, stdout: '', stderr: 'Error: no such table: thing\n    at …' };
    expect(notKilledOnPurpose(thrown, 'win32')).toMatch(/never reached its kill point/);
  });

  it('refuses a child that wrote to stderr even after the marker', () => {
    expect(notKilledOnPurpose({ signal: null, status: 1, stdout: marker, stderr: 'oops' }, 'win32')).toMatch(/wrote to stderr/);
  });

  it("ignores Node's own warnings, which Node 22.16 prints when a child opens node:sqlite", () => {
    // Verbatim from the Node 22.16.0 CI runner.
    const warned = [
      '(node:4105) ExperimentalWarning: SQLite is an experimental feature and might change at any time',
      '(Use `node --trace-warnings ...` to show where the warning was created)',
      '',
    ].join('\n');
    expect(notKilledOnPurpose({ signal: 'SIGKILL', status: null, stdout: marker, stderr: warned }, 'linux')).toBeUndefined();
    // A warning does not hide an error written beside it.
    expect(notKilledOnPurpose({ signal: 'SIGKILL', status: null, stdout: marker, stderr: `${warned}Error: boom\n` }, 'linux')).toMatch(
      /wrote to stderr/,
    );
  });

  it('refuses a child that reached the marker but was not killed abruptly', () => {
    expect(notKilledOnPurpose({ signal: null, status: 0, stdout: marker, stderr: '' }, 'linux')).toMatch(/not killed abruptly: exit 0/);
    expect(notKilledOnPurpose({ signal: null, status: 0, stdout: marker, stderr: '' }, 'win32')).toMatch(/not killed abruptly: exit 0/);
    expect(notKilledOnPurpose({ signal: 'SIGTERM', status: null, stdout: marker, stderr: '' }, 'linux')).toMatch(/signal SIGTERM/);
  });
});
