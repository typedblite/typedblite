/**
 * Rebuilds the playground into `.build/` whenever something in `src/` changes (a debounced re-run of build.mjs).
 * For `website:dev-watch`: Astro reads `.build/app.html` (so markup changes hot-reload) and serves the rest from
 * there (CSS and scripts: refresh the page).
 */
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
let running = false;
let queued = false;
let timer;

function build() {
  if (running) {
    queued = true;
    return;
  }
  running = true;
  const child = spawn(process.execPath, [join(HERE, 'build.mjs')], { cwd: HERE, stdio: 'inherit' });
  child.on('exit', () => {
    running = false;
    if (queued) {
      queued = false;
      build();
    }
  });
}

build();
watch(join(HERE, 'src'), { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(build, 150);
});
console.log('playground: watching src/ for changes');
