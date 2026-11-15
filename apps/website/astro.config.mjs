// @ts-check
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import { readFileSync } from 'node:fs';

// The editor's own TypeQLite grammar (copied here by scripts/sync-content.mjs), so a fence on the site is
// coloured the way it is in VS Code. `typeql` is what the guides write; the other names are aliases.
const typeql = {
  ...JSON.parse(readFileSync(new URL('./src/generated/typeqlite.tmLanguage.json', import.meta.url), 'utf8')),
  name: 'typeql',
  aliases: ['typeqlite', 'tql'],
};

export default defineConfig({
  site: 'https://typedblite.dev',
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'TypeDBLite',
      description:
        "TypeDB's data model and the TypeQL query language in your own process: a TypeScript engine over SQLite. No server, no native binary.",
      logo: { light: './src/assets/brand/typedblite-logo.svg', dark: './src/assets/brand/typedblite-logo-dark.svg', alt: 'TypeDBLite', replacesTitle: true },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/typedblite/typedblite' }],
      customCss: ['./src/styles/site.css'],
      components: { Head: './src/components/Head.astro', Footer: './src/components/Footer.astro' },
      editLink: { baseUrl: 'https://github.com/typedblite/typedblite/edit/main/' },
      expressiveCode: { shiki: { langs: [/** @type {any} */ (typeql)] } },
      sidebar: [
        {
          label: 'Start here',
          items: [
            { slug: 'guide/getting-started' },
            { slug: 'guide/five-minute-tour' },
            { label: 'Playground', link: '/playground/', attrs: { target: '_self' } },
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
            { label: 'API reference', link: '/api/', attrs: { target: '_self' } },
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
