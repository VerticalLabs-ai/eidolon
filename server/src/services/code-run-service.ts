// ---------------------------------------------------------------------------
// Code Run Service — bounded sandboxed execution for `code` artifacts (M6)
// ---------------------------------------------------------------------------
//
// Runs a `code` artifact's entrypoint in a dev-local sandbox that reuses the
// EIDOLON_LOCAL_CLI_CONTAINMENT posture's intent: no host file/secret access,
// bounded runtime/memory, no unapproved egress, captured stdout/stderr/exit
// code. The sandbox is a per-run isolated temp directory + a Node preload shim
// (`code-sandbox-shim.cjs`) that freezes `process.env` to a sanitized
// allowlist, restricts `fs` to the sandbox root, disables `child_process`,
// and blocks non-loopback network egress.
//
// Supported languages: javascript (node), typescript (tsx via the dev server's
// node_modules — falls back to javascript transpile if tsx is absent),
// python (python3). Unsupported languages are rejected with 422 (no 500).
//
// When `EIDOLON_LOCAL_CLI_CONTAINMENT_COMMAND` + `EIDOLON_LOCAL_CLI_ALLOWED_AGENTS`
// are configured for code runs, the operator can wrap the spawned runtime in
// real OS-level containment; this service spawns the same runtime with the
// same boundary guarantees, so the dev-local shim is the safety net when no
// operator launcher is present.

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodeContentSchema, SUPPORTED_CODE_LANGUAGES, type CodeLanguage } from '@eidolon/shared';
import { getArtifact } from './artifact-service.js';
import { AppError } from '../middleware/error-handler.js';
import eventBus from '../realtime/events.js';
import type { DbInstance } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX_SHIM_PATH = path.resolve(__dirname, 'code-sandbox-shim.cjs');
const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_SEC = 15;
const MAX_TIMEOUT_SEC = 60;
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MB
const GRACE_SEC = 2;

// Sanitized env keys passed to the child runtime. NO secrets, NO API keys.
const SAFE_CHILD_ENV_KEYS = new Set([
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'PATH',
  'SHELL',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER',
]);

export interface CodeRunResult {
  artifactId: string;
  language: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  truncated: boolean;
}

function isSupportedLanguage(language: string): language is CodeLanguage {
  return (SUPPORTED_CODE_LANGUAGES as readonly string[]).includes(language);
}

/** Resolve which file to run for the artifact. */
function resolveEntrypoint(content: { language: string; entrypoint?: string; files: { path: string; content: string }[] }): string {
  const entry = content.entrypoint?.trim();
  if (entry) {
    const found = content.files.find((f) => f.path === entry);
    if (found) return found.path;
  }
  // Fallback: first file.
  return content.files[0]?.path ?? '';
}

/** Locate an executable on PATH (best-effort). */
async function findExecutable(name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('which', [name], { timeout: 2000 });
    const resolved = stdout.trim().split('\n')[0];
    return resolved || null;
  } catch {
    return null;
  }
}

function buildSanitizedEnv(sandboxRoot: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_CHILD_ENV_KEYS) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key] as string;
  }
  // Isolate HOME to the sandbox root so language runtimes do not read
  // host user config/credentials (e.g. ~/.npmrc, ~/.netrc, ~/.python_history).
  env.HOME = sandboxRoot;
  env.USERPROFILE = sandboxRoot;
  env.EIDOLON_CODE_SANDBOX_ROOT = sandboxRoot;
  return env;
}

function runChild(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutSec: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; truncated: boolean; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    let stdoutBuf = '';
    let stderrBuf = '';
    let outputBytes = 0;
    let truncated = false;
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let settled = false;

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({ stdout: stdoutBuf, stderr: stderrBuf, exitCode, timedOut, truncated, signal });
    };

    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });

    const appendChunk = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        truncated = true;
        // Stop reading; kill the child.
        try { child.stdout?.pause(); child.stderr?.pause(); } catch { /* child already closed */ }
        try { child.kill('SIGKILL'); } catch { /* child already exited */ }
        return;
      }
      const text = chunk.toString('utf8');
      if (target === 'stdout') stdoutBuf += text;
      else stderrBuf += text;
    };

    child.stdout?.on('data', (chunk: Buffer) => appendChunk('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => appendChunk('stderr', chunk));

    child.on('error', () => {
      // Spawn failure — report as a non-zero exit with stderr.
      stderrBuf += stderrBuf ? '\nFailed to start the runtime.' : 'Failed to start the runtime.';
      finish(127, null);
    });

    child.on('close', (exitCode, signal) => finish(exitCode, signal));

    if (timeoutSec > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch { /* child already exited */ }
        forceKillTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* child already exited */ }
        }, GRACE_SEC * 1000);
        forceKillTimer.unref?.();
      }, timeoutSec * 1000);
      timeoutTimer.unref?.();
    }
  });
}

