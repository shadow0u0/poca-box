/**
 * Collapse the built app into one self-contained HTML file.
 *
 * Used for sharing a runnable preview where only a single file can be hosted.
 * The output is *body content only* — no doctype/html/head/body wrapper — so it
 * can be dropped straight into a host page.
 *
 * Everything external is either inlined or removed:
 *   - the CSS bundle becomes a <style>
 *   - the JS bundle becomes an inline <script type="module">
 *   - the service worker, web manifest and icon links are dropped, since there
 *     are no sibling files to fetch
 *
 * Run after `vite build`. Build with BASE_PATH=./ so nothing is emitted with an
 * absolute deployment path.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const outDir = join(root, 'dist-single');
const outFile = join(outDir, 'pocabox.html');

const html = readFileSync(join(dist, 'index.html'), 'utf8');

/** Read a bundle out of dist/assets by extension. Expects exactly one. */
function readBundle(ext) {
  const files = readdirSync(join(dist, 'assets')).filter((f) => f.endsWith(ext));
  if (files.length !== 1) {
    throw new Error(
      `expected exactly one ${ext} bundle in dist/assets, found ${files.length}: ${files.join(', ')}`,
    );
  }
  return readFileSync(join(dist, 'assets', files[0]), 'utf8');
}

const css = readBundle('.css');
const js = readBundle('.js');

// A literal `</script` inside a string in the bundle would close the tag early.
const safeJs = js.replace(/<\/script/gi, '<\\/script');

// Pull out the inline theme bootstrap so it still runs before first paint.
const themeScript = html.match(/<script>\s*\/\/ Applied before first paint[\s\S]*?<\/script>/)?.[0];
if (!themeScript) throw new Error('could not find the theme bootstrap script in dist/index.html');

const parts = [
  `<style>\n${css}\n</style>`,
  themeScript,
  '<div id="root"></div>',
  `<script type="module">\n${safeJs}\n</script>`,
];

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, parts.join('\n'), 'utf8');

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`single-file build → ${outFile}`);
console.log(`  css ${kb(css.length)}  js ${kb(js.length)}  total ${kb(parts.join('\n').length)}`);
