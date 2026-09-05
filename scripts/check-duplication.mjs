import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--fixtures')) {
  throw new Error('Usage: node scripts/check-duplication.mjs [--fixtures]');
}
const fixtures = args.includes('--fixtures');
const config = JSON.parse(readFileSync(new URL('../.jscpd.json', import.meta.url), 'utf8'));
if (fixtures) {
  config.pattern = '**/*.test.{ts,tsx}';
  delete config.threshold;
  console.log('Test-fixture duplication report (informational; no percentage gate).');
} else {
  config.ignore = [
    ...config.ignore,
    '**/*.test.ts',
    '**/*.test.tsx',
    '**/test/**',
    '**/__tests__/**',
  ];
  console.log(`Production-code duplication gate: ${config.threshold}%.`);
}

const temp = mkdtempSync(join(tmpdir(), 'eidolon-duplication-'));
try {
  const configPath = join(temp, 'config.json');
  writeFileSync(configPath, JSON.stringify(config));
  const result = spawnSync('pnpm', ['exec', 'jscpd', '.', '--config', configPath], {
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
