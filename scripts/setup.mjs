import { spawnSync } from 'node:child_process';

const steps = [
  ['Install dependencies', ['install', '--frozen-lockfile']],
  ['Start local Supabase', ['db:start']],
  ['Apply database migrations', ['db:migrate']],
];

for (const [label, args] of steps) {
  console.log(`\n==> ${label}`);
  const result = spawnSync('pnpm', args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) {
    console.error(`Failed to start pnpm: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`${label} failed with exit code ${result.status ?? 1}.`);
    process.exit(result.status ?? 1);
  }
}

console.log('\nSetup complete. Run `pnpm dev` to start the server and UI.');
