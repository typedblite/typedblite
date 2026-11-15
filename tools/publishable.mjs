// The packages TypeDBLite publishes to npm, in dependency order (a package before its dependants).
// `tools/check-packages.mjs` checks this list against `release.projects` in nx.json, so the two cannot drift.
// The VS Code extension is published to the Marketplace and Open VSX, not npm, and is not here.
export const PUBLISHABLE = [
  { project: 'content-revision', dir: 'libs/content-revision' },
  { project: 'typeqlite-language', dir: 'libs/language' },
  { project: 'typedblite-runtime', dir: 'libs/runtime' },
  { project: 'typedblite', dir: 'apps/cli' },
];

// Every published manifest points here. Moving the repository is a change to this line and to the manifests,
// which the check then holds to it.
export const REPOSITORY = 'https://github.com/dave-jackson-dev/typedblite';
