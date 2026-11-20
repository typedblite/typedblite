/**
 * Generates the site's pages from the repository's Markdown, and copies the brand files the site uses.
 * Run by `npm exec nx -- run website:prepare` before `astro dev` or `astro build`. Everything it writes is
 * git-ignored (see this folder's .gitignore): the sources stay the only copy.
 *
 * For each page it: takes the title from the first `# ` heading (and drops the heading, because the
 * template prints the title), takes the description from the first paragraph, adds an "edit on GitHub"
 * link, and rewrites relative links (see content-map.mjs). Code fences are left alone.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADR_DIR, ADR_ROUTE, BRANCH, PAGES, REPO_PUBLIC, REPO_URL, UNPUBLISHED } from './content-map.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(HERE, '..');
const ROOT = resolve(SITE, '../..');
const DOCS = join(SITE, 'src/content/docs');
const GENERATED_SECTIONS = ['guide', 'tools', 'packages', 'project', ADR_ROUTE];

const toPosix = (p) => p.split(sep).join('/');

/** Rows of [source, route, label], with the ADRs listed from their folder. */
function pageTable() {
  const rows = PAGES.map(([source, route, label]) => ({ source, route, label }));
  for (const name of readdirSync(join(ROOT, ADR_DIR)).filter((n) => /^adr-\d+.*\.md$/.test(n)).sort()) {
    const number = name.match(/^adr-(\d+)/)[1];
    rows.push({ source: `${ADR_DIR}/${name}`, route: `${ADR_ROUTE}/${name.slice(0, -3)}`, label: `ADR-${number}` });
  }
  return rows;
}

const table = pageTable();
const bySource = new Map(table.map((row) => [row.source, row]));
const errors = [];

function githubUrl(repoPath, fragment) {
  const isDir = statSync(join(ROOT, repoPath)).isDirectory();
  return `${REPO_URL}/${isDir ? 'tree' : 'blob'}/${BRANCH}/${repoPath}${fragment}`;
}

/** Rewrites one relative link target found in `source`. */
function rewriteTarget(target, source) {
  if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) return target;
  const [pathPart, ...rest] = target.split('#');
  const fragment = rest.length ? `#${rest.join('#')}` : '';
  if (!pathPart) return target;
  const repoPath = posix.normalize(posix.join(posix.dirname(source), decodeURI(pathPart))).replace(/\/$/, '');
  if (repoPath.startsWith('..') || !existsSync(join(ROOT, repoPath))) {
    errors.push(`${source}: link to ${target} resolves to nothing (${repoPath})`);
    return target;
  }
  const page = bySource.get(repoPath);
  if (page) return `/${page.route}/${fragment}`;
  // A folder with a README that is a page links to that page (apps/cli/ -> the CLI page).
  const readme = bySource.get(`${repoPath}/README.md`);
  if (readme) return `/${readme.route}/${fragment}`;
  if (/^docs\/brand\/.+\.(svg|png)$/.test(repoPath)) return `/brand/${posix.basename(repoPath)}`;
  return githubUrl(repoPath, fragment);
}

