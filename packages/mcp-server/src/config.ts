export interface EidolonMcpConfig {
  /** Base URL of the Eidolon API (e.g. http://localhost:3100). */
  apiUrl: string;
  /** Bearer API key for the session/org. Optional when hitting a local_trusted server. */
  apiKey?: string;
  /** Company / organization id. Every company-scoped tool uses this. */
  companyId?: string;
  /** Optional agent context — forwarded as X-Eidolon-Agent-Id on mutations. */
  agentId?: string;
  /** Optional run id — forwarded as X-Eidolon-Run-Id for audit traceability. */
  runId?: string;
}

export function loadConfig(): EidolonMcpConfig {
  const apiUrl = (process.env.EIDOLON_API_URL ?? "http://localhost:3100").replace(
    /\/+$/,
    "",
  );
  return {
    apiUrl,
    apiKey: process.env.EIDOLON_API_KEY,
    companyId: process.env.EIDOLON_COMPANY_ID,
    agentId: process.env.EIDOLON_AGENT_ID,
    runId: process.env.EIDOLON_RUN_ID,
  };
}

export function requireCompanyId(config: EidolonMcpConfig, override?: string): string {
  const id = override ?? config.companyId;
  if (!id) {
    throw new Error(
      "companyId is required. Pass it as a tool argument or set EIDOLON_COMPANY_ID in the server env.",
    );
  }
  return id;
}
