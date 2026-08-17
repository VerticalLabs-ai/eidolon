/**
 * Profile the built UI bundle.
 *
 * The server side of profiling is covered by `pnpm --filter @eidolon/server
 * profile`, which writes a V8 CPU profile. The front end had no equivalent: a
 * dependency that doubles the JavaScript shipped to the browser is invisible in
 * CI, because Vite's build log is not retained anywhere.
 *
 * This walks `ui/dist` and reports raw and gzip size per asset plus a total, as
 * a table for humans and CSV for trend comparison. Gzip is measured rather than
 * estimated because that is what the browser actually downloads.
 *
 * Usage:
 *   pnpm --filter @eidolon/ui build && pnpm profile:ui
 *   pnpm profile:ui -- --csv ui-bundle.csv
 */
import { gzipSync } from 'node:zlib';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DIST = path.resolve('ui/dist');
/** Assets below this size are noise in a size review. */
const REPORTED_MIN_BYTES = 1024;

function parseArgs(argv) {
  const args = { csv: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--csv') {
      args.csv = argv[index + 1] ?? null;
      index += 1;
    }
  }
  return args;
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(absolute) : [absolute];
  });
}

function kind(file) {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.js' || extension === '.mjs') {
    return 'javascript';
  }
  if (extension === '.css') {
    return 'css';
  }
  if (extension === '.html') {
    return 'html';
  }
  if (['.woff', '.woff2', '.ttf', '.otf'].includes(extension)) {
    return 'font';
  }
  if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.ico'].includes(extension)) {
    return 'image';
  }
  return 'other';
}

function kib(bytes) {
  return (bytes / 1024).toFixed(1);
}

let stats;
try {
  stats = statSync(DIST);
} catch {
  console.error(`No UI bundle at ${DIST}. Build it first: pnpm --filter @eidolon/ui build`);
  process.exit(1);
}
if (!stats.isDirectory()) {
  console.error(`${DIST} is not a directory.`);
  process.exit(1);
}

const assets = walk(DIST)
  .map((file) => {
    const contents = readFileSync(file);
    return {
      asset: path.relative(DIST, file),
      kind: kind(file),
      rawBytes: contents.byteLength,
      // Compressible kinds only. Re-gzipping a PNG or a woff2 reports a
      // "compressed" size larger than the original and skews the total.
      gzipBytes: ['javascript', 'css', 'html', 'other'].includes(kind(file))
        ? gzipSync(contents).byteLength
        : contents.byteLength,
    };
  })
  .sort((a, b) => b.gzipBytes - a.gzipBytes);

if (assets.length === 0) {
  console.error(`${DIST} contains no files.`);
  process.exit(1);
}

const byKind = new Map();
for (const asset of assets) {
  const current = byKind.get(asset.kind) ?? { rawBytes: 0, gzipBytes: 0, count: 0 };
  current.rawBytes += asset.rawBytes;
  current.gzipBytes += asset.gzipBytes;
  current.count += 1;
  byKind.set(asset.kind, current);
}

const totalRaw = assets.reduce((sum, asset) => sum + asset.rawBytes, 0);
const totalGzip = assets.reduce((sum, asset) => sum + asset.gzipBytes, 0);

console.log('UI bundle profile');
console.log('');
console.log('By kind:');
for (const [name, totals] of [...byKind].sort((a, b) => b[1].gzipBytes - a[1].gzipBytes)) {
  console.log(
    `  ${name.padEnd(11)} ${String(totals.count).padStart(3)} files  ` +
      `${kib(totals.rawBytes).padStart(9)} KiB raw  ${kib(totals.gzipBytes).padStart(9)} KiB gzip`,
  );
}

console.log('');
console.log(`Largest assets (>= ${kib(REPORTED_MIN_BYTES)} KiB gzip):`);
for (const asset of assets.filter((item) => item.gzipBytes >= REPORTED_MIN_BYTES)) {
  console.log(
    `  ${kib(asset.gzipBytes).padStart(9)} KiB gzip  ` +
      `${kib(asset.rawBytes).padStart(9)} KiB raw  ${asset.asset}`,
  );
}

console.log('');
console.log(
  `Total: ${kib(totalRaw)} KiB raw, ${kib(totalGzip)} KiB gzip across ${assets.length} files.`,
);

const { csv } = parseArgs(process.argv.slice(2));
if (csv) {
  const rows = [
    'asset,kind,raw_bytes,gzip_bytes',
    ...assets.map((asset) => `${asset.asset},${asset.kind},${asset.rawBytes},${asset.gzipBytes}`),
    `TOTAL,all,${totalRaw},${totalGzip}`,
  ];
  writeFileSync(csv, `${rows.join('\n')}\n`);
  console.log(`Wrote ${csv}`);
}