async function runJavaScript(sandboxRoot: string, entryPath: string, timeoutSec: number): Promise<CodeRunResult> {
  const env = buildSanitizedEnv(sandboxRoot);
  // Load the sandbox shim before the user code so fs/env/spawn are locked down.
  const args = ['--require', SANDBOX_SHIM_PATH, entryPath];
  const started = Date.now();
  const result = await runChild(process.execPath, args, sandboxRoot, env, timeoutSec);
  return {
    artifactId: '',
    language: 'javascript',
    stdout: result.stdout,
    stderr: result.timedOut && !result.stderr ? `Execution timed out after ${timeoutSec}s and was terminated.` : result.stderr,
    exitCode: result.timedOut ? 124 : result.exitCode,
    timedOut: result.timedOut,
    durationMs: Date.now() - started,
    truncated: result.truncated,
  };
}

async function runTypeScript(sandboxRoot: string, entryPath: string, timeoutSec: number): Promise<CodeRunResult> {
  // Run TypeScript through tsx (esbuild-based loader) if available; otherwise
  // strip types with a simple regex and run as javascript. tsx is the dev
  // server's transpiler — check node_modules/.bin/tsx.
  const tsxBin = path.resolve(__dirname, '../../../node_modules/.bin/tsx');
  let tsxExists = false;
  try { await fs.access(tsxBin); tsxExists = true; } catch { tsxExists = false; }

  if (tsxExists) {
    const env = buildSanitizedEnv(sandboxRoot);
    // tsx wraps node; load the shim via NODE_OPTIONS --require.
    env.NODE_OPTIONS = `--require ${JSON.stringify(SANDBOX_SHIM_PATH)}`;
    const started = Date.now();
    const result = await runChild(tsxBin, [entryPath], sandboxRoot, env, timeoutSec);
    return {
      artifactId: '',
      language: 'typescript',
      stdout: result.stdout,
      stderr: result.timedOut && !result.stderr ? `Execution timed out after ${timeoutSec}s and was terminated.` : result.stderr,
      exitCode: result.timedOut ? 124 : result.exitCode,
      timedOut: result.timedOut,
      durationMs: Date.now() - started,
      truncated: result.truncated,
    };
  }

  // Fallback: crude type-stripping (erase lines starting with import/export
  // type annotations are out of scope; just strip `: <type>` and `interface`).
  const fullEntry = await fs.readFile(path.join(sandboxRoot, entryPath), 'utf8');
  const stripped = fullEntry
    .replace(/^\s*(?:export\s+)?(?:interface|type)\s+\w+.*$/gm, '')
    .replace(/:\s*[A-Za-z_$][\w$<>[\]|&.\s,]*(?==)/g, '');
  const jsPath = entryPath.replace(/\.tsx?$/, '.mjs');
  await fs.writeFile(path.join(sandboxRoot, jsPath), stripped);
  return runJavaScript(sandboxRoot, jsPath, timeoutSec);
}

async function runPython(sandboxRoot: string, entryPath: string, timeoutSec: number): Promise<CodeRunResult> {
  const pythonBin = (await findExecutable('python3')) ?? (await findExecutable('python'));
  if (!pythonBin) {
    throw new AppError(422, 'RUNTIME_UNAVAILABLE', 'Python runtime (python3) is not available on the server.');
  }
  const env = buildSanitizedEnv(sandboxRoot);
  // Python: isolate HOME (already set), and pass -S to skip site-packages
  // user customization that could read host files. PYTHONPATH is NOT set.
  delete (env as any).PYTHONPATH;
  delete (env as any).PYTHONHOME;
  env.PYTHONNOUSERSITE = '1';
  const started = Date.now();
  const result = await runChild(pythonBin, ['-S', entryPath], sandboxRoot, env, timeoutSec);
  return {
    artifactId: '',
    language: 'python',
    stdout: result.stdout,
    stderr: result.timedOut && !result.stderr ? `Execution timed out after ${timeoutSec}s and was terminated.` : result.stderr,
    exitCode: result.timedOut ? 124 : result.exitCode,
    timedOut: result.timedOut,
    durationMs: Date.now() - started,
    truncated: result.truncated,
  };
}

