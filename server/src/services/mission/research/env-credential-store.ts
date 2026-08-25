/**
 * Production environment-backed credential store for research providers.
 *
 * (architecture.md: Secrets, VAL-RES-091)
 *
 * Resolves Tavily/Firecrawl API keys from deployment environment variables.
 * Company-scoped encrypted `secrets` table credentials are not yet wired in
 * Phase 1; this store serves as the production credential source, falling
 * back to environment defaults. Secrets never appear in events, logs,
 * traces, or artifacts.
 *
 * This is the production counterpart to the test-only `MockCredentialStore`.
 * The `ResearchExecutionService` accepts any `CredentialStore` implementation;
 * the worker constructs this one for production.
 */

import type { CredentialStore } from './credential-resolver.js';

/**
 * Environment-backed credential store.
 *
 * Reads provider API keys from `process.env`:
 * - Tavily: `TAVILY_API_KEY`
 * - Firecrawl: `FIRECRAWL_API_KEY`
 *
 * Returns `undefined` when no environment credential is configured for the
 * requested provider, causing the credential resolver to fail closed.
 */
export class EnvCredentialStore implements CredentialStore {
  async getSecret(_companyId: string, providerName: string): Promise<string | undefined> {
    if (providerName === 'tavily') {
      return process.env.TAVILY_API_KEY;
    }
    if (providerName === 'firecrawl') {
      return process.env.FIRECRAWL_API_KEY;
    }
    return undefined;
  }
}
