import { execFile } from 'node:child_process';
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

  it('never reports partial paths from truncated status output', async () => {
    const { directory, baseSha } = await createRepository();
    const expectedPaths = new Set<string>();
    for (let index = 0; index < 40; index += 1) {
      const name = `untracked-${String(index).padStart(2, '0')}-${'name'.repeat(8)}.txt`;
      expectedPaths.add(name);
      await writeFile(join(directory, name), 'contents\n');
    }

    const result = await inspectWorkspaceDiff({
      workspacePath: directory,
      baseSha,
      maxOutputBytes: 512,
    });

    expect(result.truncated).toBe(true);
    expect(result.files.length).toBeLessThan(expectedPaths.size);
    for (const file of result.files) {
      expect(expectedPaths.has(file.path)).toBe(true);
    }
  });

  it('times out and terminates an unresponsive Git subprocess', async () => {
    const { directory, baseSha } = await createRepository();
    const fakeBin = await mkdtemp(join(tmpdir(), 'eidolon-fake-git-'));
    temporaryDirectories.push(fakeBin);
    const pidPath = join(fakeBin, 'git.pid');
    const fakeGitPath = join(fakeBin, 'git');
    await writeFile(
      fakeGitPath,
      `#!/bin/sh\nprintf '%s' "$$" > "${pidPath}"\ntrap '' TERM\nwhile true; do /bin/sleep 1; done\n`,
    );
    await chmod(fakeGitPath, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = fakeBin;
    const startedAt = Date.now();
    try {
      await expect(inspectWorkspaceDiff({
        workspacePath: directory,
        baseSha,
        commandTimeoutMs: 500,
      })).rejects.toMatchObject({
        code: 'WORKSPACE_DIFF_COMMAND_TIMED_OUT',
      } satisfies Partial<WorkspaceDiffError>);
    } finally {
      process.env.PATH = originalPath;
    }
    expect(Date.now() - startedAt).toBeLessThan(1_500);

    await new Promise((resolve) => setTimeout(resolve, 400));
    const childPid = Number(await readFile(pidPath, 'utf8'));
    expect(() => process.kill(childPid, 0)).toThrow();
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
