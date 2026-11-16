# The website

`apps/website` builds the static site planned for `typedblite.dev`: a landing page, the guides, the five-minute
tour, the API reference, the playground, and the project's own documents, all from this repository. It is
[Astro](https://astro.build) with [Starlight](https://starlight.astro.build), published as plain files to GitHub Pages.

## One copy of every page

The site holds no page of its own except the landing page (`apps/website/src/content/docs/index.mdx`). Every other
page is **generated at build time from a Markdown file in the repository**, by `scripts/sync-content.mjs`, so a guide is
edited where it always was and the site and GitHub cannot disagree. The generated pages are git-ignored.

`scripts/content-map.mjs` is the table of which documents are published and at which route:

| Section | Route | Source |
| ------- | ----- | ------ |
| Guides | `/guide/…` | `docs/guides/*.md` (not the draft `why-not-x.md`), `CONFORMANCE.md` |
| Tools | `/tools/…` | the READMEs of `apps/cli`, `apps/vscode`, `apps/playground`, `apps/sync-demo` |
| Packages | `/packages/…` | the READMEs of the four libraries |
| Project | `/project/…` | `CONTRIBUTING.md`, `docs/development/*.md`, `CHANGELOG.md`, `SECURITY.md`, the brand page |
| Decisions | `/decisions/…` | every `docs/architecture/adr-*.md`, found by listing the folder |

For each page the script takes the title from the first `# ` heading, the description from the first paragraph, and
rewrites relative links: a link to another published document becomes a link to its page, a link to any other file in
the repository becomes a GitHub link, and **a link to a file that does not exist fails the build**. A list item that
links to an unpublished document is dropped. To publish another document, add a row to the table (and to the sidebar in
`astro.config.mjs` if it is not in an auto-generated group).

Also generated, from other places: the brand files (`docs/brand/`) and the favicon, and the TypeQLite grammar that
colours code fences, which is the VS Code extension's own (`apps/vscode/syntaxes/typeqlite.tmLanguage.json`). ```` ```mermaid ```` fences are drawn in the browser,
in the reader's theme.

## The playground is a page of the site

`/playground/` is an Astro page (`src/pages/playground.astro`) inside Starlight's layout: its header, search, theme
switch and sidebar. The playground supplies the markup (`apps/playground/src/app.html`, a fragment that its build also
puts into the standalone `index.html`), its styles (`app.css`, scoped to `.pg`, reading only `--pg-*` custom
properties) and its scripts, workers and `.wasm`; the page maps `--pg-*` onto Starlight's colours. The editor follows
Starlight's `data-theme` and takes its background from the page. `scripts/check-playground.mjs` (part of `website:check`)
opens the built page in Chromium and checks that the shell is there, the first example runs and draws, nothing fails to
load, and the editor follows the theme. The playground's scripts find their workers beside themselves
(`import.meta.url`), so the page may be at any URL.

## How a TypeQLite fence is coloured

As in the editor, in two layers. Shiki colours it with the TextMate grammar, in VS Code's own Dark+ and Light+ themes
(`minSyntaxHighlightingColorContrast: 0`, so the colours are the themes' and Expressive Code does not adjust them).
Over that, `src/plugins/typeqlite-semantic.mjs` runs **the language server's semantic token provider** (the
`TypeQLiteSemanticTokenProvider` the extension and the playground run) on each fence at build time, and colours each
token by what the theme gives the scope VS Code falls back to for its type. A name that resolves to a type, an attribute
or a variable gets that colour, and one that does not resolve keeps the grammar's, as in the editor.

A fence is highlighted **on its own**, with no schema around it. So a query in one fence does not know the types a
`define` in an earlier fence declared, and its names keep the grammar's colour. Put the schema in the same fence to
get them coloured. `scripts/check-highlighting.mjs` (part of `website:check`) checks the tokens, that fences
highlighted at once do not mix (the provider keeps state), and that the colours are the playground's.

## Commands

```bash
npm exec nx -- run website:dev          # astro dev with live reload; builds the playground and the API first and serves them at /playground/ and /api/
npm exec nx -- run website:build-site   # the whole site into apps/website/dist
npm exec nx -- run website:check        # build it, then follow every internal link in dist/
npm run site                            # build, then serve dist/ on http://localhost:4321
```

`build-site` builds the playground (`/playground/`, which uses relative URLs and so works from any path), generates
the API reference with TypeDoc (`/api/`), runs `astro build`, then `scripts/assemble.mjs` puts the first two into
`dist/` with the `CNAME` file. `check` is `scripts/check-site.mjs`: every `href` and `src` resolves to a file, every
`#fragment` on a guide page resolves to an id, and the playground, the API, the search index and `CNAME` exist. It is a
step of `npm run gate`.

## Publishing

`.github/workflows/site.yml` builds with `website:check` and deploys `apps/website/dist` to GitHub Pages. **It has
never run** (Actions is off, see the launch plan). To publish:

1. Make the repository public, or use a plan that allows Pages on a private one.
2. Settings, Pages, Source: **GitHub Actions**. Enable the workflow.
3. Point `typedblite.dev` at GitHub Pages (four `A` records and an `AAAA` set for the apex, or a `CNAME` for `www`,
   per GitHub's custom-domain documentation), then set the domain in Settings, Pages, and enable **Enforce HTTPS**.
4. Before launch, read the landing page's "Pre-release" notice and the guides' "not on npm yet" notes, and remove them.

The site is not public until step 2, so nothing here is visible before launch.
