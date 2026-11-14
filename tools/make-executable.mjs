// Marks a file executable (`chmod +x`), the same in sh and in Windows' cmd.exe, where it does nothing:
// Windows has no execute bit, and npm's `.cmd` shim reads the file's `#!` line instead.
// Usage: node tools/make-executable.mjs <file>
import { chmodSync, statSync } from 'node:fs';

const [file] = process.argv.slice(2);
if (!file) {
  console.error('usage: node make-executable.mjs <file>');
  process.exit(2);
}
chmodSync(file, statSync(file).mode | 0o111);
