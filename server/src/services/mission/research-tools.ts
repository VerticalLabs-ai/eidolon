import type { ResearchOperation } from './research/spi.js';

/**
 * Shared research tool-name / operation mapping.
 *
 * Extracted from `run-processor.ts` so that both `run-processor.ts` and
 * `plan-decision.ts` reference the same map instance (VAL-M1-006).
 *
 * A child run whose approved plan step includes any of these tools has
 * research operations. The RunProcessor invokes the ResearchExecutionService
 * for those operations instead of making a single LLM provider call.
 *
 * The map also serves as the canonical alias → operation resolver for
 * `revalidatePolicyToolsForApproval` in `plan-decision.ts`, which normalizes
 * tool aliases to canonical names before the exact-match policy check
 * (VAL-M1-001, VAL-M1-002, VAL-M1-005).
 *
 * (architecture.md: ResearchProvider SPI, fix-ut-m5-tool-name-mapping)
 */

/**
 * Mapping from plan step tool-allowlist entries to research operations.
 *
 * Canonical internal `research.*` tool names are listed first, followed by
 * LLM-planner-generated aliases. The planner may emit generic `web_*` or
 * provider-prefixed tool names in plan step `toolAllowlist` fields. These
 * aliases map to the same research operations so children execute research
 * instead of silently falling through to a plain LLM provider call.
 */
export const RESEARCH_TOOL_TO_OPERATION: Record<string, ResearchOperation> = {
  // Canonical internal research.* tool names (architecture.md: ResearchProvider SPI).
  'research.search': 'search',
  'research.extract': 'extract',
  'research.scrape': 'scrape',
  'research.structured_extract': 'structured_extract',
  // LLM-planner-generated aliases. The planner may emit generic web_* or
  // provider-prefixed tool names in plan step `toolAllowlist` fields. Map
  // them to the same research operations so children execute research
  // instead of silently falling through to a plain LLM provider call
  // (fix-ut-m5-tool-name-mapping).
  web_search: 'search',
  web_fetch: 'extract',
  web_browse: 'search',
  'tavily.search': 'search',
  'firecrawl.search': 'search',
  'firecrawl.scrape': 'scrape',
  'firecrawl.extract': 'extract',
  'firecrawl.structured_extract': 'structured_extract',
};

/**
 * Set of all canonical research tool names (the `research.*` keys).
 * Used to check whether a tool is a research tool for policy bypass logic.
 */
export const CANONICAL_RESEARCH_TOOLS: ReadonlySet<string> = new Set([
  'research.search',
  'research.extract',
  'research.scrape',
  'research.structured_extract',
]);

/**
 * Set of all known tool names (canonical + aliases) from the map.
 * Used to determine whether a tool name is recognized at all.
 */
export const ALL_KNOWN_RESEARCH_TOOLS: ReadonlySet<string> = new Set(
  Object.keys(RESEARCH_TOOL_TO_OPERATION),
);

/**
 * Normalize a tool name to its canonical form.
 *
 * - If the tool is a canonical name (e.g., `research.search`), it is returned
 *   unchanged (idempotent — VAL-M1-005).
 * - If the tool is a known alias (e.g., `web_search`), it is mapped to its
 *   canonical form (e.g., `research.search`) (VAL-M1-001).
 * - If the tool is not a research tool (e.g., `artifact.create`), it is
 *   returned unchanged — non-research tools are not subject to alias
 *   normalization.
 *
 * This is a pure function of the tool name and the alias map (VAL-M1-014).
 *
 * @returns The canonical tool name, or the original name if it is not a
 *   research tool alias.
 */
export function normalizeToolAlias(toolName: string): string {
  // If it's a canonical research tool, return as-is (idempotent).
  if (CANONICAL_RESEARCH_TOOLS.has(toolName)) {
    return toolName;
  }
  // If it's a known alias, map to the canonical research tool.
  // We need to find the canonical name from the operation. Since multiple
  // aliases map to the same operation, we reverse-lookup via the canonical
  // set: find the canonical tool whose operation matches the alias's operation.
  const op = RESEARCH_TOOL_TO_OPERATION[toolName];
  if (op) {
    // Find the canonical tool for this operation.
    for (const canonical of CANONICAL_RESEARCH_TOOLS) {
      if (RESEARCH_TOOL_TO_OPERATION[canonical] === op) {
        return canonical;
      }
    }
  }
  // Not a research tool at all — return unchanged.
  return toolName;
}

/**
 * Check whether a tool name is a research tool (canonical or alias).
 */
export function isResearchTool(toolName: string): boolean {
  return ALL_KNOWN_RESEARCH_TOOLS.has(toolName);
}

/**
 * Check whether a tool name is a canonical research tool.
 */
export function isCanonicalResearchTool(toolName: string): boolean {
  return CANONICAL_RESEARCH_TOOLS.has(toolName);
}

/**
 * Extract research operations from a step's tool allowlist.
 *
 * Re-exported from the original location in `run-processor.ts` so both
 * consumers use the same implementation (VAL-M1-006).
 */
export function extractResearchOperations(toolAllowlist: string[]): ResearchOperation[] {
  const ops: ResearchOperation[] = [];
  for (const tool of toolAllowlist) {
    const op = RESEARCH_TOOL_TO_OPERATION[tool];
    if (op) {
      ops.push(op);
    }
  }
  return ops;
}
