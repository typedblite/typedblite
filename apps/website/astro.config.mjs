// @ts-check
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightTypeDoc, { typeDocSidebarGroup } from 'starlight-typedoc';
import { fileURLToPath } from 'node:url';
import { mountBuilt } from './src/integrations/mount-built.mjs';
import { typeqliteSemanticTokens } from './src/plugins/typeqlite-semantic.mjs';
import { readFileSync } from 'node:fs';
import { REPO_PUBLIC, REPO_URL } from './scripts/content-map.mjs';

// The editor's own TypeQLite grammar (copied here by scripts/sync-content.mjs), so a fence on the site is
// coloured the way it is in VS Code. `typeql` is what the guides write; the other names are aliases.
const typeql = {
  ...JSON.parse(readFileSync(new URL('./src/generated/typeqlite.tmLanguage.json', import.meta.url), 'utf8')),
  name: 'typeql',
  aliases: ['typeqlite', 'tql'],
};

export default defineConfig({
  site: 'https://typedblite.dev',
  trailingSlash: 'ignore',
  integrations: [
    mountBuilt(),
    starlight({
      title: 'TypeDBLite',
      description:
        "TypeDB's data model and the TypeQL query language in your own process: a TypeScript engine over SQLite. No server, no native binary.",
      logo: { light: './src/assets/brand/typedblite-logo.svg', dark: './src/assets/brand/typedblite-logo-dark.svg', alt: 'TypeDBLite', replacesTitle: true },
      favicon: '/favicon.svg',
      // Both GitHub links wait for the repository to be public (REPO_PUBLIC, scripts/content-map.mjs).
      social: REPO_PUBLIC ? [{ icon: 'github', label: 'GitHub', href: REPO_URL }] : [],
      // The API reference: TypeDoc's output as Markdown pages (typedoc-plugin-markdown), so it is in the same layout, search
      // and theme as every other page. It reads the repository's own typedoc.json (entry points, validation, warnings as
      // errors), the one `npm run check-api` runs, so there is a single configuration. The pages are written to
      // src/content/docs/api/ on every build and are git-ignored.
      plugins: [
        starlightTypeDoc({
          output: 'api',
          typeDoc: {
            options: fileURLToPath(new URL('../../typedoc.json', import.meta.url)),
            // The categories plugin is in typedoc.json too; a `plugin` given here may replace that list, and loading it twice is harmless.
            plugin: [
              fileURLToPath(new URL('../../tools/typedoc-categories.mjs', import.meta.url)),
              fileURLToPath(new URL('./src/plugins/typedoc-site.mjs', import.meta.url)),
            ],
            // /api/ and /api/typedblite/runtime/ are the overview pages, not .../readme/.
            entryFileName: 'index',
            // A table of Name and Description, not a bare list, for the overview and for each package's members.
            indexFormat: 'table',
            // The overview page's title (the standalone HTML reference keeps the project's name, TypeDBLite).
            name: 'API reference',
          },
          sidebar: { label: 'API reference', collapsed: true },
          errorOnEmptyDocumentation: true,
        }),
      ],
      customCss: ['./src/styles/site.css'],
      components: { Head: './src/components/Head.astro', Sidebar: './src/components/Sidebar.astro', Footer: './src/components/Footer.astro' },
      ...(REPO_PUBLIC ? { editLink: { baseUrl: `${REPO_URL}/edit/main/` } } : {}),
      // The themes are VS Code's own Dark+ and Light+, the ones the editor and the playground use, so a fence is
      // coloured as it is there. The plugin lays the language server's semantic tokens over the grammar's.
      expressiveCode: {
        themes: ['dark-plus', 'light-plus'],
        useStarlightUiThemeColors: true,
        // Expressive Code darkens or lightens a syntax colour that is under 5.5:1 against the background. Off, the
        // colours are the themes' own, the ones the editor shows.
        minSyntaxHighlightingColorContrast: 0,
        plugins: [typeqliteSemanticTokens()],
        shiki: { langs: [/** @type {any} */ (typeql)] },
      },
      sidebar: [
        {
          label: 'Start here',
          items: [
            { slug: 'guide/getting-started' },
            { slug: 'guide/five-minute-tour' },
            { label: 'Playground', link: '/playground/', attrs: { target: '_self' } },
            { label: 'Sync demo', link: '/sync-demo/', attrs: { target: '_self' } },
          ],
        },
        {
          label: 'Guides',
          items: [
            { slug: 'guide/embedding-the-runtime' },
            { slug: 'guide/typeqlite-language' },
            { slug: 'guide/replication-and-search' },
            { slug: 'guide/compatibility' },
          ],
        },
        {
          label: 'Reference',
          items: [
            typeDocSidebarGroup,
            { slug: 'guide/known-limitations' },
            { slug: 'guide/conformance' },
            { label: 'Packages', collapsed: true, items: [{ autogenerate: { directory: 'packages' } }] },
          ],
        },
        { label: 'Tools', items: [{ autogenerate: { directory: 'tools' } }] },
        {
          label: 'Project',
          collapsed: true,
          items: [
            { slug: 'project/contributing' },
            { slug: 'project/architecture' },
            { slug: 'project/testing' },
            { slug: 'project/adding-a-construct' },
            { slug: 'project/performance' },
            { slug: 'project/releasing' },
            { slug: 'project/security' },
            { slug: 'project/changelog' },
            { slug: 'project/brand' },
          ],
        },
        { label: 'Decisions', collapsed: true, items: [{ autogenerate: { directory: 'decisions' } }] },
      ],
    }),
  ],
});
