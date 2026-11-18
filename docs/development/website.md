# The website

`apps/website` builds the static site planned for `typedblite.dev`: a landing page, the guides, the five-minute
tour, the API reference, the playground, and the project's own documents, all from this repository. It is
[Astro](https://astro.build) with [Starlight](https://starlight.astro.build), published as plain files to Cloudflare (a Worker with static assets).

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

## The sync demo is a page of the site

`/sync-demo/` is the same arrangement for the offline-first demo: an Astro page (`src/pages/sync-demo.astro`) inside
Starlight's layout around the demo's markup (`apps/sync-demo/src/browser-hub/app.html`), its styles (`app.css`, scoped
to `.bh`, reading only `--bh-*` custom properties, which the page maps onto Starlight's colours) and its scripts, Workers
and `.wasm`, copied beside the page by `scripts/assemble.mjs`. The page owns the hub (a dedicated Worker on WASM SQLite
and OPFS) and embeds three device pages as iframes (`/sync-demo/device.html?device=a`, absolute because the site answers
with and without the trailing slash). The devices follow Starlight's `data-theme` through the same-origin parent. The build
is `sync-demo:build-browser`, and its output is static files whose every URL is relative, which
`apps/sync-demo/test/browser-hub-build.test.ts` and the browser tests (served under a sub-path) hold to.
`scripts/check-sync-demo.mjs` (part of `website:check`) opens the built page in Chromium and checks that the shell is
there, the hub and the devices start, a task reaches another device and the hub, a device can be cut off and
reconnected, the devices follow the theme, and the page works without the trailing slash. Only one tab can own the
hub's store, and the page says so ([the demo's README](../../apps/sync-demo/README.md#in-your-browser-in-one-page)).

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
npm exec nx -- run website:dev          # astro dev with live reload; builds the playground and the sync demo first and serves their assets
npm exec nx -- run website:build-site   # the whole site into apps/website/dist
npm exec nx -- run website:check        # build it, then follow every internal link in dist/
npm run site                            # build, then serve dist/ on http://localhost:4321
```

`build-site` builds the playground and the sync demo, runs `astro build` (which generates the API pages, below), then
`scripts/assemble.mjs` copies their scripts, workers and `.wasm` beside the pages Astro built at `/playground/` and `/sync-demo/`,
`check` runs four scripts on the result. `check-site.mjs`: every `href` and `src` resolves to
a file, every `#fragment` resolves to an id (the API pages included), and the playground, the API and the search index exist. `check-highlighting.mjs`, `check-playground.mjs` and `check-sync-demo.mjs`, above. It is a step of `npm run gate`.

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
lands in "Other", so tag a new export. A class or interface page opens with a
"Member summary" (a table per group: constructors, properties, accessors, methods, each member's first sentence, linked to its
heading), which `typedoc-site.mjs` builds from the page TypeDoc rendered, so the sentence is the doc comment's. The overview's title is set with
`name: 'API reference'` and its introduction is added by the plugin. Because the TypeDoc run reads the packages' sources and the generated AST, `website:prepare`
builds the libraries first.

## Publishing

The site is live at <https://typedblite.dev>, deployed by hand to Cloudflare as an assets-only Worker named
`typedblite-website` (also at `typedblite-website.davejackson-dev.workers.dev`). `apps/website/cloudflare.config.ts`
holds its settings: the name, the `typedblite.dev` custom domain, `workers.dev`, and the site's own 404 page. It is a
plain object, so loading it needs no `cf` dependency. To deploy:

```bash
npm run deploy:site                               # build the site, check it, then upload dist/ and apply the config
```

which is these two steps (add `--dry-run` to the second to preview: no upload, no credentials needed):

```bash
npm exec nx -- run website:check
cd apps/website && npx cf@latest deploy ./dist
```

- Sign in first with `cf auth login --no-browser` (approve the code in the browser within five minutes), or set
  `CLOUDFLARE_API_TOKEN`. `cf auth whoami` shows who you are.
- `cf deploy ./dist` skips the build, which is why the script (and the steps above) run the check first. The directory form is only for sites with no
  server-side code, and it deploys whatever is in `dist/`.
- `typedblite.dev` is a zone on the same Cloudflare account. Its DNS has only the mail records (MX, SPF, DKIM); the
  custom domain adds the web records itself. `cf zones list` shows only the first 20 zones, so filter with
  `--name typedblite.dev`.
- `cf` is a release candidate (`1.0.0-rc.1` when this was written), so check `cf deploy --help` if a flag has moved.
- `apps/website/.cloudflare/` is the build output of a deploy or dry run. It is git-ignored.

The site was first planned for GitHub Pages; that workflow (`site.yml`) never ran and has been removed, along with the
`CNAME` and `.nojekyll` files the build used to write for it. The domain is set by `cloudflare.config.ts`.

While the repository is private the site links to none of it: `REPO_PUBLIC` in `apps/website/scripts/content-map.mjs` is
`false`, so there is no GitHub icon in the header, no "Edit page" links, no "View on GitHub" button, the footer's licence
and the API reference's "Defined in" and the guides' links to source files are plain text, and `check-site.mjs` fails
the build if a link to the repository gets in. (The `git clone` commands in the guides stay: they are code.)

At the first release (the packages on npm, and the repository public):

1. Set `REPO_PUBLIC` to `true`, and put the "View on GitHub" action back in the landing page's frontmatter
   (`link: https://github.com/typedblite/typedblite`, `icon: external`, `variant: minimal`).
2. Read the landing page's "Pre-release" notice, the README's "Not on npm" bullet and the guides' "not on npm yet" notes,
   and remove them. Until then they are true: the landing page and the README also say the repository is not public yet.
3. Redeploy with `npm run deploy:site`.
