// @ts-check
import * as esbuild from 'esbuild';

/**
 * The host as one file for the editor to run: `dist/sidecar.cjs`, the sidecar transport and the core.
 *
 * It is bundled because the extension's `.vsix` carries no `node_modules` (`vsce.dependencies: false`), and it is a
 * separate file, run as a separate process by a `node` the extension finds, because the extension never imports the
 * host (feature invariant 6). `@typedblite/runtime`'s `node:sqlite` is a Node built-in, so it stays external.
 *
 * 🔴 esbuild does not emit `design:paramtypes`, which Nest's constructor injection reads when a parameter has no
 * `@Inject`. Every injected parameter names its token with `@Inject`, and `test/bundle.test.ts` runs this bundle to
 * prove nothing was left to metadata.
 *
 * The target is Node 22: `node:sqlite` needs it, and the extension checks the `node` it launches.
 */
const minify = !process.argv.includes('--no-minify');

await esbuild.build({
  entryPoints: { sidecar: 'src/sidecar.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.cjs' },
  tsconfig: 'tsconfig.app.json',
  bundle: true,
  // Nest loads these optional peers inside a try/catch (`loadPackage`) when a feature needs them. The host uses none.
  external: ['@nestjs/microservices', '@nestjs/microservices/*', '@nestjs/websockets', '@nestjs/websockets/*', 'class-validator', 'class-transformer'],
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  sourcemap: !minify,
  minify,
  logLevel: 'warning',
});
