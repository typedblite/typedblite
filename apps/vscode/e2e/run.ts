import { spawnSync } from 'node:child_process';
import { accessSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} from '@vscode/test-electron';

/**
 * Launch a real VS Code with this extension and run `suite.cjs` in its extension host (ADR-008 D7).
 *
 * Given a `.vsix` (`node e2e/out/run.cjs dist/typeqlite-0.0.1.vsix`), the downloaded VS Code's own CLI
 * installs it into a fresh extensions folder, and the cases run against **the installed copy**: the
 * artifact a user would install, not the source folder. Any further packages (the Theme Bridge's) are
 * installed beside it. `--packaged`, which is what `nx e2e` passes, means both packages the `package` target
 * wrote, named from their manifests (`dist/<name>-<version>.vsix`), so a version bump needs no edit here.
 * Without an argument, the cases run against the source folder, which is quicker when iterating.
 *
 * The workspace and the user-data folder are fresh copies, so no case can leak into the next run, and
 * no setting or extension of the developer's own takes part.
 *
 * 🔴 An Electron VS Code needs a display. WSLg provides one on the development host; a headless
 * machine needs `xvfb-run`.
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
  const manifestOf = (dir: string) =>
    JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { publisher: string; name: string; version: string };
  const packaged = (dir: string): string => {
    const { name, version } = manifestOf(dir);
    return join(app, 'dist', `${name}-${version}.vsix`);
  };
  const args = process.argv.slice(2);
  // The first package is the extension under test. Any after it (the Theme Bridge) are installed beside it.
  const [vsix, ...companions] =
    args[0] === '--packaged' ? [packaged(app), packaged(join(app, 'theme-bridge'))] : args.map((path) => resolve(app, path));
  const root = mkdtempSync(join(tmpdir(), 'typeqlite-e2e-'));
  const workspace = join(root, 'workspace');
  const userData = join(root, 'user-data');
  const extensions = join(root, 'extensions');
  cpSync(join(app, 'e2e/workspace'), workspace, { recursive: true });
  // 🔴 VS Code puts its IPC socket in $XDG_RUNTIME_DIR, not in --user-data-dir. Where that directory is unset or
  // does not exist (WSL without a systemd user session points it at a /run/user/<uid> that is not there, and so do
  // some containers), VS Code stops on a dialog, "Unable to write program user data ... listen EACCES", and the
  // run hangs behind a window nobody sees. A fresh one beside the other folders, private to this run.
  if (process.platform === 'linux') {
    const runtime = process.env['XDG_RUNTIME_DIR'];
    const usable = ((): boolean => {
      if (!runtime) return false;
      try {
        accessSync(runtime, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    })();
    if (!usable) {
      const own = join(root, 'runtime');
      mkdirSync(own, { mode: 0o700 });
      process.env['XDG_RUNTIME_DIR'] = own;
    }
  }
  try {
    const vscode = await downloadAndUnzipVSCode();
    let extension = app;
    // 🔴 `--disable-extensions` (below) disables every installed extension that is not under
    // development, so a companion runs only if it is a development path too.
    const companionPaths: string[] = [];
    if (vsix) {
      const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscode);
      for (const pkg of [vsix, ...companions]) {
        if (!existsSync(pkg)) throw new Error(`No package at ${pkg}. Run the package target first.`);
        const installed = spawnSync(
          cli!,
          [
            ...cliArgs.filter((arg) => !arg.startsWith('--extensions-dir') && !arg.startsWith('--user-data-dir')),
            `--extensions-dir=${extensions}`,
            `--user-data-dir=${userData}`,
            '--install-extension',
            pkg,
          ],
          {
            encoding: 'utf8',
            shell: process.platform === 'win32',
            // Under WSL, VS Code's `bin/code` stops to ask whether to continue; this answers it.
            env: { ...process.env, DONT_PROMPT_WSL_INSTALL: '1' },
          },
        );
        if (installed.status !== 0) {
          throw new Error(`Installing ${pkg} failed:\n${installed.stdout}\n${installed.stderr}`);
        }
      }
      const main = manifestOf(app);
      extension = join(extensions, `${main.publisher}.${main.name}-${main.version}`);
      if (!existsSync(join(extension, 'out/language-server/main.cjs'))) {
        throw new Error(`The installed extension at ${extension} has no language server.`);
      }
      console.log(`Installed ${vsix} into ${extension}`);
      for (const pkg of companions) {
        const id = `typedblite.${basename(pkg).replace(/\.vsix$/, '')}`;
        if (!existsSync(join(extensions, id, 'package.json'))) throw new Error(`${pkg} did not install as ${id}.`);
        companionPaths.push(join(extensions, id));
        console.log(`Installed ${pkg} into ${join(extensions, id)}`);
      }
    }
    await runTests({
      vscodeExecutablePath: vscode,
      extensionDevelopmentPath: [extension, ...companionPaths],
      extensionTestsPath: resolve(__dirname, 'suite.cjs'),
      launchArgs: [
        workspace,
        '--disable-extensions',
        '--disable-workspace-trust',
        `--user-data-dir=${userData}`,
        `--extensions-dir=${extensions}`,
      ],
      extensionTestsEnv: { TYPEQLITE_E2E_WORKSPACE: workspace, TYPEQLITE_E2E_EXTENSION: extension },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
