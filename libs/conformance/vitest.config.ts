import { defineConfig } from 'vitest/config';

import { swcDecoratorMetadata, testDefaults, workspaceAliases } from '../../vitest.shared';

const defaults = testDefaults('typedblite-conformance');

export default defineConfig({
  plugins: [swcDecoratorMetadata()],
  resolve: { alias: workspaceAliases() },
  test: {
    ...defaults,
    include: ['test/**/*.test.ts'],
    // 935 scenarios, each with its own in-memory interpreter. Well under this on a warm machine,
    // but the first run after a langium-generate is not warm.
    testTimeout: 120_000,
    coverage: {
      ...defaults.coverage,
      // 🔴 Out of the unit floor by name, each for a reason no unit test can meet. Nothing else here
      // may be excluded to pass it: the decision is the launch plan's decision 9.
      exclude: [
        ...defaults.coverage.exclude,
        // The differential oracle drives a live TypeDB server over HTTP (ADR-005). It is run by hand
        // against `typedb/typedb:3.10.4` (CONFORMANCE.md), never in the routine suite.
        'src/typedb-oracle.ts',
        'src/oracle.ts',
        // The speed comparison against the same server (`oracle-bench` target): it times two engines, which a
        // unit test cannot do without one running, and prints a report.
        'src/oracle-bench.ts',
        // The `report` target's script: it prints the card and sets the exit code. What it prints
        // is `report.ts`, which is tested; this file only wires it to the console.
        'src/cli.ts',
      ],
    },
  },
});
