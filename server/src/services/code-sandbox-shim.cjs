// ---------------------------------------------------------------------------
// Dev-local code sandbox preload shim (M6)
// ---------------------------------------------------------------------------
//
// This module is loaded via `node --require ./code-sandbox-shim.cjs` BEFORE the
// user's code artifact runs. It enforces the EIDOLON_LOCAL_CLI_CONTAINMENT
// posture's *intent* at the process level for the dev-local sandbox:
//
//   1. No host secret access — `process.env` is replaced with a frozen,
//      sanitized allowlist that contains NO API keys, tokens, or credentials.
//   2. No host filesystem access outside the sandbox root — `fs` sync/async
//      methods reject any path that resolves outside the sandbox directory
//      (the artifact's own files).
//   3. No subprocess spawning — `child_process` is disabled.
//   4. No unapproved network egress — `net.Socket.prototype.connect` is
//      patched to reject outbound connections.
//
// This is a dev-local equivalent (not OS-level containment). The production
// posture uses the operator-managed `EIDOLON_LOCAL_CLI_CONTAINMENT_COMMAND`
// launcher (cgroup/container/job-object) via the same runtime used by the
// agentic-loop local CLI adapter. Both paths assert the same boundary: a
// user/agent-authored code artifact cannot read host files, exfiltrate
// secrets, spawn subprocesses, or open unapproved network connections.
//
// The sandbox root is communicated via the `EIDOLON_CODE_SANDBOX_ROOT`
// environment variable, set by the runner when spawning the child process.
// ---------------------------------------------------------------------------

'use strict';

const path = require('path');
const fs = require('fs');

const SANDBOX_ROOT = process.env.EIDOLON_CODE_SANDBOX_ROOT
  ? path.resolve(process.env.EIDOLON_CODE_SANDBOX_ROOT)
  : process.cwd();

// ── 1. Sanitized, frozen process.env (no secrets) ────────────────────────
const SAFE_ENV_KEYS = new Set([
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
  'HOME', // set to sandbox root by the runner
  'EIDOLON_CODE_SANDBOX_ROOT',
]);

const sanitizedEnv = {};
for (const key of SAFE_ENV_KEYS) {
  if (typeof process.env[key] === 'string') {
    sanitizedEnv[key] = process.env[key];
  }
}
// Deliberately drop every other env var — no API keys, tokens, or credentials.
try {
  Object.defineProperty(process, 'env', {
    value: Object.freeze(sanitizedEnv),
    writable: false,
    configurable: false,
  });
} catch {
  // If process.env cannot be replaced (some runtimes), clear + freeze it.
  for (const key of Object.keys(process.env)) {
    if (!SAFE_ENV_KEYS.has(key)) delete process.env[key];
  }
}

// ── 2. Restrict filesystem access to the sandbox root ─────────────────────
function resolveWithinSandbox(target) {
  const resolved = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(SANDBOX_ROOT, target);
  const relative = path.relative(SANDBOX_ROOT, resolved);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error(`Sandbox blocked filesystem access outside the artifact directory: ${target}`);
  }
  return resolved;
}

const BLOCKED_FS_METHODS = new Set([
  'readFileSync',
  'writeFileSync',
  'appendFileSync',
  'copyFileSync',
  'existsSync',
  'statSync',
  'lstatSync',
  'unlinkSync',
  'mkdirSync',
  'rmdirSync',
  'readdirSync',
  'openSync',
  'readSync',
  'realpathSync',
  'accessSync',
  'chmodSync',
  'chownSync',
  'renameSync',
  'readlinkSync',
  'createReadStream',
]);

for (const name of BLOCKED_FS_METHODS) {
  const original = fs[name];
  if (typeof original !== 'function') continue;
  fs[name] = function sandboxedFs(...args) {
    if (args.length > 0 && typeof args[0] === 'string') {
      args[0] = resolveWithinSandbox(args[0]);
    }
    return original.apply(this, args);
  };
}

// Async fs.promises — wrap the promise methods that take a path.
if (fs.promises) {
  const BLOCKED_PROMISES = new Set([
    'readFile',
    'writeFile',
    'appendFile',
    'copyFile',
    'stat',
    'lstat',
    'unlink',
    'mkdir',
    'rmdir',
    'readdir',
    'open',
    'realpath',
    'access',
    'chmod',
    'chown',
    'rename',
    'readlink',
  ]);
  for (const name of BLOCKED_PROMISES) {
    const original = fs.promises[name];
    if (typeof original !== 'function') continue;
    fs.promises[name] = function sandboxedPromise(...args) {
      if (args.length > 0 && typeof args[0] === 'string') {
        args[0] = resolveWithinSandbox(args[0]);
      }
      return original.apply(this, args);
    };
  }
}

// ── 3. Disable child_process ──────────────────────────────────────────────
try {
  const cp = require('child_process');
  const blocked = () => {
    throw new Error('Sandbox blocked child_process access — spawning subprocesses is not allowed.');
  };
  for (const name of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) {
    if (typeof cp[name] === 'function') cp[name] = blocked;
  }
} catch {
  // child_process unavailable — nothing to block.
}

// ── 4. Block unapproved network egress ────────────────────────────────────
try {
  const net = require('net');
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function sandboxedConnect(...args) {
    // Allow only loopback connections; reject everything else.
    let host = '';
    const arg = args[0];
    if (typeof arg === 'object' && arg !== null) {
      host = arg.host || arg.path || '127.0.0.1';
    } else if (typeof arg === 'number' && args.length > 1 && typeof args[1] === 'object') {
      host = args[1].host || '127.0.0.1';
    } else {
      host = '127.0.0.1';
    }
    if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost' && !String(host).startsWith('/')) {
      this.destroy(new Error('Sandbox blocked network egress — outbound connections are not allowed.'));
      return this;
    }
    return originalConnect.apply(this, args);
  };
} catch {
  // net unavailable.
}

module.exports = {};
