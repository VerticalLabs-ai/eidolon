/**
 * Fixed, compile-time provider origins.
 *
 * (VAL-RES-006, architecture.md: Network/SSRF policy)
 *
 * Provider origins are HTTPS-only, compile-time constants. They cannot be
 * overridden by users, companies, agents, mode profiles, environment, or
 * stored policy. Adapters connect only to these exact origins on port 443.
 *
 * Official documentation consulted at implementation time:
 * - Tavily Search: https://docs.tavily.com/documentation/api-reference/endpoint/search
 *   (accessed 2026-08-24) — origin `https://api.tavily.com`, path `/search`
 * - Tavily Extract: https://docs.tavily.com/documentation/api-reference/endpoint/extract
 *   (accessed 2026-08-24) — origin `https://api.tavily.com`, path `/extract`
 * - Firecrawl Search: https://docs.firecrawl.dev/api-reference/endpoint/search
 *   (accessed 2026-08-24) — origin `https://api.firecrawl.dev`, path `/v2/search`
 * - Firecrawl Scrape: https://docs.firecrawl.dev/api-reference/endpoint/scrape
 *   (accessed 2026-08-24) — origin `https://api.firecrawl.dev`, path `/v2/scrape`
 * - Firecrawl Extract: https://docs.firecrawl.dev/api-reference/endpoint/extract
 *   (accessed 2026-08-24) — origin `https://api.firecrawl.dev`, path `/v2/extract`
 */

/** Fixed Tavily API origin (HTTPS-only, port 443). */
export const TAVILY_ORIGIN = 'https://api.tavily.com' as const;

/** Fixed Firecrawl API origin (HTTPS-only, port 443). */
export const FIRECRAWL_ORIGIN = 'https://api.firecrawl.dev' as const;

/** Map of provider name → fixed origin. */
export const PROVIDER_ORIGINS = {
  tavily: TAVILY_ORIGIN,
  firecrawl: FIRECRAWL_ORIGIN,
} as const;

/** Type-safe provider name. */
export type ResearchProviderName = keyof typeof PROVIDER_ORIGINS;

/**
 * Versioned, allowlisted operation paths per provider.
 *
 * These paths are the only valid request targets. They are verified against
 * current official documentation (see file header for URLs and access date).
 * Adapters must not accept origin, protocol, host, port, or path overrides.
 */
export const PROVIDER_PATHS: Record<ResearchProviderName, Record<string, string>> = {
  tavily: {
    search: '/search',
    extract: '/extract',
  },
  firecrawl: {
    search: '/v2/search',
    scrape: '/v2/scrape',
    structured_extract: '/v2/extract',
  },
} as const;
