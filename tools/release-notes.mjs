// Print one version's section of CHANGELOG.md, for its GitHub Release: `node tools/release-notes.mjs 0.1.0`.
//
// The changelog is written by hand (Keep a Changelog), so a release renames `## [Unreleased]` to
// `## [0.1.0] - YYYY-MM-DD` before it is tagged (docs/development/releasing.md). If there is no section for the
// version, or it is empty, this fails, so a release cannot go out with no notes.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const version = process.argv[2]?.replace(/^v/, '');
if (!version) {
  console.error('usage: node tools/release-notes.mjs <version>');
  process.exit(2);
}

const lines = readFileSync(resolve(ROOT, 'CHANGELOG.md'), 'utf8').split(/\r?\n/);
const heading = (line) => /^## \[/.test(line);
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
if (start === -1) {
  console.error(`CHANGELOG.md has no "## [${version}]" section. Rename "## [Unreleased]" to it before tagging.`);
  process.exit(1);
}
const end = lines.findIndex((line, index) => index > start && heading(line));
const body = lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim();
if (body === '') {
  console.error(`CHANGELOG.md's "## [${version}]" section is empty.`);
  process.exit(1);
}
console.log(body);