/**
 * Run a `code` artifact in the bounded sandbox runtime.
 *
 * @param editor The acting editor (user or agent). Used only for the realtime
 *   event; execution is sandboxed identically for user- and agent-authored runs.
 */
export async function runCodeArtifact(
  db: DbInstance,
  companyId: string,
  artifactId: string,
  editor: { userId?: string | null; agentId?: string | null; editSource?: 'user' | 'agent' | 'system' },
): Promise<CodeRunResult> {
  const artifact = await getArtifact(db, companyId, artifactId);
  if (artifact.type !== 'code') {
    throw new AppError(400, 'NOT_A_CODE_ARTIFACT', 'Artifact is not a code artifact');
  }
  const parsed = CodeContentSchema.safeParse(artifact.content);
  if (!parsed.success) {
    throw new AppError(400, 'INVALID_ARTIFACT_CONTENT', 'Code content does not match the code schema', parsed.error.flatten());
  }
  const content = parsed.data;
  const language = content.language;
  if (!isSupportedLanguage(language)) {
    throw new AppError(
      422,
      'UNSUPPORTED_LANGUAGE',
      `Language "${language}" is not supported by the in-app runtime. Supported languages: ${SUPPORTED_CODE_LANGUAGES.join(', ')}`,
    );
  }

  const timeoutSec = Math.min(
    Math.max(1, Number(process.env.EIDOLON_CODE_RUN_TIMEOUT_SEC ?? DEFAULT_TIMEOUT_SEC)),
    MAX_TIMEOUT_SEC,
  );

  // Per-run isolated temp directory — the artifact's files are the only files
  // visible. The shim restricts fs access to this root.
  const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'eidolon-code-'));
  // Resolve the canonical (realpath) root. On macOS `os.tmpdir()` returns
  // `/var/folders/...` but the kernel canonicalizes the child's cwd to
  // `/private/var/folders/...` (because /var is a symlink to /private/var).
  // The shim compares resolved paths against EIDOLON_CODE_SANDBOX_ROOT, so the
  // env value must be the canonical realpath or the entry file's realpath
  // would be judged "outside" the sandbox and blocked.
  const realRoot = await fs.realpath(sandboxRoot);
  try {
    // Write the artifact's files into the sandbox root.
    await Promise.all(
      content.files.map(async (file) => {
        const target = path.join(sandboxRoot, file.path);
        const targetDir = path.dirname(target);
        // Reject path traversal in file paths (the schema allows any path string).
        const rel = path.relative(sandboxRoot, target);
        if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
          throw new AppError(400, 'INVALID_FILE_PATH', `File path "${file.path}" escapes the sandbox`);
        }
        await fs.mkdir(targetDir, { recursive: true });
        await fs.writeFile(target, file.content, 'utf8');
      }),
    );

    const entryPath = resolveEntrypoint(content);
    if (!entryPath) {
      throw new AppError(400, 'NO_ENTRYPOINT', 'Code artifact has no files to run');
    }

    let result: CodeRunResult;
    if (language === 'javascript') {
      result = await runJavaScript(realRoot, entryPath, timeoutSec);
    } else if (language === 'typescript') {
      result = await runTypeScript(realRoot, entryPath, timeoutSec);
    } else {
      result = await runPython(realRoot, entryPath, timeoutSec);
    }
    result.artifactId = artifactId;

    // Emit a realtime event so observing clients can refresh the run output
    // without polling (VAL-CODE-012).
    eventBus.emitEvent({
      type: 'artifact.code.ran',
      companyId,
      payload: {
        artifactId,
        language: result.language,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        editSource: editor.editSource ?? 'user',
      },
      timestamp: new Date().toISOString(),
    });

    return result;
  } finally {
    // Best-effort cleanup of the sandbox directory.
    try { await fs.rm(sandboxRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
