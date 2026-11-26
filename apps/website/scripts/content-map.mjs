/**
 * Which repository documents the site publishes, and where. The site never holds a second copy of a page:
 * `sync-content.mjs` generates each page from its source at build time, so the repository's Markdown stays
 * the one place a guide is written. A page is a `[source, route, sidebar label]` row. A relative link to a
 * source in this table becomes a link to its route; a link to anything else in the repository becomes a link
 * to GitHub; a link to nothing is a build error.
 *
 * Left out on purpose: `docs/guides/why-not-x.md` (a draft that TypeDB Ltd should read before it is
 * published, launch plan decision B1), the planning documents, AGENTS.md and the standards.
 */
export const REPO_URL = 'https://github.com/typedblite/typedblite';
/**
 * Whether the GitHub repository is public. While it is not, every link to it would 404 for a visitor, so the site
 * leaves them out: the header icon, the "Edit page" links, the footer's license link, the links the guides make to
 * a source file (the text stays, the link goes) and the landing page's "View on GitHub" button (a frontmatter
 * action, so that one is changed by hand: see docs/development/website.md).
 */
export const REPO_PUBLIC = true;
export const BRANCH = 'main';

/** @type {Array<[source: string, route: string, label?: string]>} */
export const PAGES = [
  ['docs/guides/getting-started.md', 'guide/getting-started', 'Getting started'],
  ['docs/guides/five-minute-tour.tql.md', 'guide/five-minute-tour', 'Five-minute tour'],
  ['docs/guides/embedding-the-runtime.md', 'guide/embedding-the-runtime', 'Embedding the runtime'],
  ['docs/guides/replication-and-search.md', 'guide/replication-and-search', 'Replication and search'],
  ['docs/guides/typeqlite-language.md', 'guide/typeqlite-language', 'The TypeQLite language'],
  ['docs/guides/known-limitations.md', 'guide/known-limitations', 'Known limitations'],
  ['docs/guides/compatibility.md', 'guide/compatibility', 'Versions and compatibility'],
  ['CONFORMANCE.md', 'guide/conformance', 'Conformance'],

  ['apps/cli/README.md', 'tools/cli', 'Command line'],
  ['apps/vscode/README.md', 'tools/vscode', 'VS Code extension'],
  ['apps/playground/README.md', 'tools/playground', 'Playground (about)'],
  ['apps/sync-demo/README.md', 'tools/sync-demo', 'Sync demo (about)'],

  ['libs/runtime/README.md', 'packages/runtime', '@typedblite/runtime'],
  ['libs/language/README.md', 'packages/language', '@typedblite/language'],
  ['libs/content-revision/README.md', 'packages/content-revision', '@typedblite/content-revision'],
  ['libs/conformance/README.md', 'packages/conformance', 'typedblite-conformance'],

  ['CONTRIBUTING.md', 'project/contributing', 'Contributing'],
  ['docs/development/architecture.md', 'project/architecture', 'Architecture'],
  ['docs/development/testing.md', 'project/testing', 'Testing'],
  ['docs/development/adding-a-construct.md', 'project/adding-a-construct', 'Adding a TypeQLite construct'],
  ['docs/development/performance.md', 'project/performance', 'Performance'],
  ['docs/development/releasing.md', 'project/releasing', 'Releasing'],
  ['CHANGELOG.md', 'project/changelog', 'Changelog'],
  ['docs/brand/README.md', 'project/brand', 'Brand'],
  ['SECURITY.md', 'project/security', 'Security'],
];

/** Every architecture decision record is a page, found by listing the folder. */
export const ADR_DIR = 'docs/architecture';
export const ADR_ROUTE = 'decisions';

/** Sources that are not published. A list item that links to one is dropped; a link inside a sentence loses its link. */
export const UNPUBLISHED = ['docs/guides/why-not-x.md'];
