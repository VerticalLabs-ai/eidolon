import { execFile, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const DEFAULT_TIMEOUT_SEC = 600;
const DEFAULT_GRACE_SEC = 20;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const MAX_TRANSCRIPT_ENTRIES = 5_000;
const MAX_TRANSCRIPT_LINE_LENGTH = 100_000;
const SUPERVISOR_SHUTDOWN_BUFFER_MS = 500;
export const LOCAL_CLI_SUPERVISOR_LEASE_TIMEOUT_MS = 15_000;
const SUPERVISOR_LEASE_FORWARD_INTERVAL_MS = 250;
const SAFE_INHERITED_ENV_KEYS = [
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER',
] as const;
const WINDOWS_BASELINE_ENV_KEYS = [
  'ComSpec',
  'PATHEXT',
  'SystemRoot',
  'WINDIR',
] as const;
const SAFE_CLI_ARGUMENT = /^[A-Za-z0-9._:/@+-]+$/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORBIDDEN_ADAPTER_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'BASH_ENV',
  'BUN_OPTIONS',
  'CODEX_API_KEY',
  'CODEX_HOME',
  'DOTNET_STARTUP_HOOKS',
  'ENV',
  'HOME',
  'JAVA_TOOL_OPTIONS',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PATH',
  'PERL5OPT',
  'PERLLIB',
  'PYTHONHOME',
  'PYTHONPATH',
  'RUBYLIB',
  'RUBYOPT',
  'SHELL',
  'SYSTEMROOT',
  'USERPROFILE',
  'WINDIR',
  'ZDOTDIR',
  '_JAVA_OPTIONS',
]);
const LOCAL_CLI_SUPERVISOR_PATH = fileURLToPath(
  new URL('./local-cli-supervisor.mjs', import.meta.url),
);
const execFileAsync = promisify(execFile);

export const LOCAL_CLI_ADAPTER_IDS = ['codex_local', 'claude_local'] as const;
export type LocalCliAdapterId = (typeof LOCAL_CLI_ADAPTER_IDS)[number];
export const PROCESS_RUNTIME_ADAPTER_ID = 'process:local' as const;
const LOCAL_CLI_PROVIDER_ENV_KEYS: Record<LocalCliAdapterId, string> = {
  codex_local: 'CODEX_API_KEY',
  claude_local: 'ANTHROPIC_API_KEY',
};

export interface LocalCliTranscriptEntry extends Record<string, unknown> {
  timestamp: string;
  stream: 'stdout' | 'stderr' | 'system';
  kind: 'json' | 'text' | 'diagnostic';
  content?: string;
  data?: Record<string, unknown>;
}

export interface RunLocalCliAdapterInput {
  adapterId: string;
  prompt: string;
  adapterConfig: Record<string, unknown>;
  companyId: string;
  agentId: string;
  sessionId: string;
  environmentId?: string | null;
  workspacePath?: string | null;
  resumeState?: Record<string, unknown>;
  signal?: AbortSignal;
  leaseHeartbeatAt: () => number;
}

export interface LocalCliRunResult {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  aborted: boolean;
  timedOut: boolean;
  durationMs: number;
  summary: string | null;
  transcript: LocalCliTranscriptEntry[];
  resumeState: Record<string, unknown>;
  diagnostic: Record<string, unknown>;
}

export function isLocalCliAdapterId(value: string): value is LocalCliAdapterId {
  return LOCAL_CLI_ADAPTER_IDS.includes(value as LocalCliAdapterId);
}

export function isProcessRuntimeAdapterId(
  value: string,
): value is typeof PROCESS_RUNTIME_ADAPTER_ID {
  return value === PROCESS_RUNTIME_ADAPTER_ID;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return Math.min(value, maximum);
}

