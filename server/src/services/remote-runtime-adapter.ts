import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type {
  LocalCliRunResult,
  LocalCliTranscriptEntry,
} from './local-cli-adapter.js';

const DEFAULT_TIMEOUT_SEC = 30;
const MAX_TIMEOUT_SEC = 300;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const FORBIDDEN_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'proxy-authorization',
  'transfer-encoding',
]);

export const REMOTE_RUNTIME_ADAPTER_IDS = [
  'http:remote',
  'openclaw:webhook',
] as const;
export type RemoteRuntimeAdapterId =
  (typeof REMOTE_RUNTIME_ADAPTER_IDS)[number];

interface RemoteRuntimeAdapterInput {
  adapterId: string;
  prompt: string;
  adapterConfig: Record<string, unknown>;
  companyId: string;
  agentId: string;
  sessionId: string;
  resumeState?: Record<string, unknown>;
  signal?: AbortSignal;
}

interface PinnedRemoteTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

interface RemoteResponse {
  status: number;
  statusText: string;
  body: string;
}

export function isRemoteRuntimeAdapterId(
  value: string,
): value is RemoteRuntimeAdapterId {
  return REMOTE_RUNTIME_ADAPTER_IDS.includes(value as RemoteRuntimeAdapterId);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asPositiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(value, MAX_TIMEOUT_SEC)
    : fallback;
}

function stripIpBrackets(value: string): string {
  return value.startsWith('[') && value.endsWith(']')
    ? value.slice(1, -1)
    : value;
}

function canonicalizeIpAddress(value: string): string | null {
  const address = stripIpBrackets(value.trim().toLowerCase());
  const family = net.isIP(address);
  if (family === 4) {
    return address;
  }
  if (family === 6) {
    return stripIpBrackets(new URL(`http://[${address}]`).hostname.toLowerCase());
  }
  return null;
}

function parseHostAllowlist(): Map<string, Set<string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      process.env.EIDOLON_RUNTIME_HTTP_ORIGIN_ALLOWLIST_JSON ?? '{}',
    );
  } catch {
    throw new Error(
      'EIDOLON_RUNTIME_HTTP_ORIGIN_ALLOWLIST_JSON must be a JSON object mapping HTTP origins to approved IP addresses.',
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      'EIDOLON_RUNTIME_HTTP_ORIGIN_ALLOWLIST_JSON must be a JSON object mapping HTTP origins to approved IP addresses.',
    );
  }
  const allowlist = new Map<string, Set<string>>();
  for (const [configuredOrigin, configuredAddresses] of Object.entries(parsed)) {
    let origin: string;
    try {
      const originUrl = new URL(configuredOrigin);
      if (
        !['http:', 'https:'].includes(originUrl.protocol) ||
        originUrl.username ||
        originUrl.password ||
        originUrl.pathname !== '/' ||
        originUrl.search ||
        originUrl.hash
      ) {
        throw new Error('invalid origin');
      }
      origin = originUrl.origin.toLowerCase();
    } catch {
      throw new Error(
        `Runtime HTTP allowlist key "${configuredOrigin}" must be an HTTP origin such as https://openclaw.internal:443.`,
      );
    }
    if (
      !Array.isArray(configuredAddresses) ||
      configuredAddresses.length === 0
    ) {
      throw new Error(
        `Runtime HTTP origin "${configuredOrigin}" must map to at least one approved IP address.`,
      );
    }
    const addresses = configuredAddresses.map((address) =>
      typeof address === 'string'
        ? canonicalizeIpAddress(address)
        : null,
    );
    if (addresses.some((address) => address === null)) {
      throw new Error(
        `Runtime HTTP origin "${configuredOrigin}" contains an invalid approved IP address.`,
      );
    }
    allowlist.set(origin, new Set(addresses as string[]));
  }
  return allowlist;
}

