// @ts-check
import { mkdirSync, writeFileSync } from 'node:fs';
import * as esbuild from 'esbuild';

/**
 * Two bundles: the extension host loads `out/extension.cjs`, which forks
 * `out/language-server/main.cjs` over IPC. Upstream's shape: `packages/langium-vscode/esbuild.mjs`
 * at `v4.3.0` (ADR-008 D8, row 4).
 *
 * They are CommonJS because that is what the extension host loads, and bundled so that the `.vsix`
 * carries no `node_modules` (`vsce.dependencies: false`). `@typedblite/language` is ESM, and esbuild
 * converts it.
 *
 * 🔴 The target follows VS Code's Node, not upstream's `ES2017`: `engines.vscode ^1.91.0` ships
 * Node 20.
 */
const minify = process.argv.includes('--minify');

const { metafile } = await esbuild.build({
  entryPoints: {
    extension: 'src/extension.ts',
    'language-server/main': 'src/language-server/main.ts',
  },
  outdir: 'out',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode'],
  sourcemap: !minify,
  minify,
  logLevel: 'warning',
  metafile: true,
});
// What went into the bundles, for the third-party notices. In `dist/`, which the `.vsix` excludes.
mkdirSync('dist', { recursive: true });
writeFileSync('dist/meta.json', JSON.stringify(metafile));

// The TypeQLite Theme Bridge, a second extension that runs where the color themes are (ADR-010 D7).
await esbuild.build({
  entryPoints: { extension: 'src/theme-bridge.ts' },
  outdir: 'theme-bridge/out',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode'],
  sourcemap: !minify,
  minify,
  logLevel: 'warning',
});
