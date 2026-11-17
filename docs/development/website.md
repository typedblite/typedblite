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
npm exec nx -- run website:dev          # astro dev with live reload; builds the playground first and serves its assets
npm exec nx -- run website:build-site   # the whole site into apps/website/dist
npm exec nx -- run website:check        # build it, then follow every internal link in dist/
npm run site                            # build, then serve dist/ on http://localhost:4321
```

`build-site` builds the playground, runs `astro build` (which generates the API pages, below), then
`scripts/assemble.mjs` copies the playground's scripts, workers and `.wasm` beside the page Astro built at `/playground/`,
and writes the `CNAME` file. `check` runs three scripts on the result. `check-site.mjs`: every `href` and `src` resolves to
a file, every `#fragment` resolves to an id (the API pages included), and the playground, the API, the search index and
`CNAME` exist. `check-highlighting.mjs` and `check-playground.mjs`, above. It is a step of `npm run gate`.

## The API reference is pages of the site

`/api/` is generated by TypeDoc into Markdown (`typedoc-plugin-markdown`) and built by Starlight like any other page,
through the `starlight-typedoc` plugin in `astro.config.mjs`, so it has the site's header, sidebar, search, theme and
code colours. The plugin runs TypeDoc at the start of every `astro dev` and `astro build` and writes the pages to
`src/content/docs/api/` (git-ignored). It reads **the repository's own `typedoc.json`** (entry points, validation,
warnings as errors), the one `npm run check-api` runs, so there is one configuration; `npm run docs:api` still writes the
standalone HTML reference to `dist/api`, which the site does not use. `src/plugins/typedoc-site.mjs` is a small TypeDoc plugin
that points a doc comment's link to an architecture decision record at its page (`/decisions/…`) rather than at a copy of
the file, and stops those copies being made. The overview pages are `/api/` and `/api/typedblite/<package>/`
(`entryFileName: 'index'`), each listing its members in a table with a one-line description from the doc comment
(`indexFormat: 'table'`; `npm run check-api` fails when a name has no doc comment, so none is blank). A maintainer's `🔴` or `⚠️` note on an exported name sits under `@privateRemarks`, which TypeDoc leaves out of these pages. The pages for the generated syntax tree say once that they are generated from the grammar. Each package's page is grouped by what the names are for, not by kind: a name's `@category` tag puts it in a section
(Engine, Replication, Validation, …), and the package's `@module` comment describes each section with
`@categoryDescription` and carries the overview prose and an example. A re-export takes the category of what it re-exports, and the
generated syntax tree is put in "Syntax tree" by `tools/typedoc-categories.mjs` (loaded from `typedoc.json` and, because the
site's `plugin` option may replace that list, from `astro.config.mjs` too), since `langium generate` rewrites the files a tag
would live in. TypeDoc checks every `@categoryDescription` against every group, so `categorizeByGroup` stays `false`; with it on, each
description warns for each kind that lacks the category, and warnings are errors. A name without a category in a package that uses them
lands in "Other", so tag a new export. The overview's title is set with
`name: 'API reference'` and its introduction is added by the plugin. Because the TypeDoc run reads the packages' sources and the generated AST, `website:prepare`
builds the libraries first.

## Publishing

`.github/workflows/site.yml` builds with `website:check` and deploys `apps/website/dist` to GitHub Pages. **It has
never run** (Actions is off, see the launch plan). To publish:

1. Make the repository public, or use a plan that allows Pages on a private one.
2. Settings, Pages, Source: **GitHub Actions**. Enable the workflow.
3. Point `typedblite.dev` at GitHub Pages (four `A` records and an `AAAA` set for the apex, or a `CNAME` for `www`,
   per GitHub's custom-domain documentation), then set the domain in Settings, Pages, and enable **Enforce HTTPS**.
4. Before launch, read the landing page's "Pre-release" notice and the guides' "not on npm yet" notes, and remove them.

The site is not public until step 2, so nothing here is visible before launch.
