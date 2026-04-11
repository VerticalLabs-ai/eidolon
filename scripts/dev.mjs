import { spawn } from "node:child_process"
import net from "node:net"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, "..")

const DEFAULT_SERVER_PORT = 3100
const DEFAULT_UI_PORT = 3000
const MAX_UI_PORT_SCAN = 20
const CHILD_KILL_TIMEOUT_MS = 1_500
const SERVER_PORT_HOSTS = ["127.0.0.1", "0.0.0.0", "::1", "::"]
const UI_PORT_HOSTS = ["127.0.0.1", "0.0.0.0", "::1", "::"]

function parsePort(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function isHostPortAvailable(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer()

    server.once("error", () => resolve(false))
    server.once("listening", () => {
      server.close(() => resolve(true))
    })

    server.listen(port, host)
  })
}

async function isPortAvailable(port, hosts) {
  for (const host of hosts) {
    if (!(await isHostPortAvailable(port, host))) {
      return false
    }
  }

  return true
}

async function findAvailablePort(
  startPort,
  hosts,
  attempts = MAX_UI_PORT_SCAN,
) {
  for (let offset = 0; offset <= attempts; offset += 1) {
    const candidate = startPort + offset
    if (await isPortAvailable(candidate, hosts)) {
      return candidate
    }
  }

  throw new Error(
    `No available UI port found between ${startPort} and ${startPort + attempts}`,
  )
}

function buildCorsOrigins(uiPort) {
  const origins = new Set([
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:5173",
    `http://localhost:${uiPort}`,
  ])

  for (const origin of (process.env.CORS_ORIGIN ?? "").split(",")) {
    const normalized = origin.trim()
    if (normalized) origins.add(normalized)
  }

  return [...origins].join(",")
}

function killProcessGroup(child, signal = "SIGTERM") {
  if (!child?.pid) return

  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return
    }
    throw error
  }
}

function describeExit(code, signal) {
  if (signal) return `signal ${signal}`
  if (typeof code === "number") return `code ${code}`
  return "an unknown reason"
}

const serverPort = parsePort(process.env.PORT, DEFAULT_SERVER_PORT)
const requestedUiPort = parsePort(process.env.UI_PORT, DEFAULT_UI_PORT)

if (!(await isPortAvailable(serverPort, SERVER_PORT_HOSTS))) {
  console.error(
    `[dev] Server port ${serverPort} is already in use. Stop the existing process or re-run with PORT set to a free port.`,
  )
  process.exit(1)
}

const uiPort = await findAvailablePort(requestedUiPort, UI_PORT_HOSTS)
if (uiPort !== requestedUiPort) {
  console.log(
    `[dev] Port ${requestedUiPort} is in use, starting the UI on ${uiPort} instead.`,
  )
}

console.log(`[dev] UI: http://localhost:${uiPort}`)
console.log(`[dev] API: http://localhost:${serverPort}/api`)

const children = new Map()
let shuttingDown = false
let exitCode = 0

function shutdown(nextExitCode = 0, reason = "shutdown") {
  if (shuttingDown) return

  shuttingDown = true
  exitCode = nextExitCode

  console.log(`[dev] Stopping dev servers (${reason})...`)

  for (const child of children.values()) {
    killProcessGroup(child, "SIGTERM")
    setTimeout(
      () => killProcessGroup(child, "SIGKILL"),
      CHILD_KILL_TIMEOUT_MS,
    ).unref()
  }
}

function spawnManaged(name, args, options) {
  const child = spawn("pnpm", args, {
    cwd: options.cwd,
    env: options.env,
    stdio: "inherit",
    detached: true,
  })

  children.set(name, child)

  child.once("error", (error) => {
    console.error(`[dev] Failed to start ${name}: ${error.message}`)
    shutdown(1, `${name} failed to start`)
  })

  child.once("exit", (code, signal) => {
    children.delete(name)

    if (!shuttingDown) {
      const normalizedExitCode =
        typeof code === "number" ? code : signal ? 1 : 0
      console.error(`[dev] ${name} exited with ${describeExit(code, signal)}.`)
      shutdown(normalizedExitCode, `${name} exited`)
    }

    if (children.size === 0) {
      process.exit(exitCode)
    }
  })

  return child
}

process.on("SIGINT", () => shutdown(0, "SIGINT"))
process.on("SIGTERM", () => shutdown(0, "SIGTERM"))

spawnManaged(
  "server",
  ["--dir", "server", "exec", "tsx", "watch", "src/index.ts"],
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(serverPort),
      CORS_ORIGIN: buildCorsOrigins(uiPort),
    },
  },
)

spawnManaged(
  "ui",
  ["--dir", "ui", "exec", "vite", "--port", String(uiPort), "--strictPort"],
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      UI_PORT: String(uiPort),
    },
  },
)
