/**
 * A TypeDoc plugin for the site's API pages (loaded through starlight-typedoc's `typeDoc.plugin`).
 *
 * A doc comment links an architecture decision record by its repository path (`../../docs/architecture/adr-003-….md`),
 * which TypeDoc resolves by copying the file into the output as "media" and linking the copy. On the site the record is
 * already a page, so this points each such link at it (`/decisions/adr-003-…/`; a guide, likewise, at `/guide/<name>/`) and stops the copies being made: Starlight
 * would treat them as pages of their own and refuse them for lack of a title.
 */
import { MarkdownPageEvent, MarkdownRendererEvent } from 'typedoc-plugin-markdown';
import { REPO_PUBLIC, REPO_URL } from '../../scripts/content-map.mjs';

const GRAMMAR_URL = `${REPO_URL}/blob/main/libs/language/src/typeqlite.langium`;
// The syntax tree's declarations are generated from the grammar and are not in the repository, so TypeDoc's source line for them is
// plain text that points at nothing. Say where they come from, and link that.
const GENERATED_SOURCE = /^Defined in: libs\/language\/src\/generated\/[\w.-]+:\d+$/gm;
const MEDIA_LINK = /\]\((?:\.\.\/)*_media\/(adr-[\w-]+)\.md(#[^)]*)?\)/g;
// A guide is linked the same way (`../../../docs/guides/replication-and-search.md`), and is a page at /guide/<name>/.
const GUIDE_LINK = /\]\((?:\.\.\/)*_media\/((?!adr-)[\w-]+)\.md(#[^)]*)?\)/g;

const OVERVIEW = `Everything the four packages export, generated from their source and checked on every build. A name that is not listed
here is not public, whatever the package contains. To learn how the pieces fit, start with
[Embedding the runtime](/guide/embedding-the-runtime/), then come here for the detail; the engine's entry point is
[TypeDBLiteInterpreter](/api/typedblite/runtime/classes/typedbliteinterpreter/).`;

// A class or an interface page lists its members under `## Constructors`, `## Properties`, `## Methods`…, one `###` each, and the
// reader has to scroll past every parameter table to see what else there is. JavaDoc opens such a page with a summary, so this does.
const MEMBER_GROUPS = new Set(['Constructors', 'Properties', 'Accessors', 'Methods', 'Events']);

/** Starlight's heading id: GitHub's slug of the heading's text, a repeat of one getting `-1`, `-2`… */
function slugger() {
  const seen = new Map();
  return (text) => {
    const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '').replace(/ /g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };
}

/** The first sentence of a paragraph: up to a full stop that is not inside a code span or a link, or the whole paragraph. */
function firstSentence(paragraph) {
  let code = false;
  let depth = 0;
  for (let i = 0; i < paragraph.length; i++) {
    const c = paragraph[i];
    if (c === '`') code = !code;
    else if (!code && (c === '(' || c === '[')) depth++;
    else if (!code && (c === ')' || c === ']')) depth = Math.max(0, depth - 1);
    else if (!code && depth === 0 && c === '.' && (i === paragraph.length - 1 || /\s/.test(paragraph[i + 1]))) return paragraph.slice(0, i + 1);
  }
  return paragraph;
}

/** The description of the member whose heading is at `lines[start]`: the first sentence of the first paragraph that is prose. */
function describeMember(lines, start) {
  const paragraph = [];
  let fenced = false;
  for (let i = start + 1; i < lines.length && !/^#{1,3} /.test(lines[i]); i++) {
    const line = lines[i];
    if (/^```/.test(line)) fenced = !fenced;
    // A member with no description reaches its parameters: that is not one. A signature's heading comes before its description.
    if (!fenced && /^#{4,6} /.test(line) && !/^#{4,6} (Call|Get|Set|Construct) Signature$/.test(line)) break;
    const meta = fenced || /^(>|#|\*\*\*|Defined in:|Inherited from:|Overrides:|Implementation of:|Implementations:)/.test(line);
    if (paragraph.length > 0 && (line.trim() === '' || meta)) break;
    if (paragraph.length === 0 && (line.trim() === '' || meta)) continue;
    paragraph.push(line.trim());
  }
  const sentence = firstSentence(paragraph.join(' ')).replace(/\|/g, '\\|');
  if (sentence !== '') return sentence;
  // A member a dependency's class declares, which has no description: say whose it is.
  for (let i = start + 1; i < lines.length && !/^#{1,3} /.test(lines[i]); i++) {
    const inherited = lines[i].match(/^Defined in: node\\?_modules\/((?:@[^/]+\/)?[^/]+)\//);
    if (inherited) return `Inherited from \`${inherited[1]}\`.`;
  }
  return '';
}

/** A table of each group's members (a constructor is shown as `new ClassName()`), linked to their headings, to put above the first group; `undefined` where there is nothing to list. */
function memberSummary(contents, className) {
  const lines = contents.split('\n');
  const slug = slugger();
  const headings = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i])) fenced = !fenced;
    const match = !fenced && lines[i].match(/^(#{2,6}) (.+)$/);
    if (match) headings.push({ line: i, level: match[1].length, text: match[2].replace(/\\(.)/g, '$1'), id: slug(match[2].replace(/\\(.)/g, '$1')) });
  }
  const groups = [];
  for (const heading of headings) {
    if (heading.level === 2) groups.push({ ...heading, members: [] });
    else if (heading.level === 3 && groups.length > 0) groups[groups.length - 1].members.push(heading);
  }
  const listed = groups.filter((group) => MEMBER_GROUPS.has(group.text) && group.members.length > 0);
  if (listed.reduce((n, group) => n + group.members.length, 0) < 2) return undefined;
  const tables = listed.map((group) =>
    [
      `**${group.text}**`,
      '',
      '| Name | Description |',
      '| ------ | ------ |',
      ...group.members.map((member) => `| [${member.text === 'Constructor' ? `new ${className}()` : member.text}](#${member.id}) | ${describeMember(lines, member.line) || (member.text === 'Constructor' ? `Creates a ${className}.` : '')} |`),
    ].join('\n'),
  );
  return { line: listed[0].line, text: `## Member summary\n\n${tables.join('\n\n')}\n` };
}

/** @param {import('typedoc').Application} app */
export function load(app) {
  app.renderer.on(MarkdownPageEvent.END, (page) => {
    // Once per page: its members are generated from the same grammar, and need not say so each time.
    let said = 0;
    page.contents = page.contents
      ?.replace(MEDIA_LINK, (_, name, hash = '') => `](/decisions/${name}/${hash})`)
      .replace(GUIDE_LINK, (_, name, hash = '') => `](/guide/${name}/${hash})`)
      .replace(GENERATED_SOURCE, () => (said++ === 0 ? (REPO_PUBLIC ? `Generated from [the TypeQLite grammar](${GRAMMAR_URL}).` : 'Generated from the TypeQLite grammar.') : ''));
    // "Defined in" links point at the repository's source files: text only while the repository is private.
    if (!REPO_PUBLIC && page.contents) {
      const repoLink = new RegExp(`\\[([^\\]]+)\\]\\(${REPO_URL.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/[^)\\s]*\\)`, 'g');
      page.contents = page.contents.replace(repoLink, '$1');
    }
    // A class or an interface: what it has, before the detail of each.
    if (/(^|\/)(classes|interfaces)\/[^/]+\.md$/.test(page.url) && page.contents) {
      const summary = memberSummary(page.contents, page.model?.name ?? 'Constructor');
      if (summary) {
        const lines = page.contents.split('\n');
        lines.splice(summary.line, 0, summary.text);
        page.contents = lines.join('\n');
      }
    }
    // The overview page has nothing above its table of modules, so say what this is and where to start.
    if (page.url === 'index.md') page.contents = page.contents?.replace(/^## Modules$/m, `${OVERVIEW}\n\n## Modules`);
  });
  // typedoc-plugin-markdown copies the media right after this event, from the project's file registry, and
  // offers no switch. Leave the registry with nothing to copy.
  app.renderer.on(MarkdownRendererEvent.END, (event) => {
    event.project.files.getNameToAbsoluteMap = () => new Map();
  });
}
