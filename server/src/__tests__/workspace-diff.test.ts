import { execFile } from 'node:child_process';
import { access, chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  captureWorkspaceHead,
  inspectWorkspaceDiff,
  WorkspaceDiffError,
} from '../services/workspace-diff.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return result.stdout.trim();
}

async function createRepository(): Promise<{ directory: string; baseSha: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'eidolon-workspace-diff-'));
  temporaryDirectories.push(directory);
  await git(directory, 'init');
  await git(directory, 'config', 'user.email', 'tests@eidolon.local');
  await git(directory, 'config', 'user.name', 'Eidolon Tests');
  await writeFile(join(directory, 'tracked.txt'), 'before\n');
  await git(directory, 'add', 'tracked.txt');
  await git(directory, 'commit', '-m', 'initial');
  return { directory, baseSha: await captureWorkspaceHead(directory) };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('workspace diff inspection', () => {
  it('reports committed, staged, modified, and untracked files relative to the stored base', async () => {
    const { directory, baseSha } = await createRepository();
    await writeFile(join(directory, 'committed.txt'), 'committed after base\n');
    await git(directory, 'add', 'committed.txt');
    await git(directory, 'commit', '-m', 'after base');
    await writeFile(join(directory, 'tracked.txt'), 'after\n');
    await writeFile(join(directory, 'staged.txt'), 'staged\n');
    await git(directory, 'add', 'staged.txt');
    await writeFile(join(directory, '--untracked.txt'), 'untracked\n');

    const result = await inspectWorkspaceDiff({ workspacePath: directory, baseSha });

    expect(result.baseSha).toBe(baseSha);
    expect(result.headSha).not.toBe(baseSha);
    expect(result.clean).toBe(false);
    expect(result.worktreeClean).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'committed.txt', diffStatus: 'A', untracked: false }),
        expect.objectContaining({ path: 'staged.txt', diffStatus: 'A', stagedStatus: 'A' }),
        expect.objectContaining({ path: 'tracked.txt', diffStatus: 'M', worktreeStatus: 'M' }),
        expect.objectContaining({ path: '--untracked.txt', untracked: true }),
      ]),
    );
    expect(result.stats).toContain('committed.txt');
    expect(result.patch).toContain('committed after base');
    expect(result.patch).not.toContain('--untracked.txt');
  });

  it('bounds retained output and marks a truncated patch', async () => {
    const { directory, baseSha } = await createRepository();
    await writeFile(join(directory, 'tracked.txt'), `${'large diff line\n'.repeat(2_000)}`);

    const result = await inspectWorkspaceDiff({
      workspacePath: directory,
      baseSha,
      maxOutputBytes: 512,
    });

    expect(Buffer.byteLength(result.patch)).toBeLessThanOrEqual(512);
    expect(result.patchTruncated).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it('disables repository-configured external diff and textconv commands', async () => {
    const { directory, baseSha } = await createRepository();
    const markerPath = join(directory, 'external-diff-ran');
    const commandPath = join(directory, 'external-diff.sh');
    await writeFile(commandPath, `#!/bin/sh\ntouch '${markerPath}'\ncat "$1"\n`);
    await chmod(commandPath, 0o755);
    await writeFile(join(directory, '.gitattributes'), 'tracked.txt diff=unsafe\n');
    await git(directory, 'add', '.gitattributes');
    await git(directory, 'commit', '-m', 'configure attributes');
    await git(directory, 'config', 'diff.unsafe.textconv', commandPath);
    await git(directory, 'config', 'diff.external', commandPath);
    await writeFile(join(directory, 'tracked.txt'), 'changed without helpers\n');

    const result = await inspectWorkspaceDiff({ workspacePath: directory, baseSha });

    expect(result.patch).toContain('changed without helpers');
    await expect(access(markerPath)).rejects.toThrow();
  });

  it('returns typed errors for missing, non-repository, nested, and unavailable-base inputs', async () => {
    const missingPath = join(tmpdir(), `eidolon-missing-${process.pid}-${Date.now()}`);
    await expect(captureWorkspaceHead(missingPath)).rejects.toMatchObject({
      code: 'WORKSPACE_PATH_NOT_FOUND',
    } satisfies Partial<WorkspaceDiffError>);

    const nonRepository = await mkdtemp(join(tmpdir(), 'eidolon-not-git-'));
    temporaryDirectories.push(nonRepository);
    await expect(captureWorkspaceHead(nonRepository)).rejects.toMatchObject({
      code: 'WORKSPACE_NOT_GIT_REPOSITORY',
    } satisfies Partial<WorkspaceDiffError>);

    const { directory, baseSha } = await createRepository();
    const nestedDirectory = join(directory, 'nested');
    await mkdir(nestedDirectory);
    await expect(captureWorkspaceHead(nestedDirectory)).rejects.toMatchObject({
      code: 'WORKSPACE_NOT_GIT_REPOSITORY',
    } satisfies Partial<WorkspaceDiffError>);
    await expect(
      inspectWorkspaceDiff({ workspacePath: directory, baseSha: 'f'.repeat(baseSha.length) }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_DIFF_BASE_UNAVAILABLE' } satisfies Partial<WorkspaceDiffError>);
    await expect(
      inspectWorkspaceDiff({ workspacePath: directory, baseSha: 'main' }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_DIFF_BASE_UNAVAILABLE' } satisfies Partial<WorkspaceDiffError>);
  });
});
