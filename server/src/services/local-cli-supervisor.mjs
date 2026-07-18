import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const [graceSecondsRaw, leaseTimeoutMillisecondsRaw, command, ...args] =
  process.argv.slice(2);
const graceSeconds = Number(graceSecondsRaw);
const leaseTimeoutMilliseconds = Number(leaseTimeoutMillisecondsRaw);
if (
  !command ||
  !Number.isFinite(graceSeconds) ||
  graceSeconds < 0 ||
  graceSeconds > 300 ||
  !Number.isFinite(leaseTimeoutMilliseconds) ||
  leaseTimeoutMilliseconds < 1_000 ||
  leaseTimeoutMilliseconds > 60_000
) {
  process.stderr.write(
    'Local CLI supervisor requires a grace period, lease timeout, and command.\n',
  );
  process.exit(64);
}
const graceMilliseconds = graceSeconds * 1_000;
const taskkillPath =
  process.platform === 'win32' && process.env.SystemRoot
    ? path.win32.join(process.env.SystemRoot, 'System32', 'taskkill.exe')
    : null;
if (process.platform === 'win32' && !taskkillPath) {
  process.stderr.write('Local CLI supervisor requires a trusted Windows system root.\n');
  process.exit(64);
}
let cliEnvironment;
try {
  const parsedEnvironment = JSON.parse(fs.readFileSync(4, 'utf8'));
  if (
    !parsedEnvironment ||
    typeof parsedEnvironment !== 'object' ||
    Array.isArray(parsedEnvironment) ||
    Object.values(parsedEnvironment).some((value) => typeof value !== 'string')
  ) {
    throw new Error('invalid environment payload');
  }
  cliEnvironment = parsedEnvironment;
} catch {
  process.stderr.write('Local CLI supervisor received an invalid environment payload.\n');
  process.exit(64);
}

const windowsShellCommand =
  process.platform === 'win32' && /\.(?:bat|cmd)$/i.test(command);
const cli = spawn(command, args, {
  cwd: process.cwd(),
  env: cliEnvironment,
  detached: process.platform !== 'win32',
  shell: windowsShellCommand,
  windowsHide: true,
  stdio: ['inherit', 'inherit', 'inherit'],
});
const parentLifetime = new net.Socket({
  fd: 3,
  readable: true,
  writable: false,
});
let completed = false;
let terminating = false;
let forceKillTimer;
let cleanupPoll;
let leaseWatchdog;

function finish(exitCode) {
  completed = true;
  if (leaseWatchdog) clearTimeout(leaseWatchdog);
  if (forceKillTimer) clearTimeout(forceKillTimer);
  if (cleanupPoll) clearInterval(cleanupPoll);
  parentLifetime.destroy();
  cli.unref();
  process.exit(exitCode);
}

function armLeaseWatchdog() {
  if (terminating || completed) return;
  if (leaseWatchdog) clearTimeout(leaseWatchdog);
  leaseWatchdog = setTimeout(() => {
    process.stderr.write(
      'Local CLI supervisor lease heartbeat expired; terminating the CLI tree.\n',
    );
    terminate();
  }, leaseTimeoutMilliseconds);
}

parentLifetime.on('data', armLeaseWatchdog);
parentLifetime.resume();
armLeaseWatchdog();

function killCliTree(signal) {
  if (cli.pid === undefined) return;
  if (process.platform === 'win32') {
    // Windows does not provide a catchable SIGTERM for arbitrary console
    // trees. Keep the launcher alive for the configured drain interval, then
    // force the entire still-addressable tree below.
    if (signal === 'SIGTERM') return;
    const taskkill = spawn(taskkillPath, ['/pid', String(cli.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    taskkill.unref();
    return;
  }

  try {
    process.kill(-cli.pid, signal);
  } catch {
    cli.kill(signal);
  }
}

function cliTreeExists() {
  if (cli.pid === undefined || process.platform === 'win32') return false;
  try {
    process.kill(-cli.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function terminate() {
  if (completed || terminating) return;
  terminating = true;
  if (leaseWatchdog) clearTimeout(leaseWatchdog);
  killCliTree('SIGTERM');
  forceKillTimer = setTimeout(() => {
    process.stderr.write(
      'Local CLI supervisor grace period expired; force-killing the CLI tree.\n',
    );
    killCliTree('SIGKILL');
    if (process.platform === 'win32') {
      setTimeout(() => finish(137), 250);
    } else {
      finish(137);
    }
  }, graceMilliseconds);
}

parentLifetime.on('end', terminate);
parentLifetime.on('close', terminate);
parentLifetime.on('error', terminate);
process.on('SIGTERM', terminate);
process.on('SIGINT', terminate);

cli.on('error', (error) => {
  process.stderr.write(`${error.message}\n`);
  if (terminating) return;
  finish(1);
});
cli.on('exit', (code, signal) => {
  completed = true;
  if (leaseWatchdog) clearTimeout(leaseWatchdog);
  parentLifetime.destroy();
  const exitCode =
    typeof code === 'number'
      ? code
      : signal
        ? 128
        : 1;
  if (terminating && process.platform !== 'win32') {
    if (!cliTreeExists()) {
      finish(exitCode);
      return;
    }
    cleanupPoll = setInterval(() => {
      if (!cliTreeExists()) {
        finish(exitCode);
      }
    }, 25);
    return;
  }
  if (terminating) return;
  if (process.platform === 'win32') {
    killCliTree('SIGKILL');
    setTimeout(() => finish(exitCode), 250);
    return;
  }
  if (cliTreeExists()) {
    // The primary CLI has exited, so any remaining group members are orphan
    // descendants and must not outlive the supervised run.
    killCliTree('SIGKILL');
  }
  finish(exitCode);
});
