import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '../../app/frontend');
const target = path.resolve(here, '../www');

// Files the Android app cannot work without. Anything else the page references is discovered from index.html below.
const REQUIRED = [
  'index.html', 'app.js', 'styles.css', 'manifest.webmanifest',
  'native-adapter.js', 'offline-store.js', 'offline-sync.js', 'local-media.js',
  'workflow-state.js', 'workflow-ui.js', 'daily-log.js', 'farm-membership.js',
  'vendor/tailwind.generated.css', 'vendor/lucide-0.468.0.umd.min.js',
  'vendor/fonts/google-sans/GoogleSans-latin.woff',
];
// Web-only files that must never ship inside the APK.
const FORBIDDEN = ['admin.html', 'admin.js', 'sw.js'];

function fail(message) {
  console.error(`sync-assets FAILED: ${message}`);
  process.exit(1);
}

async function exists(file) {
  try { await stat(file); return true; } catch { return false; }
}

await stat(path.join(source, 'index.html')).catch(() => fail(`no index.html in ${source}`));
const vocabulary = JSON.parse(await readFile(path.join(source, '../reference/problem-vocabulary.json'), 'utf8'));
const registry = await readFile(path.join(source, 'problem-registry.js'), 'utf8');
if (!registry.includes('const data=' + JSON.stringify(vocabulary) + ';')) {
  fail('Problem vocabulary changed. Run python tools/sync-problem-vocabulary.py from the project root.');
}
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, {
  recursive: true,
  filter: (entry) => !FORBIDDEN.includes(path.basename(entry)),
});

const missing = [];
for (const file of REQUIRED) if (!(await exists(path.join(target, file)))) missing.push(file);

// Every local script/stylesheet/image the page references must have been copied.
const html = await readFile(path.join(target, 'index.html'), 'utf8');
for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
  const ref = match[1].split('?')[0];
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref) || ref.startsWith('data:')) continue;
  if (ref.startsWith('/downloads/') || ref.startsWith('downloads/')) continue;
  const relative = ref.replace(/^\//, '');
  if (relative && !(await exists(path.join(target, relative)))) missing.push(`${relative} (referenced by index.html)`);
}
if (missing.length) fail(`missing in ${target}:\n  - ${[...new Set(missing)].join('\n  - ')}`);

const leaked = [];
for (const file of FORBIDDEN) if (await exists(path.join(target, file))) leaked.push(file);
if (leaked.length) fail(`web-only files were copied into the app: ${leaked.join(', ')}`);

console.log(`Bundled app assets copied from ${source} to ${target}; ${REQUIRED.length} required files verified; ${FORBIDDEN.join(', ')} excluded.`);
