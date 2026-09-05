import { describe, expect, it } from 'vitest';
import {
  RESEARCH_TOOL_TO_OPERATION,
  normalizeToolAlias,
  isResearchTool,
  isCanonicalResearchTool,
  extractResearchOperations,
  CANONICAL_RESEARCH_TOOLS,
  ALL_KNOWN_RESEARCH_TOOLS,
} from '../services/mission/research-tools.js';
import {
  parsePlanContent,
  validatePlan,
  planContentHash,
  canonicalPlanContent,
  type PlanContent,
} from '../services/mission/plan-schema.js';
import { checkPlanDepthWarning } from '../services/mission/plan-publication.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A minimal valid single-step plan for testing. */
function singleStepPlan(): PlanContent {
  return validatePlan({
    schemaVersion: 1,
    objective: 'Research a topic.',
    steps: [
      {
        stepKey: 'research',
        parentStepKey: null,
        childOrdinal: 0,
        nodeKind: 'root',
        title: 'Research',
        description: 'Do research.',
        dependencies: [],
        inputBindings: [],
        routing: {
          kind: 'requirements',
          routingRequirements: {
            capabilities: ['research'],
            requiredTools: ['research.search'],
            requiredDomains: [],
            ephemeralAllowed: true,
          },
        },
        toolAllowlist: ['research.search'],
        replayClass: 'read_only',
        sideEffecting: false,
        expectedOutputs: ['sources'],
        evidenceRequirements: { citationsRequired: true },
        completionCriteria: 'Sources retrieved.',
        budgetCents: 200,
        limits: {},
      },
    ],
    synthesis: {
      instructions: 'Synthesize.',
      declaredInputs: [{ kind: 'stepOutput', stepKey: 'research', output: 'sources' }],
      declaredOutput: 'report',
      evidenceRequirements: { citationsRequired: true },
      completionCriteria: 'Done.',
      budgetCents: 100,
    },
    planningBudgetCents: 50,
    partialResultPolicy: 'require_all',
    limits: {
      steps: 12,
      durationSeconds: 2700,
      providerCalls: 48,
      totalTokens: 300_000,
      outputBytes: 8 * 1024 * 1024,
      costCents: 1000,
      depth: 2,
      fanOut: 4,
      descendants: 12,
    },
  });
}

