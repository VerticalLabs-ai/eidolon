import { constants as fsConstants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_ERROR_BYTES = 16 * 1024;
const DEFAULT_GIT_COMMAND_TIMEOUT_MS = 10_000;
const GIT_COMMAND_KILL_GRACE_MS = 250;
const GIT_SHA_PATTERN = /^[0-9a-f]{40,64}$/i;

export type WorkspaceDiffErrorCode =
  | 'WORKSPACE_PATH_NOT_FOUND'
  | 'WORKSPACE_NOT_GIT_REPOSITORY'
  | 'WORKSPACE_DIFF_BASE_UNAVAILABLE'
  | 'WORKSPACE_DIFF_COMMAND_TIMED_OUT'
  | 'WORKSPACE_DIFF_COMMAND_FAILED';

export class WorkspaceDiffError extends Error {
  constructor(
    public readonly code: WorkspaceDiffErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'WorkspaceDiffError';
  }
}

export interface WorkspaceDiffFile {
  path: string;
  previousPath?: string;
  diffStatus?: string;
  stagedStatus?: string;
  worktreeStatus?: string;
  untracked: boolean;
}

export interface WorkspaceDiffResult {
  workspacePath: string;
  baseSha: string;
  headSha: string;
  clean: boolean;
  worktreeClean: boolean;
  files: WorkspaceDiffFile[];
  stats: string;
  patch: string;
  truncated: boolean;
  statsTruncated: boolean;
  patchTruncated: boolean;
}

export interface InspectWorkspaceDiffOptions {
  workspacePath: string;
  baseSha: string;
  maxOutputBytes?: number;
  commandTimeoutMs?: number;
}

interface GitResult {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

interface MutableWorkspaceDiffFile extends WorkspaceDiffFile {
  sortPath: string;
}

function safeGitEnvironment(): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );

  return {
    ...environment,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
  };
}

async function runGit(
  workspacePath: string,
  args: readonly string[],
  maxOutputBytes: number,
  commandTimeoutMs = DEFAULT_GIT_COMMAND_TIMEOUT_MS,
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], {
      cwd: workspacePath,
      env: safeGitEnvironment(),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      callback();
    };

    const timeoutTimer = setTimeout(() => {
      settle(() => {
        child.kill('SIGTERM');
        forceKillTimer = setTimeout(() => child.kill('SIGKILL'), GIT_COMMAND_KILL_GRACE_MS);
        forceKillTimer.unref?.();
        reject(
          new WorkspaceDiffError(
            'WORKSPACE_DIFF_COMMAND_TIMED_OUT',
            `git ${args[0] ?? ''} exceeded the ${commandTimeoutMs}ms command timeout`,
          ),
        );
      });
    }, commandTimeoutMs);
    timeoutTimer.unref?.();

    const collect = (
      chunk: Buffer,
      chunks: Buffer[],
      byteCount: number,
      limit: number,
    ): { byteCount: number; truncated: boolean } => {
      const remaining = Math.max(0, limit - byteCount);
      if (remaining > 0) {
        const retained = chunk.subarray(0, remaining);
        chunks.push(retained);
        byteCount += retained.length;
      }
      return { byteCount, truncated: chunk.length > remaining };
    };

    child.stdout.on('data', (chunk: Buffer) => {
      const result = collect(chunk, stdoutChunks, stdoutBytes, maxOutputBytes);
      stdoutBytes = result.byteCount;
      stdoutTruncated ||= result.truncated;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const result = collect(chunk, stderrChunks, stderrBytes, MAX_ERROR_BYTES);
      stderrBytes = result.byteCount;
      stderrTruncated ||= result.truncated;
    });
    child.on('error', (error) => {
      settle(() => {
        if (forceKillTimer) clearTimeout(forceKillTimer);
        reject(
          new WorkspaceDiffError(
            'WORKSPACE_DIFF_COMMAND_FAILED',
            `Unable to run git: ${error.message}`,
            error,
          ),
        );
      });
    });
    child.on('close', (code, signal) => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      settle(() => {
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        if (code !== 0) {
          reject(
            new WorkspaceDiffError(
              'WORKSPACE_DIFF_COMMAND_FAILED',
              `git ${args[0] ?? ''} failed (${signal ?? code}): ${stderr.trim() || 'unknown error'}`,
            ),
          );
          return;
        }
        resolve({ stdout, stderr, stdoutTruncated, stderrTruncated });
      });
    });
  });
}