/** Applies `fn` to the text outside fenced code blocks, line by line, tracking the fence. */
function outsideFences(markdown, fn) {
  let fence = null;
  return markdown
    .split('\n')
    .map((line) => {
      const open = line.match(/^\s*(`{3,}|~{3,})/);
      if (fence) {
        if (open && open[1][0] === fence[0] && open[1].length >= fence.length && line.trim() === open[1]) fence = null;
        return line;
      }
      if (open) {
        fence = open[1];
        return line;
      }
      return fn(line);
    })
    .filter((line) => line !== null)
    .join('\n');
}

/** Inline links and images, and reference definitions. Inline code spans are skipped. */
function rewriteLinks(markdown, source) {
  const unpublished = (target) =>
    UNPUBLISHED.includes(posix.normalize(posix.join(posix.dirname(source), target.split('#')[0])));
  const links = (line) => [...line.matchAll(/\]\(([^)\s]+)/g)].map((m) => m[1]).filter((t) => !/^[a-z]+:/i.test(t));
  return outsideFences(markdown, (line) => {
    if (links(line).some(unpublished)) {
      if (/^\s*[-*] /.test(line)) return null;
      line = line.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, text, t) => (unpublished(t) ? text : all));
    }
    return unlinkRepo(line
      .split(/(`[^`]*`)/)
      .map((part) => {
        if (part.startsWith('`')) return part;
        return part
          .replace(/(\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g, (_, a, target, c) => `${a}${rewriteTarget(target, source)}${c}`)
          .replace(/^(\s*\[[^\]]+\]:\s*)(\S+)/, (_, a, target) => `${a}${rewriteTarget(target, source)}`)
          .replace(/(<(?:a|img|source)\s[^>]*?(?:href|src|srcset)=")([^"]+)(")/g, (_, a, target, c) => `${a}${rewriteTarget(target, source)}${c}`);
      })
      .join(''));
  });
}

/** While the repository is private, a link to it becomes its text: `[the file](https://github.com/…)` -> `the file`. */
function unlinkRepo(line) {
  if (REPO_PUBLIC) return line;
  const link = new RegExp(`\\[((?:[^\\]\\[]|\`[^\`]*\`)*)\\]\\(${REPO_URL.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}[^)\\s]*(?:\\s+"[^"]*")?\\)`, 'g');
  return line.replace(link, '$1');
}

const yaml = (s) => JSON.stringify(s);

function describe(body) {
  const paragraph = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !/^(#|>|[-*|`<!]|\d+\.)/.test(p));
  if (!paragraph) return '';
  const plain = paragraph
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ');
  if (plain.length <= 180) return plain;
  const cut = plain.slice(0, 177);
  return `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

function generate(row) {
  const raw = readFileSync(join(ROOT, row.source), 'utf8').replace(/\r\n/g, '\n');
  const lines = raw.split('\n');
  // Skip a leading HTML block (the READMEs' centered logo) before the title.
  const titleIndex = lines.findIndex((line) => /^# \S/.test(line));
  if (titleIndex < 0) {
    errors.push(`${row.source}: no "# " title`);
    return;
  }
  const title = lines[titleIndex].replace(/^# /, '').trim();
  const body = lines.slice(titleIndex + 1).join('\n').replace(/^\n+/, '');
  const out = [
    '---',
    `title: ${yaml(row.label && row.route.startsWith('decisions/') ? `${row.label}: ${title.replace(/^ADR-\d+:\s*/, '')}` : title)}`,
    `description: ${yaml(describe(body))}`,
    `editUrl: ${REPO_PUBLIC ? yaml(`${REPO_URL}/edit/${BRANCH}/${row.source}`) : 'false'}`,
    ...(row.label ? [`sidebar:\n  label: ${yaml(row.label)}`] : []),
    '---',
    '',
    rewriteLinks(body, row.source),
    '',
  ].join('\n');
  const file = join(DOCS, `${row.route}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, out);
}

function copyBrand() {
  const brand = join(ROOT, 'docs/brand');
  mkdirSync(join(SITE, 'public/brand'), { recursive: true });
  mkdirSync(join(SITE, 'src/assets/brand'), { recursive: true });
  for (const name of readdirSync(brand).filter((n) => /\.(svg|png)$/.test(n))) {
    copyFileSync(join(brand, name), join(SITE, 'public/brand', name));
    copyFileSync(join(brand, name), join(SITE, 'src/assets/brand', name));
  }
  copyFileSync(join(brand, 'typedblite-icon.svg'), join(SITE, 'public/favicon.svg'));
  // The TypeQLite grammar the code fences are colored with: the extension's own, so the site and the editor agree.
  mkdirSync(join(SITE, 'src/generated'), { recursive: true });
  copyFileSync(join(ROOT, 'apps/vscode/syntaxes/typeqlite.tmLanguage.json'), join(SITE, 'src/generated/typeqlite.tmLanguage.json'));
}

// Astro caches each page's rendered HTML, keyed by its Markdown and not by the highlighting plugin or the themes,
// so a change to either would leave stale colors in the pages. Start every build from an empty cache.
rmSync(join(SITE, 'node_modules/.astro'), { recursive: true, force: true });
rmSync(join(SITE, '.astro'), { recursive: true, force: true });
for (const section of GENERATED_SECTIONS) rmSync(join(DOCS, section), { recursive: true, force: true });
for (const row of table) generate(row);
copyBrand();

if (errors.length) {
  console.error(`sync-content: ${errors.length} problem(s):\n${errors.map((e) => `  ${e}`).join('\n')}`);
  process.exit(1);
}
console.log(`sync-content: ${table.length} pages generated into ${toPosix(relative(ROOT, DOCS))}`);
