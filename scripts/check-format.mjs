import { execFileSync } from 'node:child_process';

const base = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : 'HEAD^';

const changedFiles = execFileSync(
  'git',
  ['diff', '--diff-filter=ACMR', '--name-only', `${base}...HEAD`],
  { encoding: 'utf8' },
)
  .split('\n')
  .filter((file) => /\.(cjs|js|json|md|mjs|ts|tsx|yaml|yml)$/.test(file));

if (changedFiles.length === 0) {
  console.log('No format-checkable files changed.');
  process.exit(0);
}

execFileSync('pnpm', ['exec', 'prettier', '--check', ...changedFiles], {
  stdio: 'inherit',
});