async function resolveWorkspaceRoot(
  workspacePath: string,
  commandTimeoutMs = DEFAULT_GIT_COMMAND_TIMEOUT_MS,
): Promise<string> {
  let resolvedPath: string;
  try {
    await access(workspacePath, fsConstants.R_OK);
    resolvedPath = await realpath(workspacePath);
    if (!(await stat(resolvedPath)).isDirectory()) {
      throw new Error('workspace path is not a directory');
    }
  } catch (error) {
    throw new WorkspaceDiffError(
      'WORKSPACE_PATH_NOT_FOUND',
      `Workspace path is missing or unavailable: ${workspacePath}`,
      error,
    );
  }

  try {
    const result = await runGit(
      resolvedPath,
      ['-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel'],
      DEFAULT_MAX_OUTPUT_BYTES,
      commandTimeoutMs,
    );
    const repositoryRoot = await realpath(result.stdout.trim());
    if (repositoryRoot !== resolvedPath) {
      throw new Error('workspace path is nested inside another repository');
    }
  } catch (error) {
    if (error instanceof WorkspaceDiffError && error.code === 'WORKSPACE_DIFF_COMMAND_TIMED_OUT') {
      throw error;
    }
    throw new WorkspaceDiffError(
      'WORKSPACE_NOT_GIT_REPOSITORY',
      `Workspace is not a Git repository root: ${resolvedPath}`,
      error,
    );
  }

  return resolvedPath;
}

async function captureResolvedWorkspaceHead(
  workspacePath: string,
  commandTimeoutMs = DEFAULT_GIT_COMMAND_TIMEOUT_MS,
): Promise<string> {
  try {
    const result = await runGit(
      workspacePath,
      ['-c', 'core.fsmonitor=false', 'rev-parse', '--verify', 'HEAD^{commit}'],
      DEFAULT_MAX_OUTPUT_BYTES,
      commandTimeoutMs,
    );
    return result.stdout.trim();
  } catch (error) {
    if (error instanceof WorkspaceDiffError && error.code === 'WORKSPACE_DIFF_COMMAND_TIMED_OUT') {
      throw error;
    }
    throw new WorkspaceDiffError(
      'WORKSPACE_DIFF_BASE_UNAVAILABLE',
      `Workspace HEAD is unavailable: ${workspacePath}`,
      error,
    );
  }
}

export async function captureWorkspaceHead(workspacePath: string): Promise<string> {
  const resolvedPath = await resolveWorkspaceRoot(workspacePath);
  return captureResolvedWorkspaceHead(resolvedPath);
}

function parseStatus(output: string, files: Map<string, MutableWorkspaceDiffFile>): void {
  const fields = output.split('\0');
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field || field.length < 4) continue;

    const stagedStatus = field[0];
    const worktreeStatus = field[1];
    const path = field.slice(3);
    const renamed = stagedStatus === 'R' || stagedStatus === 'C' || worktreeStatus === 'R';
    const previousPath = renamed ? fields[index + 1] : undefined;
    if (renamed) index += 1;

    files.set(path, {
      ...files.get(path),
      path,
      sortPath: path,
      previousPath,
      stagedStatus: stagedStatus === ' ' || stagedStatus === '?' ? undefined : stagedStatus,
      worktreeStatus: worktreeStatus === ' ' || worktreeStatus === '?' ? undefined : worktreeStatus,
      untracked: stagedStatus === '?' && worktreeStatus === '?',
    });
  }
}

function parseNameStatus(output: string, files: Map<string, MutableWorkspaceDiffFile>): void {
  const fields = output.split('\0');
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    if (!status) continue;
    const renamed = status.startsWith('R') || status.startsWith('C');
    const previousPath = renamed ? fields[index++] : undefined;
    const path = fields[index++];
    if (!path) continue;

    const existing = files.get(path);
    files.set(path, {
      ...existing,
      path,
      sortPath: path,
      previousPath: existing?.previousPath ?? previousPath,
      diffStatus: status,
      untracked: existing?.untracked ?? false,
    });
  }
}

