// Copies one file, creating the destination directory first: `mkdir -p <dir> && cp <src> <dest>`
// that behaves the same in sh and in Windows' cmd.exe, where `mkdir -p` creates a directory named "-p".
// Usage: node tools/copy-file.mjs <src> <dest>
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const [src, dest] = process.argv.slice(2);
if (!src || !dest) {
  console.error('usage: node copy-file.mjs <src> <dest>');
  process.exit(2);
}
mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
