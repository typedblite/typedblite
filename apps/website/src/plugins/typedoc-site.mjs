/**
 * A TypeDoc plugin for the site's API pages (loaded through starlight-typedoc's `typeDoc.plugin`).
 *
 * A doc comment links an architecture decision record by its repository path (`../../docs/architecture/adr-003-….md`),
 * which TypeDoc resolves by copying the file into the output as "media" and linking the copy. On the site the record is
 * already a page, so this points each such link at it (`/decisions/adr-003-…/`) and stops the copies being made: Starlight
 * would treat them as pages of their own and refuse them for lack of a title.
 */
import { MarkdownPageEvent, MarkdownRendererEvent } from 'typedoc-plugin-markdown';

const MEDIA_LINK = /\]\((?:\.\.\/)*_media\/(adr-[\w-]+)\.md(#[^)]*)?\)/g;

const OVERVIEW = `Everything the four packages export, generated from their source and checked on every build. A name that is not listed
here is not public, whatever the package contains. To learn how the pieces fit, start with
[Embedding the runtime](/guide/embedding-the-runtime/), then come here for the detail; the engine's entry point is
[TypeDBLiteInterpreter](/api/typedblite/runtime/classes/typedbliteinterpreter/). A dash in the description column means the
source has no doc comment for that name yet.`;

/** @param {import('typedoc').Application} app */
export function load(app) {
  app.renderer.on(MarkdownPageEvent.END, (page) => {
    page.contents = page.contents?.replace(MEDIA_LINK, (_, name, hash = '') => `](/decisions/${name}/${hash})`);
    // The overview page has nothing above its table of modules, so say what this is and where to start.
    if (page.url === 'index.md') page.contents = page.contents?.replace(/^## Modules$/m, `${OVERVIEW}\n\n## Modules`);
  });
  // typedoc-plugin-markdown copies the media right after this event, from the project's file registry, and
  // offers no switch. Leave the registry with nothing to copy.
  app.renderer.on(MarkdownRendererEvent.END, (event) => {
    event.project.files.getNameToAbsoluteMap = () => new Map();
  });
}
