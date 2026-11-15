# typedblite-website

The `typedblite.dev` site: Astro and Starlight, built to static files. Its pages come from the repository's own
Markdown, so there is almost nothing to edit here. How it works, the commands and how it is published:
[docs/development/website.md](../../docs/development/website.md).

```bash
npm exec nx -- run website:check   # build the whole site, then follow every internal link
npm run site                       # build, then serve it
```