export async function inspectWorkspaceDiff({
  workspacePath,
  baseSha,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  commandTimeoutMs = DEFAULT_GIT_COMMAND_TIMEOUT_MS,
}: InspectWorkspaceDiffOptions): Promise<WorkspaceDiffResult> {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new RangeError('maxOutputBytes must be a positive integer');
  }
  if (!Number.isSafeInteger(commandTimeoutMs) || commandTimeoutMs <= 0) {
    throw new RangeError('commandTimeoutMs must be a positive integer');
  }

  const resolvedPath = await resolveWorkspaceRoot(workspacePath, commandTimeoutMs);
  if (!GIT_SHA_PATTERN.test(baseSha)) {
    throw new WorkspaceDiffError(
      'WORKSPACE_DIFF_BASE_UNAVAILABLE',
      'Workspace diff base must be a full Git object ID',
    );
  }

  let canonicalBaseSha: string;
  try {
    const base = await runGit(
      resolvedPath,
      ['-c', 'core.fsmonitor=false', 'rev-parse', '--verify', `${baseSha}^{commit}`],
      DEFAULT_MAX_OUTPUT_BYTES,
      commandTimeoutMs,
    );
    canonicalBaseSha = base.stdout.trim();
  } catch (error) {
    if (error instanceof WorkspaceDiffError && error.code === 'WORKSPACE_DIFF_COMMAND_TIMED_OUT') {
      throw error;
    }
    throw new WorkspaceDiffError(
      'WORKSPACE_DIFF_BASE_UNAVAILABLE',
      `Workspace diff base is unavailable: ${baseSha}`,
      error,
    );
  }

  const headSha = await captureResolvedWorkspaceHead(resolvedPath, commandTimeoutMs);
  const sharedArgs = ['-c', 'core.fsmonitor=false'] as const;
  const [status, nameStatus, stats, patch] = await Promise.all([
    runGit(
      resolvedPath,
      [...sharedArgs, 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
      maxOutputBytes,
      commandTimeoutMs,
    ),
    runGit(
      resolvedPath,
      [
        ...sharedArgs,
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--find-renames',
        '--name-status',
        '-z',
        canonicalBaseSha,
        '--',
      ],
      maxOutputBytes,
      commandTimeoutMs,
    ),
    runGit(
      resolvedPath,
      [
        ...sharedArgs,
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--find-renames',
        '--stat',
        canonicalBaseSha,
        '--',
      ],
      maxOutputBytes,
      commandTimeoutMs,
    ),
    runGit(
      resolvedPath,
      [
        ...sharedArgs,
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--find-renames',
        '--patch',
        canonicalBaseSha,
        '--',
      ],
      maxOutputBytes,
      commandTimeoutMs,
    ),
  ]);

  const files = new Map<string, MutableWorkspaceDiffFile>();
  parseStatus(status.stdout, files);
  parseNameStatus(nameStatus.stdout, files);
  const fileList = [...files.values()]
    .sort((left, right) => left.sortPath.localeCompare(right.sortPath))
    .map(({ sortPath: _sortPath, ...file }) => file);
  const statsTruncated = stats.stdoutTruncated || stats.stderrTruncated;
  const patchTruncated = patch.stdoutTruncated || patch.stderrTruncated;
  const truncated =
    status.stdoutTruncated ||
    status.stderrTruncated ||
    nameStatus.stdoutTruncated ||
    nameStatus.stderrTruncated ||
    statsTruncated ||
    patchTruncated;

  return {
    workspacePath: resolvedPath,
    baseSha: canonicalBaseSha,
    headSha,
    clean: fileList.length === 0,
    worktreeClean: status.stdout.length === 0,
    files: fileList,
    stats: stats.stdout,
    patch: patch.stdout,
    truncated,
    statsTruncated,
    patchTruncated,
  };
}