/** A minimal valid two-step plan for testing. */
function twoStepPlan(): PlanContent {
  const plan = singleStepPlan();
  return validatePlan({
    ...plan,
    steps: [
      plan.steps[0],
      {
        stepKey: 'draft',
        parentStepKey: null,
        childOrdinal: 1,
        nodeKind: 'root',
        title: 'Draft',
        description: 'Write the report.',
        dependencies: ['research'],
        inputBindings: [
          {
            name: 'sources',
            source: { kind: 'stepOutput', stepKey: 'research', output: 'sources' },
          },
        ],
        routing: {
          kind: 'requirements',
          routingRequirements: {
            capabilities: ['writing'],
            requiredTools: ['artifact.create'],
            requiredDomains: [],
            ephemeralAllowed: false,
          },
        },
        toolAllowlist: ['artifact.create'],
        replayClass: 'idempotent_write',
        sideEffecting: true,
        expectedOutputs: ['brief'],
        evidenceRequirements: { citationsRequired: true },
        completionCriteria: 'Brief written.',
        budgetCents: 300,
        limits: {},
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// VAL-M1-001: Tool alias normalized to canonical name before exact-match
// ---------------------------------------------------------------------------

describe('VAL-M1-001: Tool alias normalized to canonical name', () => {
  it('normalizes web_search to research.search', () => {
    expect(normalizeToolAlias('web_search')).toBe('research.search');
  });

  it('normalizes web_fetch to research.extract', () => {
    expect(normalizeToolAlias('web_fetch')).toBe('research.extract');
  });

  it('normalizes tavily.search to research.search', () => {
    expect(normalizeToolAlias('tavily.search')).toBe('research.search');
  });

  it('normalizes firecrawl.scrape to research.scrape', () => {
    expect(normalizeToolAlias('firecrawl.scrape')).toBe('research.scrape');
  });

  it('normalizes firecrawl.structured_extract to research.structured_extract', () => {
    expect(normalizeToolAlias('firecrawl.structured_extract')).toBe('research.structured_extract');
  });

  it('normalizes web_browse to research.search', () => {
    expect(normalizeToolAlias('web_browse')).toBe('research.search');
  });
});

// ---------------------------------------------------------------------------
// VAL-M1-002: Unknown alias rejected with clear error
// ---------------------------------------------------------------------------

describe('VAL-M1-002: Unknown alias is not normalized', () => {
  it('returns unknown tool name unchanged (not a research tool)', () => {
    expect(normalizeToolAlias('unknown_tool')).toBe('unknown_tool');
  });

  it('returns non-research tool name unchanged', () => {
    expect(normalizeToolAlias('artifact.create')).toBe('artifact.create');
  });

  it('returns code.run unchanged', () => {
    expect(normalizeToolAlias('code.run')).toBe('code.run');
  });

  it('isResearchTool returns false for unknown tools', () => {
    expect(isResearchTool('unknown_tool')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VAL-M1-005: Canonical tool names pass without normalization (idempotent)
// ---------------------------------------------------------------------------

describe('VAL-M1-005: Canonical tool names are idempotent', () => {
  it('research.search normalizes to itself', () => {
    expect(normalizeToolAlias('research.search')).toBe('research.search');
  });

  it('research.extract normalizes to itself', () => {
    expect(normalizeToolAlias('research.extract')).toBe('research.extract');
  });

  it('research.scrape normalizes to itself', () => {
    expect(normalizeToolAlias('research.scrape')).toBe('research.scrape');
  });

  it('research.structured_extract normalizes to itself', () => {
    expect(normalizeToolAlias('research.structured_extract')).toBe('research.structured_extract');
  });

  it('isCanonicalResearchTool returns true for canonical tools', () => {
    expect(isCanonicalResearchTool('research.search')).toBe(true);
    expect(isCanonicalResearchTool('research.extract')).toBe(true);
    expect(isCanonicalResearchTool('research.scrape')).toBe(true);
    expect(isCanonicalResearchTool('research.structured_extract')).toBe(true);
  });

  it('isCanonicalResearchTool returns false for aliases', () => {
    expect(isCanonicalResearchTool('web_search')).toBe(false);
    expect(isCanonicalResearchTool('tavily.search')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VAL-M1-006: Shared module extraction does not break existing consumers
// ---------------------------------------------------------------------------

describe('VAL-M1-006: Shared module extraction', () => {
  it('RESEARCH_TOOL_TO_OPERATION has all expected entries', () => {
    expect(RESEARCH_TOOL_TO_OPERATION['research.search']).toBe('search');
    expect(RESEARCH_TOOL_TO_OPERATION['research.extract']).toBe('extract');
    expect(RESEARCH_TOOL_TO_OPERATION['research.scrape']).toBe('scrape');
    expect(RESEARCH_TOOL_TO_OPERATION['research.structured_extract']).toBe('structured_extract');
    expect(RESEARCH_TOOL_TO_OPERATION['web_search']).toBe('search');
    expect(RESEARCH_TOOL_TO_OPERATION['web_fetch']).toBe('extract');
    expect(RESEARCH_TOOL_TO_OPERATION['web_browse']).toBe('search');
    expect(RESEARCH_TOOL_TO_OPERATION['tavily.search']).toBe('search');
    expect(RESEARCH_TOOL_TO_OPERATION['firecrawl.search']).toBe('search');
    expect(RESEARCH_TOOL_TO_OPERATION['firecrawl.scrape']).toBe('scrape');
    expect(RESEARCH_TOOL_TO_OPERATION['firecrawl.extract']).toBe('extract');
    expect(RESEARCH_TOOL_TO_OPERATION['firecrawl.structured_extract']).toBe('structured_extract');
  });

  it('extractResearchOperations resolves canonical tools', () => {
    const ops = extractResearchOperations(['research.search', 'research.extract']);
    expect(ops).toEqual(['search', 'extract']);
  });

  it('extractResearchOperations resolves aliases', () => {
    const ops = extractResearchOperations(['web_search', 'tavily.search']);
    expect(ops).toEqual(['search', 'search']);
  });

  it('extractResearchOperations ignores non-research tools', () => {
    const ops = extractResearchOperations(['artifact.create', 'code.run']);
    expect(ops).toEqual([]);
  });

  it('extractResearchOperations handles mixed tools', () => {
    const ops = extractResearchOperations([
      'research.search',
      'artifact.create',
      'web_fetch',
      'code.run',
    ]);
    expect(ops).toEqual(['search', 'extract']);
  });

  it('CANONICAL_RESEARCH_TOOLS contains only canonical names', () => {
    expect(CANONICAL_RESEARCH_TOOLS.size).toBe(4);
    expect(CANONICAL_RESEARCH_TOOLS.has('research.search')).toBe(true);
    expect(CANONICAL_RESEARCH_TOOLS.has('web_search')).toBe(false);
  });

  it('ALL_KNOWN_RESEARCH_TOOLS contains canonical + aliases', () => {
    expect(ALL_KNOWN_RESEARCH_TOOLS.size).toBe(12);
    expect(ALL_KNOWN_RESEARCH_TOOLS.has('research.search')).toBe(true);
    expect(ALL_KNOWN_RESEARCH_TOOLS.has('web_search')).toBe(true);
    expect(ALL_KNOWN_RESEARCH_TOOLS.has('tavily.search')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// VAL-M1-007: Planner system prompt lists canonical tool names
// ---------------------------------------------------------------------------

describe('VAL-M1-007: Planner system prompt lists canonical tool names', () => {
  // Import the prompt from the module to verify its content
  // We need to access the PLANNER_SYSTEM_PROMPT which is not exported,
  // so we verify via the module's behavior by checking the prompt is
  // used in buildPlannerMessages. Instead, we verify the canonical tool
  // names are listed in the shared research tools module.
  it('canonical tool names are defined in the shared module', () => {
    expect(CANONICAL_RESEARCH_TOOLS.has('research.search')).toBe(true);
    expect(CANONICAL_RESEARCH_TOOLS.has('research.extract')).toBe(true);
    expect(CANONICAL_RESEARCH_TOOLS.has('research.scrape')).toBe(true);
    expect(CANONICAL_RESEARCH_TOOLS.has('research.structured_extract')).toBe(true);
  });

  it('the prompt forbids aliases by listing them as forbidden', async () => {
    // Read the source file to verify the prompt content
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'server/src/services/mission/planner-harness.ts'),
      'utf-8',
    );
    // The prompt must contain canonical tool names
    expect(source).toContain('research.search');
    expect(source).toContain('research.extract');
    expect(source).toContain('research.scrape');
    expect(source).toContain('research.structured_extract');
    // The prompt must forbid aliases
    expect(source).toContain('FORBIDDEN');
    expect(source).toContain('web_search');
    expect(source).toContain('tavily.search');
  });
});

// ---------------------------------------------------------------------------
// VAL-M1-008: Planner system prompt includes depth guidance
// ---------------------------------------------------------------------------

describe('VAL-M1-008: Planner system prompt includes depth guidance', () => {
  it('prompt includes depth guidance for Deep Work and Analyst modes', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'server/src/services/mission/planner-harness.ts'),
      'utf-8',
    );
    expect(source).toContain('Deep Work mode');
    expect(source).toContain('Analyst mode');
    expect(source).toContain('Depth guidance');
    // Guidance should be conditional, not mandatory for trivial requests
    expect(source).toContain('trivial requests');
  });
});

// ---------------------------------------------------------------------------
// VAL-M1-009: Single-step plan in Deep Work/Analyst emits soft warning
// ---------------------------------------------------------------------------

describe('VAL-M1-009: Single-step plan in Deep Work/Analyst emits soft warning', () => {
  it('emits warning for single-step plan in deep_work mode', () => {
    const plan = singleStepPlan();
    const warnings = checkPlanDepthWarning(plan, 'deep_work');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe('SINGLE_STEP_DEPTH_WARNING');
    expect(warnings[0]!.message).toContain('Deep Work');
  });

  it('emits warning for single-step plan in analyst mode', () => {
    const plan = singleStepPlan();
    const warnings = checkPlanDepthWarning(plan, 'analyst');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe('SINGLE_STEP_DEPTH_WARNING');
    expect(warnings[0]!.message).toContain('Analyst');
  });

  it('does NOT reject the plan — warning is advisory only', () => {
    const plan = singleStepPlan();
    const warnings = checkPlanDepthWarning(plan, 'deep_work');
    // The function returns warnings, not throws — the plan is not rejected
    expect(warnings).toHaveLength(1);
    expect(Array.isArray(warnings)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// VAL-M1-010: Single-step plan in Auto/Fast does not emit depth warning
// ---------------------------------------------------------------------------

describe('VAL-M1-010: Single-step plan in Auto/Fast does not emit depth warning', () => {
  it('does not emit warning for single-step plan in fast mode', () => {
    const plan = singleStepPlan();
    const warnings = checkPlanDepthWarning(plan, 'fast');
    expect(warnings).toHaveLength(0);
  });

  it('does not emit warning for single-step plan in auto mode', () => {
    const plan = singleStepPlan();
    const warnings = checkPlanDepthWarning(plan, 'auto');
    expect(warnings).toHaveLength(0);
  });

  it('does not emit warning for single-step plan in custom mode', () => {
    const plan = singleStepPlan();
    const warnings = checkPlanDepthWarning(plan, 'custom');
    expect(warnings).toHaveLength(0);
  });

  it('does not emit warning for multi-step plan in deep_work mode', () => {
    const plan = twoStepPlan();
    const warnings = checkPlanDepthWarning(plan, 'deep_work');
    expect(warnings).toHaveLength(0);
  });

  it('does not emit warning for multi-step plan in analyst mode', () => {
    const plan = twoStepPlan();
    const warnings = checkPlanDepthWarning(plan, 'analyst');
    expect(warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// VAL-M1-011: planDepthHint is optional and does not break schema hash
// ---------------------------------------------------------------------------

describe('VAL-M1-011: planDepthHint is optional and does not break schema hash', () => {
  it('plan without planDepthHint validates successfully', () => {
    const plan = singleStepPlan();
    expect(plan.presentationMetadata?.planDepthHint).toBeUndefined();
  });

  it('plan with planDepthHint validates successfully', () => {
    const raw = singleStepPlan() as Record<string, unknown>;
    (raw as { presentationMetadata: Record<string, unknown> }).presentationMetadata = {
      cardTitle: 'Test',
      summary: 'Test summary',
      planDepthHint: 'deep',
    };
    const plan = validatePlan(raw);
    expect(plan.presentationMetadata?.planDepthHint).toBe('deep');
  });

  it('plan without planDepthHint produces same hash as plan with planDepthHint', () => {
    // planDepthHint is in presentationMetadata which is excluded from the hash
    const basePlan = singleStepPlan();
    const baseHash = planContentHash(basePlan);

    const withHint = validatePlan({
      ...basePlan,
      presentationMetadata: {
        cardTitle: 'Test',
        summary: 'Test summary',
        planDepthHint: 'deep',
      },
    });
    const withHintHash = planContentHash(withHint);

    expect(withHintHash).toBe(baseHash);
  });

  it('changing planDepthHint does not change the hash', () => {
    const plan1 = validatePlan({
      ...singleStepPlan(),
      presentationMetadata: { planDepthHint: 'deep' },
    });
    const plan2 = validatePlan({
      ...singleStepPlan(),
      presentationMetadata: { planDepthHint: 'shallow' },
    });
    expect(planContentHash(plan1)).toBe(planContentHash(plan2));
  });

  it('canonical content does not include planDepthHint', () => {
    const plan = validatePlan({
      ...singleStepPlan(),
      presentationMetadata: { planDepthHint: 'deep' },
    });
    const canonical = canonicalPlanContent(plan);
    expect(canonical).not.toHaveProperty('presentationMetadata');
    expect(canonical).not.toHaveProperty('planDepthHint');
  });
});

// ---------------------------------------------------------------------------
// VAL-M1-012: planDepthHint carries depth signal without forcing step count
// ---------------------------------------------------------------------------

describe('VAL-M1-012: planDepthHint carries depth signal', () => {
  it('planDepthHint "deep" is stored in metadata', () => {
    const plan = validatePlan({
      ...singleStepPlan(),
      presentationMetadata: { planDepthHint: 'deep' },
    });
    expect(plan.presentationMetadata?.planDepthHint).toBe('deep');
  });

  it('planDepthHint "shallow" is stored in metadata', () => {
    const plan = validatePlan({
      ...singleStepPlan(),
      presentationMetadata: { planDepthHint: 'shallow' },
    });
    expect(plan.presentationMetadata?.planDepthHint).toBe('shallow');
  });

  it('planDepthHint does not affect step count — single step with "deep" hint is valid', () => {
    const plan = validatePlan({
      ...singleStepPlan(),
      presentationMetadata: { planDepthHint: 'deep' },
    });
    expect(plan.steps).toHaveLength(1);
    expect(plan.presentationMetadata?.planDepthHint).toBe('deep');
  });

  it('planDepthHint does not affect step count — multi-step with "shallow" hint is valid', () => {
    const plan = validatePlan({
      ...twoStepPlan(),
      presentationMetadata: { planDepthHint: 'shallow' },
    });
    expect(plan.steps).toHaveLength(2);
    expect(plan.presentationMetadata?.planDepthHint).toBe('shallow');
  });
});

// ---------------------------------------------------------------------------
// VAL-M1-014: Determinism — same input produces same normalization result
// ---------------------------------------------------------------------------

describe('VAL-M1-014: Determinism — same input produces same normalization result', () => {
  it('normalizeToolAlias is deterministic for web_search', () => {
    const result1 = normalizeToolAlias('web_search');
    const result2 = normalizeToolAlias('web_search');
    expect(result1).toBe(result2);
    expect(result1).toBe('research.search');
  });

  it('normalizeToolAlias is deterministic for canonical names', () => {
    const result1 = normalizeToolAlias('research.search');
    const result2 = normalizeToolAlias('research.search');
    expect(result1).toBe(result2);
    expect(result1).toBe('research.search');
  });

  it('normalizeToolAlias is deterministic for unknown tools', () => {
    const result1 = normalizeToolAlias('unknown_tool');
    const result2 = normalizeToolAlias('unknown_tool');
    expect(result1).toBe(result2);
    expect(result1).toBe('unknown_tool');
  });

  it('normalization is a pure function — no side effects', () => {
    const before = RESEARCH_TOOL_TO_OPERATION['web_search'];
    normalizeToolAlias('web_search');
    normalizeToolAlias('web_search');
    normalizeToolAlias('research.search');
    const after = RESEARCH_TOOL_TO_OPERATION['web_search'];
    expect(before).toBe(after);
  });
});

// ---------------------------------------------------------------------------
// VAL-M1-113: Empty plan steps array does not crash validation
// ---------------------------------------------------------------------------

describe('VAL-M1-113: Empty plan steps array does not crash validation', () => {
  it('empty steps array is rejected by schema (min 1 step required)', () => {
    const raw = singleStepPlan() as Record<string, unknown>;
    (raw as { steps: unknown[] }).steps = [];
    expect(() => parsePlanContent(raw)).toThrow();
  });

  it('checkPlanDepthWarning handles empty steps without crashing', () => {
    // Even if somehow an empty plan reached the warning check, it should
    // not crash. An empty steps array means 0 steps, which is not 1, so no
    // warning is emitted.
    const emptyPlan = { ...singleStepPlan(), steps: [] } as unknown as PlanContent;
    const warnings = checkPlanDepthWarning(emptyPlan, 'deep_work');
    expect(warnings).toHaveLength(0);
  });

  it('normalizeToolAlias handles empty string without crashing', () => {
    expect(() => normalizeToolAlias('')).not.toThrow();
    expect(normalizeToolAlias('')).toBe('');
  });
});