export function normalizeLocalCliGraceSec(value: unknown): number {
  return asNumber(value, DEFAULT_GRACE_SEC, 300);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readHostEnvCaseInsensitive(key: string): string | undefined {
  const match = Object.entries(process.env).find(
    ([candidate]) => candidate.toUpperCase() === key.toUpperCase(),
  );
  return match?.[1];
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function parseEnvAllowlist(): Set<string> {
  return new Set(
    (process.env.EIDOLON_LOCAL_CLI_ENV_ALLOWLIST ?? '')
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean),
  );
}

async function resolveProcessCommand(
  config: Record<string, unknown>,
): Promise<{ command: string; args: string[] }> {
  const command = asString(config.command).trim();
  const args = Array.isArray(config.args) &&
    config.args.every((value) => typeof value === 'string')
    ? config.args as string[]
    : [];
  if (!command || !path.isAbsolute(command)) {
    throw new Error(
      'process:local adapterConfig.command must be an absolute executable path.',
    );
  }
  if (config.args !== undefined && !Array.isArray(config.args)) {
    throw new Error('process:local adapterConfig.args must be an array of strings.');
  }
  if (
    Array.isArray(config.args) &&
    config.args.some((value) => typeof value !== 'string')
  ) {
    throw new Error('process:local adapterConfig.args must contain only strings.');
  }

  let presets: unknown;
  try {
    presets = JSON.parse(
      process.env.EIDOLON_PROCESS_COMMAND_ALLOWLIST_JSON ?? '[]',
    );
  } catch {
    throw new Error(
      'EIDOLON_PROCESS_COMMAND_ALLOWLIST_JSON must be a JSON array of argv arrays.',
    );
  }
  const allowed = Array.isArray(presets)
    ? presets.some(
        (preset) =>
          Array.isArray(preset) &&
          preset.every((value) => typeof value === 'string') &&
          JSON.stringify(preset) === JSON.stringify([command, ...args]),
      )
    : false;
  if (!allowed) {
    throw new Error(
      `process:local argv ${JSON.stringify([command, ...args])} is not in EIDOLON_PROCESS_COMMAND_ALLOWLIST_JSON.`,
    );
  }
  await fs.access(command, fsConstants.X_OK);
  const commandStats = await fs.stat(command);
  if (!commandStats.isFile()) {
    throw new Error(
      `process:local adapterConfig.command "${command}" must be a regular executable file.`,
    );
  }
  return { command, args };
}

export async function testProcessRuntimeAdapter(input: {
  companyId: string;
  agentId: string;
  adapterConfig: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  assertOperatorAuthorized(input.companyId, input.agentId);
  const containmentCommand = await resolveContainmentCommand();
  const { command, args } = await resolveProcessCommand(
    asRecord(input.adapterConfig),
  );
  return {
    ok: true,
    adapterId: PROCESS_RUNTIME_ADAPTER_ID,
    command,
    args,
    containmentCommand,
    message: 'Process command and containment launcher are executable and operator-approved.',
  };
}

function assertOperatorAuthorized(companyId: string, agentId: string): void {
  const allowedAgents = new Set(
    (process.env.EIDOLON_LOCAL_CLI_ALLOWED_AGENTS ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  if (!allowedAgents.has(`${companyId}:${agentId}`)) {
    throw new Error(
      `Local CLI execution for agent ${agentId} is not operator-authorized. Add ${companyId}:${agentId} to EIDOLON_LOCAL_CLI_ALLOWED_AGENTS.`,
    );
  }
}

function assertSafeCliArgument(label: string, value: string): void {
  if (value && !SAFE_CLI_ARGUMENT.test(value)) {
    throw new Error(`${label} contains unsupported characters.`);
  }
}

function isForbiddenAdapterEnvKey(key: string): boolean {
  const normalizedKey = key.toUpperCase();
  return (
    FORBIDDEN_ADAPTER_ENV_KEYS.has(normalizedKey) ||
    normalizedKey.startsWith('ANTHROPIC_') ||
    normalizedKey.startsWith('OPENAI_') ||
    normalizedKey.startsWith('AZURE_OPENAI_') ||
    normalizedKey.startsWith('DYLD_') ||
    normalizedKey.startsWith('LD_') ||
    normalizedKey.startsWith('GIT_CONFIG_') ||
    normalizedKey.includes('PROXY') ||
    normalizedKey.endsWith('_BASE_URL') ||
    normalizedKey.endsWith('_API_BASE') ||
    normalizedKey.endsWith('_ENDPOINT') ||
    [
      'CURL_CA_BUNDLE',
      'GIT_SSL_CAINFO',
      'NODE_EXTRA_CA_CERTS',
      'REQUESTS_CA_BUNDLE',
      'SSL_CERT_DIR',
      'SSL_CERT_FILE',
    ].includes(normalizedKey)
  );
}

function boundJsonValue(
  value: unknown,
  budget: { remaining: number },
  depth = 0,
): unknown {
  if (budget.remaining <= 0) return '[truncated]';
  if (typeof value === 'string') {
    const retained = value.slice(0, budget.remaining);
    budget.remaining -= retained.length;
    return retained.length < value.length ? `${retained}[truncated]` : retained;
  }
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    budget.remaining -= 16;
    return value;
  }
  if (depth >= 12) {
    budget.remaining -= 16;
    return '[truncated]';
  }
  if (Array.isArray(value)) {
    const retained: unknown[] = [];
    for (const entry of value) {
      if (budget.remaining <= 0) break;
      retained.push(boundJsonValue(entry, budget, depth + 1));
    }
    if (retained.length < value.length) retained.push('[truncated]');
    return retained;
  }
  if (typeof value === 'object') {
    const retained: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (budget.remaining <= 0) break;
      budget.remaining -= key.length;
      retained[key] = boundJsonValue(entry, budget, depth + 1);
    }
    return retained;
  }
  budget.remaining -= 16;
  return String(value);
}

function boundJsonData(
  data: Record<string, unknown>,
  originalBytes: number,
): Record<string, unknown> {
  if (originalBytes <= MAX_TRANSCRIPT_LINE_LENGTH) return data;
  const bounded = boundJsonValue(
    data,
    { remaining: Math.floor(MAX_TRANSCRIPT_LINE_LENGTH / 2) },
  ) as Record<string, unknown>;
  return {
    ...bounded,
    _eidolon: {
      truncated: true,
      originalBytes,
    },
  };
}

function configuredWorkspaceRoot(): string {
  const configuredRoot =
    process.env.EIDOLON_WORKSPACE_ROOT ??
    path.join(process.cwd(), '.eidolon', 'workspaces');
  return path.resolve(expandHome(configuredRoot));
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function resolveWorkspaceCwd(input: RunLocalCliAdapterInput): Promise<string> {
  const configuredRoot = configuredWorkspaceRoot();
  await fs.mkdir(configuredRoot, { recursive: true });
  const realConfiguredRoot = await fs.realpath(configuredRoot);
  const companyRoot = path.join(realConfiguredRoot, input.companyId);
  try {
    await fs.mkdir(companyRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const companyRootStat = await fs.lstat(companyRoot);
  if (companyRootStat.isSymbolicLink() || !companyRootStat.isDirectory()) {
    throw new Error('Company workspace root must be a real directory.');
  }
  const realRoot = await fs.realpath(companyRoot);
  const configuredCwd = asString(input.adapterConfig.cwd).trim();
  const resumedCwd = asString(input.resumeState?.cwd).trim();
  const requested =
    configuredCwd ||
    input.workspacePath ||
    resumedCwd;
  if (!requested) {
    return fs.mkdtemp(
      path.join(realRoot, `${input.agentId}-${input.sessionId}-`),
    );
  }
  const expanded = expandHome(requested);
  const candidate = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(realRoot, expanded);
  let cwd: string;
  try {
    cwd = await fs.realpath(candidate);
  } catch {
    throw new Error(
      `Configured cwd must already exist within the company workspace root: ${realRoot}`,
    );
  }
  const relative = path.relative(realRoot, cwd);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Configured cwd must be within the company workspace root: ${realRoot}`);
  }
  const cwdStat = await fs.stat(cwd);
  if (!cwdStat.isDirectory()) throw new Error(`Configured cwd is not a directory: ${cwd}`);
  return cwd;
}

async function resolveContainmentCommand(): Promise<string> {
  const requested = process.env.EIDOLON_LOCAL_CLI_CONTAINMENT_COMMAND?.trim();
  if (!requested) {
    throw new Error(
      'EIDOLON_LOCAL_CLI_CONTAINMENT_COMMAND must name an operator-managed cgroup, container, job-object, or equivalent descendant-containment launcher.',
    );
  }
  const expanded = expandHome(requested);
  if (!path.isAbsolute(expanded)) {
    throw new Error('EIDOLON_LOCAL_CLI_CONTAINMENT_COMMAND must be an absolute executable path.');
  }
  const resolved = path.resolve(expanded);
  try {
    await fs.access(resolved, fsConstants.X_OK);
    return await fs.realpath(resolved);
  } catch {
    throw new Error(
      `Containment command "${requested}" is not an executable file.`,
    );
  }
}

function containmentArgs(): string[] {
  const raw = process.env.EIDOLON_LOCAL_CLI_CONTAINMENT_ARGS_JSON?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('EIDOLON_LOCAL_CLI_CONTAINMENT_ARGS_JSON must be a JSON string array.');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > 32 ||
    parsed.some((entry) => typeof entry !== 'string' || entry.includes('\0'))
  ) {
    throw new Error(
      'EIDOLON_LOCAL_CLI_CONTAINMENT_ARGS_JSON must contain at most 32 string arguments.',
    );
  }
  return parsed;
}

async function resolveOperatorCommand(adapterId: LocalCliAdapterId): Promise<string> {
  const defaultCommand = adapterId === 'codex_local' ? 'codex' : 'claude';
  const configured =
    adapterId === 'codex_local'
      ? process.env.EIDOLON_CODEX_CLI_COMMAND
      : process.env.EIDOLON_CLAUDE_CLI_COMMAND;
  const requested = configured?.trim() || defaultCommand;

  if (configured && !path.isAbsolute(expandHome(requested))) {
    const variable =
      adapterId === 'codex_local'
        ? 'EIDOLON_CODEX_CLI_COMMAND'
        : 'EIDOLON_CLAUDE_CLI_COMMAND';
    throw new Error(`${variable} must be an absolute executable path.`);
  }

  const expandedRequested = expandHome(requested);
  const baseCandidates = path.isAbsolute(expandedRequested)
    ? [path.resolve(expandedRequested)]
    : (process.env.PATH ?? '')
        .split(path.delimiter)
        .filter(Boolean)
        .map((directory) => path.join(directory, requested));
  const extensions =
    process.platform === 'win32' && path.extname(expandedRequested) === ''
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter(Boolean)
      : [''];
  const candidates = baseCandidates.flatMap((candidate) =>
    extensions.map((extension) => `${candidate}${extension}`),
  );

  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return await fs.realpath(candidate);
    } catch {
      // Continue searching the server-controlled PATH.
    }
  }

  throw new Error(`Command "${requested}" is not installed or is not available on the server PATH.`);
}

async function issueLocalGatewayToken(
  input: RunLocalCliAdapterInput,
  adapterId: LocalCliAdapterId,
): Promise<{
  baseUrl: string;
  token: string;
}> {
  const adapterName = adapterId === 'codex_local' ? 'Codex' : 'Claude';
  const configurationPrefix =
    adapterId === 'codex_local' ? 'EIDOLON_CODEX' : 'EIDOLON_CLAUDE';
  const rawBaseUrl =
    process.env[`${configurationPrefix}_GATEWAY_URL`]?.trim();
  const rawTokenCommand =
    process.env[`${configurationPrefix}_GATEWAY_TOKEN_COMMAND`]?.trim();
  if (!rawBaseUrl || !rawTokenCommand) {
    throw new Error(
      `${adapterName} local execution requires ${configurationPrefix}_GATEWAY_URL and an operator-owned ${configurationPrefix}_GATEWAY_TOKEN_COMMAND that mints a short-lived gateway token.`,
    );
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    throw new Error(`${configurationPrefix}_GATEWAY_URL must be a valid URL.`);
  }
  const isLoopback =
    ['127.0.0.1', '::1', 'localhost'].includes(baseUrl.hostname);
  if (
    (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && isLoopback)) ||
    baseUrl.username ||
    baseUrl.password
  ) {
    throw new Error(
      `${configurationPrefix}_GATEWAY_URL must use HTTPS (or loopback HTTP) and must not contain credentials.`,
    );
  }

  const expandedCommand = expandHome(rawTokenCommand);
  if (!path.isAbsolute(expandedCommand)) {
    throw new Error(
      `${configurationPrefix}_GATEWAY_TOKEN_COMMAND must be an absolute executable path.`,
    );
  }
  let tokenCommand: string;
  try {
    await fs.access(expandedCommand, fsConstants.X_OK);
    tokenCommand = await fs.realpath(expandedCommand);
  } catch {
    throw new Error(
      `${configurationPrefix}_GATEWAY_TOKEN_COMMAND must reference an executable operator-owned helper.`,
    );
  }

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(tokenCommand, [], {
      cwd: os.tmpdir(),
      env: {
        ...process.env,
        [`${configurationPrefix}_TOKEN_COMPANY_ID`]: input.companyId,
        [`${configurationPrefix}_TOKEN_AGENT_ID`]: input.agentId,
        [`${configurationPrefix}_TOKEN_SESSION_ID`]: input.sessionId,
      },
      maxBuffer: 16 * 1024,
      timeout: 5_000,
      windowsHide: true,
    }));
  } catch {
    throw new Error(
      `${adapterName} gateway token helper failed or timed out; inspect the operator-owned helper logs.`,
    );
  }
  const token = stdout.trim();
  if (!token || token.length > 8_192 || /[\r\n\0]/.test(token)) {
    throw new Error(
      `${adapterName} gateway token helper must return one non-empty token of at most 8192 characters.`,
    );
  }
  return { baseUrl: baseUrl.toString().replace(/\/$/, ''), token };
}

function buildCodexArgs(
  config: Record<string, unknown>,
  resumeState: Record<string, unknown>,
  toolEnvKeys: string[],
  gatewayBaseUrl: string,
): string[] {
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--strict-config',
    '--disable',
    'shell_snapshot',
    '-c',
    'approval_policy="never"',
    '-c',
    'allow_login_shell=false',
    '-c',
    'default_permissions="eidolon"',
    '-c',
    'permissions.eidolon.filesystem.:minimal="read"',
    '-c',
    'permissions.eidolon.filesystem.:workspace_roots="write"',
    '-c',
    'permissions.eidolon.network.enabled=false',
    '-c',
    'shell_environment_policy.inherit="all"',
    '-c',
    `shell_environment_policy.include_only=${JSON.stringify(toolEnvKeys)}`,
    '-c',
    'model_provider="eidolon_gateway"',
    '-c',
    'model_providers.eidolon_gateway.name="Eidolon Gateway"',
    '-c',
    `model_providers.eidolon_gateway.base_url=${JSON.stringify(gatewayBaseUrl)}`,
    '-c',
    'model_providers.eidolon_gateway.env_key="CODEX_API_KEY"',
    '-c',
    'model_providers.eidolon_gateway.wire_api="responses"',
    '-c',
    'model_providers.eidolon_gateway.requires_openai_auth=false',
  ];
  const model = asString(config.model).trim();
  if (model && model !== 'codex-default') {
    assertSafeCliArgument('Codex model', model);
    args.push('--model', model);
  }

  const sessionId = asString(resumeState.sessionId).trim();
  if (sessionId) {
    if (!SESSION_ID.test(sessionId)) throw new Error('Codex session ID must be a UUID.');
    args.push('resume', sessionId, '-');
  }
  else args.push('-');
  return args;
}

function buildClaudeArgs(
  config: Record<string, unknown>,
  resumeState: Record<string, unknown>,
): string[] {
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--bare',
    '--safe-mode',
    '--strict-mcp-config',
    '--permission-mode',
    'bypassPermissions',
    '--tools',
    'default',
  ];
  const sessionId = asString(resumeState.sessionId).trim();
  if (sessionId) {
    if (!SESSION_ID.test(sessionId)) throw new Error('Claude session ID must be a UUID.');
    args.push('--resume', sessionId);
  }

  const model = asString(config.model).trim();
  if (model && model !== 'claude-default') {
    assertSafeCliArgument('Claude model', model);
    args.push('--model', model);
  }
  const maxTurns = asNumber(config.maxTurns, 0, 10_000);
  if (maxTurns > 0) args.push('--max-turns', String(maxTurns));
  return args;
}

function sessionIdFromEvent(event: Record<string, unknown>): string | null {
  for (const candidate of [event.session_id, event.thread_id, event.sessionId]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

function textFromEvent(event: Record<string, unknown>): string | null {
  if (event.type === 'result' && typeof event.result === 'string') {
    return event.result;
  }

  const item = asRecord(event.item);
  if (item.type === 'agent_message' && typeof item.text === 'string') {
    return item.text;
  }

  const message = asRecord(event.message);
  if (Array.isArray(message.content)) {
    const text = message.content
      .map((entry) => asRecord(entry))
      .filter((entry) => entry.type === 'text' && typeof entry.text === 'string')
      .map((entry) => entry.text as string)
      .join('');
    if (text) return text;
  }

  return null;
}

function failureMessage(input: {
  command: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  aborted: boolean;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  spawnError: Error | null;
  stderrTail: string[];
}): string {
  if (input.spawnError) {
    if ((input.spawnError as NodeJS.ErrnoException).code === 'ENOENT') {
      return `Command "${input.command}" is not installed or is not available on PATH.`;
    }
    return `Failed to start "${input.command}": ${input.spawnError.message}`;
  }
  if (input.aborted) return `Command "${input.command}" was cancelled by an operator.`;
  if (input.timedOut) return `Command "${input.command}" exceeded its configured timeout.`;
  if (input.outputLimitExceeded) {
    return `Command "${input.command}" exceeded the ${MAX_OUTPUT_BYTES}-byte output safety limit.`;
  }

  const stderr = input.stderrTail.join('\n').trim();
  const status = input.signal
    ? `signal ${input.signal}`
    : `exit code ${input.exitCode ?? 'unknown'}`;
  return stderr
    ? `Command "${input.command}" failed with ${status}: ${stderr}`
    : `Command "${input.command}" failed with ${status}.`;
}

export async function runLocalCliAdapter(
  input: RunLocalCliAdapterInput,
): Promise<LocalCliRunResult> {
  if (
    !isLocalCliAdapterId(input.adapterId) &&
    !isProcessRuntimeAdapterId(input.adapterId)
  ) {
    throw new Error(
      `Unsupported local process adapter "${input.adapterId}".`,
    );
  }
  assertOperatorAuthorized(input.companyId, input.agentId);
  if (input.signal?.aborted) {
    throw new Error('Local CLI execution was cancelled before it started.');
  }

  const config = asRecord(input.adapterConfig);
  if (!isProcessRuntimeAdapterId(input.adapterId) && config.command !== undefined) {
    throw new Error(
      'adapterConfig.command is not allowed. Configure the server-owned CLI path with EIDOLON_CODEX_CLI_COMMAND or EIDOLON_CLAUDE_CLI_COMMAND.',
    );
  }
  if (config.codexHome !== undefined) {
    throw new Error(
      'adapterConfig.codexHome is not allowed. Configure the operator-owned root with EIDOLON_RUNTIME_HOME.',
    );
  }
  if (!isProcessRuntimeAdapterId(input.adapterId) && config.args !== undefined) {
    throw new Error(
      'adapterConfig.args is not allowed. Local CLI arguments are controlled by the Eidolon server.',
    );
  }
  if (
    config.dangerouslyBypassApprovalsAndSandbox !== undefined ||
    config.dangerouslySkipPermissions !== undefined
  ) {
    throw new Error(
      'Permission-bypass adapter options are not allowed. Local CLI permissions are controlled by the Eidolon server.',
    );
  }
  const cwd = await resolveWorkspaceCwd(input);
  const containmentCommand = await resolveContainmentCommand();
  const containmentCommandArgs = containmentArgs();
  const processCommand = isProcessRuntimeAdapterId(input.adapterId)
    ? await resolveProcessCommand(config)
    : null;
  const command = processCommand?.command ??
    await resolveOperatorCommand(input.adapterId as LocalCliAdapterId);
  const configuredEnv = asRecord(config.env);
  if (configuredEnv.CODEX_HOME !== undefined) {
    throw new Error('adapterConfig.env.CODEX_HOME is not allowed; Eidolon manages isolated Codex homes.');
  }
  const envAllowlist = parseEnvAllowlist();
  const env: Record<string, string> = {};
  for (const key of SAFE_INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string') env[key] = value;
  }
  if (process.platform === 'win32') {
    for (const key of WINDOWS_BASELINE_ENV_KEYS) {
      const value = readHostEnvCaseInsensitive(key);
      if (value) env[key] = value;
    }
  }
  const supervisorEnv = { ...env };
  let taskkillPath: string | null = null;
  if (process.platform === 'win32') {
    const systemRoot = readHostEnvCaseInsensitive('SystemRoot');
    if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
      throw new Error(
        'Windows local CLI execution requires an absolute operator-owned SystemRoot.',
      );
    }
    supervisorEnv.SystemRoot = systemRoot;
    taskkillPath = path.win32.join(systemRoot, 'System32', 'taskkill.exe');
  }
  for (const [key, value] of Object.entries(configuredEnv)) {
    if (isForbiddenAdapterEnvKey(key)) {
      throw new Error(
        `Adapter environment variable "${key}" cannot be set because it can alter the host launcher or expose operator credentials.`,
      );
    }
    if (!envAllowlist.has(key)) {
      throw new Error(
        `Adapter environment variable "${key}" is not allowed. Add it to EIDOLON_LOCAL_CLI_ENV_ALLOWLIST on the server.`,
      );
    }
    if (typeof value !== 'string') {
      throw new Error(`Adapter environment variable "${key}" must be a string.`);
    }
    env[key] = value;
  }
  let codexGatewayBaseUrl: string | null = null;
  if (isLocalCliAdapterId(input.adapterId)) {
    const gatewayCredential = await issueLocalGatewayToken(input, input.adapterId);
    env[LOCAL_CLI_PROVIDER_ENV_KEYS[input.adapterId]] = gatewayCredential.token;
    if (input.adapterId === 'claude_local') {
      env.ANTHROPIC_BASE_URL = gatewayCredential.baseUrl;
      env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1';
    } else {
      codexGatewayBaseUrl = gatewayCredential.baseUrl;
    }
  }

  const runtimeRoot = path.resolve(
    expandHome(process.env.EIDOLON_RUNTIME_HOME ?? path.join(os.homedir(), '.eidolon', 'runtime')),
  );
  const adapterRuntimeHome = path.join(
    runtimeRoot,
    input.companyId,
    input.agentId,
    ...(input.environmentId ? [input.environmentId] : []),
    input.adapterId,
  );
  await fs.mkdir(adapterRuntimeHome, { recursive: true });
  env.HOME = adapterRuntimeHome;
  env.USERPROFILE = adapterRuntimeHome;
  env.XDG_CACHE_HOME = path.join(adapterRuntimeHome, '.cache');
  env.XDG_CONFIG_HOME = path.join(adapterRuntimeHome, '.config');

  let codexHome: string | null = null;
  if (input.adapterId === 'codex_local') {
    codexHome = path.join(adapterRuntimeHome, 'codex-home');
    await fs.mkdir(codexHome, { recursive: true });
    if (await pathExists(path.join(codexHome, 'auth.json'))) {
      throw new Error(
        'Codex file credentials are not allowed in the agent runtime. Remove codex-home/auth.json and use the operator-owned Codex gateway token helper instead.',
      );
    }
    env.CODEX_HOME = codexHome;
  }

  const resumeState = asRecord(input.resumeState);
  const codexToolEnvKeys = Array.from(
    new Set([
      ...SAFE_INHERITED_ENV_KEYS,
      ...(process.platform === 'win32' ? WINDOWS_BASELINE_ENV_KEYS : []),
      ...Object.keys(configuredEnv),
    ]),
  ).sort();
  const args = processCommand?.args ??
    (input.adapterId === 'codex_local'
      ? buildCodexArgs(config, resumeState, codexToolEnvKeys, codexGatewayBaseUrl!)
      : buildClaudeArgs(config, resumeState));
  const requestedTimeoutSec = asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC, 86_400);
  const timeoutSec = requestedTimeoutSec > 0 ? requestedTimeoutSec : DEFAULT_TIMEOUT_SEC;
  const graceSec = normalizeLocalCliGraceSec(config.graceSec);
  const startedAt = Date.now();
  const transcript: LocalCliTranscriptEntry[] = [];
  const stderrTail: string[] = [];
  let summary: string | null = null;
  let sessionId = asString(resumeState.sessionId).trim() || null;
  let outputBytes = 0;
  let outputLimitExceeded = false;
  let aborted = false;
  let timedOut = false;
  let spawnError: Error | null = null;
  let stdoutBuffer = '';
  let stderrBuffer = '';
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  let transcriptStart = 0;

  const retainTranscriptEntry = (entry: LocalCliTranscriptEntry) => {
    if (transcript.length < MAX_TRANSCRIPT_ENTRIES) {
      transcript.push(entry);
      return;
    }
    transcript[transcriptStart] = entry;
    transcriptStart = (transcriptStart + 1) % MAX_TRANSCRIPT_ENTRIES;
  };

  const appendLine = (stream: 'stdout' | 'stderr', rawLine: string) => {
    if (!rawLine) return;
    const originalBytes = Buffer.byteLength(rawLine, 'utf8');
    const content = rawLine.slice(0, MAX_TRANSCRIPT_LINE_LENGTH);
    if (stream === 'stderr') {
      stderrTail.push(content);
      if (stderrTail.length > 20) stderrTail.shift();
    }

    try {
      const parsed = JSON.parse(rawLine);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const data = parsed as Record<string, unknown>;
        sessionId = sessionIdFromEvent(data) ?? sessionId;
        const eventSummary = textFromEvent(data);
        if (eventSummary) {
          summary = eventSummary.slice(0, MAX_TRANSCRIPT_LINE_LENGTH);
        }
        retainTranscriptEntry({
          timestamp: new Date().toISOString(),
          stream,
          kind: 'json',
          data: boundJsonData(data, originalBytes),
        });
        return;
      }
    } catch {
      // Plain output is expected from diagnostics and custom CLI wrappers.
    }

    retainTranscriptEntry({
      timestamp: new Date().toISOString(),
      stream,
      kind: 'text',
      content,
    });
    if (stream === 'stdout') summary = content;
  };

  const appendDecoded = (stream: 'stdout' | 'stderr', decoded: string) => {
    const combined = (stream === 'stdout' ? stdoutBuffer : stderrBuffer) + decoded;
    const lines = combined.split(/\r?\n/);
    const remainder = lines.pop() ?? '';
    if (stream === 'stdout') stdoutBuffer = remainder;
    else stderrBuffer = remainder;
    for (const line of lines) appendLine(stream, line);
  };

  const flushChunk = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > MAX_OUTPUT_BYTES) {
      outputLimitExceeded = true;
      return;
    }

    const decoder = stream === 'stdout' ? stdoutDecoder : stderrDecoder;
    appendDecoded(stream, decoder.write(chunk));
  };

  const processResult = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    if (input.signal?.aborted) {
      aborted = true;
      resolve({ exitCode: null, signal: null });
      return;
    }
    const useProcessGroup = process.platform !== 'win32';
    const child = spawn(
      process.execPath,
      [
        LOCAL_CLI_SUPERVISOR_PATH,
        String(graceSec),
        String(LOCAL_CLI_SUPERVISOR_LEASE_TIMEOUT_MS),
        containmentCommand,
        ...containmentCommandArgs,
        command,
        ...args,
      ],
      {
      cwd,
      env: supervisorEnv,
      detached: useProcessGroup,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
      },
    );
    const lifetimePipe = child.stdio[3] as Writable | null;
    const adapterEnvPipe = child.stdio[4] as Writable | null;
    lifetimePipe?.on('error', () => {
      // The supervisor owns shutdown once its parent-lifetime pipe closes.
    });
    let forwardedLeaseHeartbeatAt = input.leaseHeartbeatAt();
    lifetimePipe?.write(String(forwardedLeaseHeartbeatAt));
    adapterEnvPipe?.on('error', () => {
      // Spawn errors are reported through the supervisor's stderr/exit code.
    });
    adapterEnvPipe?.end(JSON.stringify(env));
    const lifetimeHeartbeat = setInterval(() => {
      try {
        const durableLeaseHeartbeatAt = input.leaseHeartbeatAt();
        if (
          durableLeaseHeartbeatAt > forwardedLeaseHeartbeatAt &&
          lifetimePipe?.writable
        ) {
          forwardedLeaseHeartbeatAt = durableLeaseHeartbeatAt;
          lifetimePipe.write(String(durableLeaseHeartbeatAt));
        }
      } catch {
        lifetimePipe?.end();
      }
    }, SUPERVISOR_LEASE_FORWARD_INTERVAL_MS);
    lifetimeHeartbeat.unref?.();
    let settled = false;
    let terminating = false;
    let forceKillTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;

    const killTree = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      if (useProcessGroup) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall back to the immediate process when the group has already exited.
        }
      } else {
        if (signal === 'SIGTERM') return;
        const taskkill = spawn(taskkillPath!, ['/pid', String(child.pid), '/t', '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        taskkill.unref();
        return;
      }
      child.kill(signal);
    };

    const terminate = () => {
      if (terminating) return;
      if (child.exitCode !== null || child.signalCode !== null) return;
      terminating = true;
      clearInterval(lifetimeHeartbeat);
      if (process.platform === 'win32') {
        // Keep the supervisor PID alive during the drain interval so the
        // forced tree kill still has a stable Windows root to target.
        lifetimePipe?.end();
      } else {
        killTree('SIGTERM');
      }
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) killTree('SIGKILL');
      }, graceSec * 1_000 + SUPERVISOR_SHUTDOWN_BUFFER_MS);
      forceKillTimer.unref?.();
    };
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    if (input.signal?.aborted) onAbort();
    else input.signal?.addEventListener('abort', onAbort, { once: true });

    if (timeoutSec > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutSec * 1_000);
      timeoutTimer.unref?.();
    }

    child.stdout.on('data', (chunk: Buffer) => {
      flushChunk('stdout', chunk);
      if (outputLimitExceeded) {
        child.stdout.pause();
        child.stderr.pause();
        terminate();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      flushChunk('stderr', chunk);
      if (outputLimitExceeded) {
        child.stdout.pause();
        child.stderr.pause();
        terminate();
      }
    });
    child.on('error', (error) => {
      spawnError = error;
      clearInterval(lifetimeHeartbeat);
      input.signal?.removeEventListener('abort', onAbort);
      if (!settled) {
        settled = true;
        resolve({ exitCode: null, signal: null });
      }
    });
    child.stdin.on('error', () => {
      // Spawn failures and early process exits can close stdin before the prompt is written.
    });
    child.on('close', (exitCode, signal) => {
      clearInterval(lifetimeHeartbeat);
      input.signal?.removeEventListener('abort', onAbort);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (!settled) {
        settled = true;
        resolve({ exitCode, signal });
      }
    });

    child.stdin.end(`${input.prompt}\n`);
  });

  appendDecoded('stdout', stdoutDecoder.end());
  appendDecoded('stderr', stderrDecoder.end());
  if (stdoutBuffer) appendLine('stdout', stdoutBuffer);
  if (stderrBuffer) appendLine('stderr', stderrBuffer);

  const ok =
    !spawnError &&
    !aborted &&
    !timedOut &&
    !outputLimitExceeded &&
    processResult.exitCode === 0;
  const durationMs = Date.now() - startedAt;
  const diagnostic: Record<string, unknown> = {
    adapterId: input.adapterId,
    command,
    cwd,
    exitCode: processResult.exitCode,
    signal: processResult.signal,
    aborted,
    timedOut,
    timeoutSec,
    durationMs,
    outputBytes,
  };

  if (!ok) {
    diagnostic.message = failureMessage({
      command,
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      aborted,
      timedOut,
      outputLimitExceeded,
      spawnError,
      stderrTail,
    });
  }
  retainTranscriptEntry({
    timestamp: new Date().toISOString(),
    stream: 'system',
    kind: 'diagnostic',
    data: diagnostic,
  });
  const orderedTranscript =
    transcriptStart === 0
      ? transcript
      : [
          ...transcript.slice(transcriptStart),
          ...transcript.slice(0, transcriptStart),
        ];

  return {
    ok,
    exitCode: processResult.exitCode,
    signal: processResult.signal,
    aborted,
    timedOut,
    durationMs,
    summary,
    transcript: orderedTranscript,
    resumeState: {
      ...resumeState,
      ...(sessionId ? { sessionId } : {}),
      cwd,
      ...(codexHome ? { codexHome } : {}),
    },
    diagnostic,
  };
}
