// @ts-check
import * as esbuild from 'esbuild';

/**
 * The e2e: `run.cjs` downloads a VS Code and launches it with this extension in development mode,
 * and `suite.cjs` is the module the extension host loads to run the cases (ADR-008 D7).
 */
await esbuild.build({
  entryPoints: { run: 'e2e/run.ts', suite: 'e2e/suite.ts' },
  outdir: 'e2e/out',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode', '@vscode/test-electron'],
  sourcemap: true,
  logLevel: 'warning',
});