async function resolveRemoteTarget(
  config: Record<string, unknown>,
  signal: AbortSignal,
): Promise<PinnedRemoteTarget> {
  if (typeof config.url !== 'string' || !config.url.trim()) {
    throw new Error('Remote adapterConfig.url is required.');
  }
  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    throw new Error('Remote adapterConfig.url must be a valid URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Remote adapterConfig.url must use http or https.');
  }
  if (url.username || url.password) {
    throw new Error('Remote adapterConfig.url must not include credentials.');
  }

  const hostname = stripIpBrackets(url.hostname.toLowerCase());
  const literalAddress = canonicalizeIpAddress(hostname);
  const allowlist = parseHostAllowlist();
  const approvedAddresses = allowlist.get(url.origin.toLowerCase());
  if (!approvedAddresses) {
    throw new Error(
      `Runtime HTTP origin "${url.origin}" must be configured in EIDOLON_RUNTIME_HTTP_ORIGIN_ALLOWLIST_JSON to prevent SSRF and DNS rebinding.`,
    );
  }
  const literalFamily = net.isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (!literalAddress || !approvedAddresses.has(literalAddress)) {
      throw new Error(
        `Literal runtime HTTP origin "${url.origin}" must map to its own address in EIDOLON_RUNTIME_HTTP_ORIGIN_ALLOWLIST_JSON.`,
      );
    }
    return { url, address: literalAddress, family: literalFamily };
  }

  const addresses = await new Promise<Array<{ address: string; family: number }>>(
    (resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      void dns.lookup(hostname, { all: true, verbatim: true }).then(
        (result) => {
          signal.removeEventListener('abort', onAbort);
          resolve(result);
        },
        (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    },
  );
  const pinned = addresses
    .map((entry) => ({
      ...entry,
      address: canonicalizeIpAddress(entry.address),
    }))
    .find((entry) =>
      entry.address !== null && approvedAddresses.has(entry.address),
    );
  if (!pinned || (pinned.family !== 4 && pinned.family !== 6)) {
    const resolved = addresses.map((entry) => entry.address).join(', ') || 'none';
    throw new Error(
      `Runtime HTTP origin "${url.origin}" resolved to ${resolved}; add one trusted resolved address under that origin in EIDOLON_RUNTIME_HTTP_ORIGIN_ALLOWLIST_JSON so Eidolon can pin the connection.`,
    );
  }
  return { url, address: pinned.address as string, family: pinned.family };
}

function redactRemoteUrl(url: URL): string {
  const redacted = new URL(url);
  redacted.search = '';
  redacted.hash = '';
  return redacted.toString();
}

function resolveHeaders(config: Record<string, unknown>): Record<string, string> {
  const configured = asRecord(config.headers);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  for (const [key, value] of Object.entries(configured)) {
    const normalized = key.trim().toLowerCase();
    if (!normalized || FORBIDDEN_HEADERS.has(normalized)) {
      throw new Error(`Remote adapter header "${key}" is not allowed.`);
    }
    if (typeof value !== 'string') {
      throw new Error(`Remote adapter header "${key}" must be a string.`);
    }
    headers[normalized] = value;
  }
  return headers;
}

function resolveResponseFields(config: Record<string, unknown>): string[] {
  if (config.responseFields === undefined) {
    return [];
  }
  if (
    !Array.isArray(config.responseFields) ||
    config.responseFields.length > 20 ||
    config.responseFields.some(
      (field) =>
        typeof field !== 'string' ||
        !/^[a-zA-Z0-9_.-]{1,64}$/.test(field),
    )
  ) {
    throw new Error(
      'Remote adapterConfig.responseFields must be an array of up to 20 simple field names.',
    );
  }
  return [...new Set(config.responseFields)];
}

function selectResponseData(
  value: unknown,
  fields: string[],
): Record<string, string | number | boolean | null> | null {
  const source = asRecord(value);
  const selected: Record<string, string | number | boolean | null> = {};
  for (const field of fields) {
    const fieldValue = source[field];
    if (
      fieldValue === null ||
      typeof fieldValue === 'string' ||
      typeof fieldValue === 'number' ||
      typeof fieldValue === 'boolean'
    ) {
      selected[field] = fieldValue;
    }
  }
  return Object.keys(selected).length > 0 ? selected : null;
}

async function requestPinnedRemote(input: {
  target: PinnedRemoteTarget;
  method: 'HEAD' | 'POST';
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}): Promise<RemoteResponse> {
  const transport = input.target.url.protocol === 'https:' ? https : http;
  const headers = { ...input.headers };
  if (input.body !== undefined) {
    headers['content-length'] = String(Buffer.byteLength(input.body));
  }
  return new Promise((resolve, reject) => {
    const request = transport.request(
      input.target.url,
      {
        method: input.method,
        headers,
        signal: input.signal,
        agent: false,
        lookup: (_hostname, options, callback) => {
          if (options.all) {
            callback(null, [{
              address: input.target.address,
              family: input.target.family,
            }]);
            return;
          }
          callback(null, input.target.address, input.target.family);
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            request.destroy(
              new Error(
                `Remote adapter response exceeded ${MAX_RESPONSE_BYTES} bytes.`,
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            statusText: response.statusMessage ?? '',
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    request.end(input.body);
  });
}

function validateOpenClawConfig(config: Record<string, unknown>): void {
  if (
    config.agentId !== undefined &&
    (typeof config.agentId !== 'string' || !config.agentId.trim())
  ) {
    throw new Error(
      'openclaw:webhook adapterConfig.agentId must be a non-empty string.',
    );
  }
  if (
    config.deliver !== undefined &&
    typeof config.deliver !== 'boolean'
  ) {
    throw new Error(
      'openclaw:webhook adapterConfig.deliver must be a boolean.',
    );
  }
}

function buildPayload(
  input: RemoteRuntimeAdapterInput,
  adapterId: RemoteRuntimeAdapterId,
): Record<string, unknown> {
  const config = asRecord(input.adapterConfig);
  if (adapterId === 'openclaw:webhook') {
    validateOpenClawConfig(config);
    return {
      message: input.prompt,
      agentId:
        typeof config.agentId === 'string' && config.agentId.trim()
          ? config.agentId.trim()
          : 'main',
      deliver: config.deliver !== false,
    };
  }
  return {
    ...asRecord(config.payload),
    prompt: input.prompt,
    companyId: input.companyId,
    agentId: input.agentId,
    sessionId: input.sessionId,
  };
}

function serializeRequestBody(
  input: RemoteRuntimeAdapterInput,
  adapterId: RemoteRuntimeAdapterId,
): string {
  const body = JSON.stringify(buildPayload(input, adapterId));
  const requestBytes = Buffer.byteLength(body);
  if (requestBytes > MAX_REQUEST_BYTES) {
    throw new Error(
      `Remote adapter request is ${requestBytes} bytes; the limit is ${MAX_REQUEST_BYTES} bytes.`,
    );
  }
  return body;
}

export async function testRemoteRuntimeAdapter(input: {
  adapterId: string;
  adapterConfig: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  if (!isRemoteRuntimeAdapterId(input.adapterId)) {
    throw new Error(`Unsupported remote runtime adapter "${input.adapterId}".`);
  }
  const config = asRecord(input.adapterConfig);
  const timeoutSec = asPositiveNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC);
  const timeoutSignal = AbortSignal.timeout(
    Math.max(1, Math.round(timeoutSec * 1_000)),
  );
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeoutSignal])
    : timeoutSignal;
  const target = await resolveRemoteTarget(config, signal);
  const headers = resolveHeaders(config);
  resolveResponseFields(config);
  if (input.adapterId === 'openclaw:webhook') {
    validateOpenClawConfig(config);
  }
  serializeRequestBody(
    {
      adapterId: input.adapterId,
      prompt: '',
      adapterConfig: config,
      companyId: '',
      agentId: '',
      sessionId: '',
    },
    input.adapterId,
  );
  const response = await requestPinnedRemote({
    target,
    method: 'HEAD',
    headers,
    signal,
  });
  if (response.status === 405) {
    return {
      ok: false,
      reachable: true,
      inconclusive: true,
      adapterId: input.adapterId,
      url: redactRemoteUrl(target.url),
      status: response.status,
      message:
        'Remote endpoint is reachable but rejects HEAD; no side-effect-free live diagnostic is available for this POST-only endpoint.',
    };
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Remote adapter diagnostic received HTTP ${response.status} ${response.statusText}.`,
    );
  }
  return {
    ok: true,
    adapterId: input.adapterId,
    url: redactRemoteUrl(target.url),
    pinnedAddress: target.address,
    status: response.status,
    message: 'Remote endpoint is reachable.',
  };
}

export async function runRemoteRuntimeAdapter(
  input: RemoteRuntimeAdapterInput,
): Promise<LocalCliRunResult> {
  if (!isRemoteRuntimeAdapterId(input.adapterId)) {
    throw new Error(`Unsupported remote runtime adapter "${input.adapterId}".`);
  }
  const startedAt = Date.now();
  const config = asRecord(input.adapterConfig);
  const timeoutSec = asPositiveNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC);
  const timeoutSignal = AbortSignal.timeout(
    Math.max(1, Math.round(timeoutSec * 1_000)),
  );
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeoutSignal])
    : timeoutSignal;
  const target = await resolveRemoteTarget(config, signal);
  const headers = resolveHeaders(config);
  const responseFields = resolveResponseFields(config);
  let response: RemoteResponse;
  let responseText = '';
  let responseData: Record<string, unknown> | null = null;

  try {
    const body = serializeRequestBody(input, input.adapterId);
    response = await requestPinnedRemote({
      target,
      method: 'POST',
      headers,
      body,
      signal,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error(
        `Remote adapter redirect from "${redactRemoteUrl(target.url)}" is blocked by server policy.`,
      );
    }
    responseText = response.body;
    if (responseFields.length > 0) {
      try {
        responseData = selectResponseData(
          JSON.parse(responseText),
          responseFields,
        );
      } catch {
        responseData = null;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const diagnostic = {
      adapterId: input.adapterId,
      url: redactRemoteUrl(target.url),
      pinnedAddress: target.address,
      durationMs: Date.now() - startedAt,
      message,
    };
    return {
      ok: false,
      exitCode: null,
      signal: null,
      aborted: input.signal?.aborted ?? false,
      timedOut: timeoutSignal.aborted,
      durationMs: diagnostic.durationMs,
      summary: null,
      transcript: [{
        timestamp: new Date().toISOString(),
        stream: 'system',
        kind: 'diagnostic',
        data: diagnostic,
      }],
      resumeState: input.resumeState ?? {},
      diagnostic,
    };
  }

  const ok = response.status >= 200 && response.status < 300;
  const durationMs = Date.now() - startedAt;
  const summaryCandidate =
    responseData?.summary ??
    responseData?.result ??
    responseData?.message;
  const summary =
    typeof summaryCandidate === 'string' && summaryCandidate.trim()
      ? summaryCandidate.trim().slice(0, 100_000)
      : ok
        ? `Remote adapter completed with HTTP ${response.status}.`
        : null;
  const transcript: LocalCliTranscriptEntry[] = [];
  if (responseData) {
    transcript.push({
      timestamp: new Date().toISOString(),
      stream: 'stdout',
      kind: 'json',
      data: responseData,
    });
  }
  const diagnostic: Record<string, unknown> = {
    adapterId: input.adapterId,
    url: redactRemoteUrl(target.url),
    pinnedAddress: target.address,
    status: response.status,
    statusText: response.statusText,
    durationMs,
  };
  if (!ok) {
    diagnostic.message =
      `Remote adapter returned HTTP ${response.status} ${response.statusText}.`;
  }
  transcript.push({
    timestamp: new Date().toISOString(),
    stream: 'system',
    kind: 'diagnostic',
    data: diagnostic,
  });
  return {
    ok,
    exitCode: null,
    signal: null,
    aborted: false,
    timedOut: false,
    durationMs,
    summary,
    transcript,
    resumeState: input.resumeState ?? {},
    diagnostic,
  };
}
