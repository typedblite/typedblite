import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { transform } from '@swc/core';
import type { Plugin } from 'vite';

const ROOT = dirname(fileURLToPath(import.meta.url));

export const workspaceAliases = (): ReadonlyArray<{ find: string; replacement: string }> => {
  const raw = readFileSync(resolve(ROOT, 'tsconfig.base.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const paths: Record<string, readonly string[]> =
    JSON.parse(raw).compilerOptions?.paths ?? {};
  return [
    ...Object.entries(paths).map(([find, targets]) => ({
      find,
      replacement: resolve(ROOT, targets[0] as string),
    })),
    // 🔴 The runtime's `#default-opener` (ADR-009 D4) resolves through its package.json `imports` to
    // `out/`, which a test run must not depend on: point it at the Node source, as `node` selects.
    // `vitest.wasm.config.ts` replaces this alias to run the suite on WASM SQLite.
    { find: '#default-opener', replacement: resolve(ROOT, 'libs/runtime/src/default-opener.node.ts') },
  ];
};

export const swcDecoratorMetadata = (): Plugin => ({
  name: 'swc-decorator-metadata',
  enforce: 'pre',
  async transform(code: string, id: string) {
    if (!/\.[cm]?ts$/.test(id) || id.includes('/node_modules/')) return null;
    const output = await transform(code, {
      filename: id,
      sourceMaps: true,
      swcrc: false,
      configFile: false,
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2022',
      },
      module: { type: 'es6' },
    });
    return { code: output.code, map: output.map };
  },
});

export const testDefaults = (name: string) => ({
  name,
  globals: true,
  environment: 'node' as const,
  testTimeout: 30_000,
  hookTimeout: 30_000,
  coverage: {
    enabled: Boolean(process.env['CI']),
    provider: 'v8' as const,
    reportsDirectory: resolve(ROOT, 'coverage', name),
    reporter: ['text-summary', 'lcov'] as const,
    all: true,
    include: ['src/**/*.ts'],
    exclude: [
      '**/*.spec.ts',
      '**/*.spec-helper.ts',
      '**/*.test.*',
      '**/*.contract.ts',
      '**/index.ts',
      '**/*.d.ts',
    ],
    thresholds: { lines: 80, statements: 80, functions: 80 },
  },
});
