import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runTests } from '@vscode/test-electron';

/**
 * Launch a real VS Code with this extension in development mode and run `suite.cjs` in its
 * extension host (ADR-008 D7).
 *
 * The workspace is a fresh copy, so a case that edits a document cannot leak into the next run. The
 * user-data directory is fresh too, so no setting or extension of the developer's own takes part.
 *
 * 🔴 An Electron VS Code needs a display and these system libraries:
 * `libatk-bridge2.0-0` and `libsecret-1-0`. WSLg provides the display on the development host. A
 * headless machine needs `xvfb-run`.
 */
async function main(): Promise<void> {
  // 🔴 Run from a VS Code terminal, this process inherits that editor's environment, and
  // `ELECTRON_RUN_AS_NODE` makes the downloaded VS Code start as plain Node. It then tries to
  // `require` the workspace path and dies with MODULE_NOT_FOUND. The `VSCODE_*` variables would point
  // the test instance at the host editor's IPC sockets. Neither belongs to the editor under test.
  for (const name of Object.keys(process.env)) {
    if (name === 'ELECTRON_RUN_AS_NODE' || name.startsWith('VSCODE_')) delete process.env[name];
  }
  const app = resolve(__dirname, '../..');
  const root = mkdtempSync(join(tmpdir(), 'typeqlite-e2e-'));
  const workspace = join(root, 'workspace');
  cpSync(join(app, 'e2e/workspace'), workspace, { recursive: true });
  try {
    await runTests({
      extensionDevelopmentPath: app,
      extensionTestsPath: resolve(__dirname, 'suite.cjs'),
      launchArgs: [
        workspace,
        '--disable-extensions',
        '--disable-workspace-trust',
        `--user-data-dir=${join(root, 'user-data')}`,
      ],
      extensionTestsEnv: { TYPEQLITE_E2E_WORKSPACE: workspace },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
