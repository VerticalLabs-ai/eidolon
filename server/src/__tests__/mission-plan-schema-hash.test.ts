import { describe, expect, it } from 'vitest';
import {
  parsePlanContent,
  validatePlan,
  validatePlanGraph,
  canonicalPlanContent,
  planContentHash,
  validateApprovalBudgetArithmetic,
  PLAN_CONTENT_SCHEMA_VERSION,
  PLAN_EXECUTOR_FIELD_MANIFEST,
  PRESENTATION_METADATA_FIELDS,
  type PlanContent,
} from '../services/mission/plan-schema.js';
import { MISSION_PLAN_CONTRACT } from '@eidolon/shared';

/**
 * Closed PlanContentV1 validation, canonicalization, and hashing.
 *
 * Covers:
 * - VAL-PLAN-032: Material revision gets a new hash
 * - VAL-PLAN-034: Canonically equivalent content hashes identically
 * - VAL-PLAN-035: Array order changes the plan hash
 * - VAL-PLAN-036: Invalid canonical values are rejected
 * - VAL-PLAN-112: All decision-relevant plan fields are hash bound
 * - VAL-PLAN-113: Only a closed executable plan graph is approvable
 * - VAL-PLAN-124: PlanContentV1 is a closed executable schema
 * - VAL-PLAN-126: Approval budget arithmetic is reproducible
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A minimal valid plan with two ordered executable steps and synthesis. */
function validPlanContent(): PlanContent {
  return {
    schemaVersion: 1,
    objective: 'Produce a cited market brief.',
    steps: [
      {
        stepKey: 'research',
        parentStepKey: null,
        childOrdinal: 0,
        nodeKind: 'root',
        title: 'Research the market',
        description: 'Gather cited sources for the market brief.',
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
        completionCriteria: 'At least three cited sources retrieved.',
        budgetCents: 200,
        limits: {},
      },
      {
        stepKey: 'draft',
        parentStepKey: null,
        childOrdinal: 1,
        nodeKind: 'root',
        title: 'Draft the brief',
        description: 'Synthesize sources into a brief.',
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
        completionCriteria: 'Brief references every source.',
        budgetCents: 300,
        limits: {},
      },
    ],
    synthesis: {
      instructions: 'Merge the brief into a final cited deliverable.',
      declaredInputs: [{ kind: 'stepOutput', stepKey: 'draft', output: 'brief' }],
      declaredOutput: 'finalBrief',
      evidenceRequirements: { citationsRequired: true },
      completionCriteria: 'Every external claim has a citation.',
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
    presentationMetadata: {
      cardTitle: 'Market Brief Plan',
      summary: 'A short plan to produce a cited market brief.',
    },
  };
}

/** Helper: expect a payload to parse into a valid plan. */
function expectValidPlan(raw: unknown): PlanContent {
  return validatePlan(raw);
}

/** Helper: expect plan validation to throw. */
function expectInvalidPlan(raw: unknown, code?: string): void {
  expect(() => validatePlan(raw)).toThrow();
  if (code) {
    try {
      validatePlan(raw);
    } catch (err) {
      expect(String((err as { code?: string }).code ?? '')).toBe(code);
    }
  }
}

// ---------------------------------------------------------------------------
// VAL-PLAN-124: PlanContentV1 is a closed executable schema
// ---------------------------------------------------------------------------

describe('VAL-PLAN-124: PlanContentV1 is a closed executable schema', () => {
  it('accepts a complete full-schema fixture', () => {
    const plan = expectValidPlan(validPlanContent());
    expect(plan.schemaVersion).toBe(PLAN_CONTENT_SCHEMA_VERSION);
    expect(plan.steps).toHaveLength(2);
    expect(plan.synthesis.declaredOutput).toBe('finalBrief');
  });

  it('rejects an unknown authority field (closed schema)', () => {
    const raw = validPlanContent() as Record<string, unknown>;
    raw.unauthorizedAuthority = 'should-not-be-allowed';
    expect(() => parsePlanContent(raw)).toThrow();
  });

  it('rejects a missing required top-level field', () => {
    const raw = validPlanContent() as Record<string, unknown>;
    delete raw.partialResultPolicy;
    expect(() => parsePlanContent(raw)).toThrow();
  });

  it('rejects a missing required step field', () => {
    const raw = validPlanContent();
    delete (raw.steps[0] as Partial<PlanContent['steps'][number]>).stepKey;
    expect(() => parsePlanContent(raw)).toThrow();
  });

  it('rejects an invalid enum value', () => {
    const raw = validPlanContent();
    (raw as { partialResultPolicy: string }).partialResultPolicy = 'maybe';
    expect(() => parsePlanContent(raw)).toThrow();
  });

  it('rejects a non-integer money/token/byte limit', () => {
    const raw = validPlanContent();
    raw.limits.costCents = 100.5;
    expect(() => parsePlanContent(raw)).toThrow();
    const raw2 = validPlanContent();
    raw2.limits.totalTokens = 1.5;
    expect(() => parsePlanContent(raw2)).toThrow();
  });

  it('rejects a bad reference type', () => {
    const raw = validPlanContent();
    (raw.steps[1].inputBindings[0] as { source: { kind: string } }).source.kind = 'bogus';
    expect(() => parsePlanContent(raw)).toThrow();
  });

  it('exposes a generated executor field-consumption manifest', () => {
    // The manifest enumerates every authority field the executor reads, and
    // confirms presentation metadata is excluded.
    expect(PLAN_EXECUTOR_FIELD_MANIFEST.schemaVersion).toBe(PLAN_CONTENT_SCHEMA_VERSION);
    expect(PLAN_EXECUTOR_FIELD_MANIFEST.authorityFields).toContain('objective');
    expect(PLAN_EXECUTOR_FIELD_MANIFEST.authorityFields).toContain('steps');
    expect(PLAN_EXECUTOR_FIELD_MANIFEST.authorityFields).toContain('planningBudgetCents');
    expect(PLAN_EXECUTOR_FIELD_MANIFEST.presentationFields).toEqual(PRESENTATION_METADATA_FIELDS);
    for (const presentationField of PRESENTATION_METADATA_FIELDS) {
      expect(PLAN_EXECUTOR_FIELD_MANIFEST.authorityFields).not.toContain(presentationField);
    }
  });

  it('publishes a shared client contract mirroring the server schema', () => {
    expect(MISSION_PLAN_CONTRACT.schemaVersion).toBe(PLAN_CONTENT_SCHEMA_VERSION);
    expect(MISSION_PLAN_CONTRACT.nodeKinds).toContain('root');
    expect(MISSION_PLAN_CONTRACT.replayClasses).toContain('non_replayable');
    expect(MISSION_PLAN_CONTRACT.partialResultPolicies).toEqual(['require_all', 'best_effort']);
  });

  it('produces stable canonical bytes and a 64-char lowercase hex hash', () => {
    const plan = expectValidPlan(validPlanContent());
    const canonical = canonicalPlanContent(plan);
    // Canonical bytes are deterministic UTF-8 JSON with sorted object keys.
    const bytes = Buffer.from(JSON.stringify(canonical), 'utf8');
    expect(bytes.length).toBeGreaterThan(0);
    const hash = planContentHash(plan);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-032: Material revision gets a new hash
// ---------------------------------------------------------------------------

describe('VAL-PLAN-032: Material revision gets a new hash', () => {
  const base = validPlanContent();
  const baseHash = planContentHash(validatePlan(base));

  const mutations: Array<[string, (p: PlanContent) => void]> = [
    ['objective', (p) => void (p.objective = 'Produce a cited competitive analysis.')],
    ['step title', (p) => void (p.steps[0].title = 'Research the competitive market')],
    [
      'step description',
      (p) => void (p.steps[0].description = 'Gather cited competitive sources.'),
    ],
    ['step dependencies', (p) => void p.steps[1].dependencies.push('nonexistent-removed')],
    [
      'routing requirements',
      (p) =>
        void (
          p.steps[0].routing as {
            routingRequirements: { capabilities: string[] };
          }
        ).routingRequirements.capabilities.push('analysis'),
    ],
    ['exact tools', (p) => void p.steps[0].toolAllowlist.push('research.extract')],
    ['expected outputs', (p) => void p.steps[0].expectedOutputs.push('rawNotes')],
    [
      'completion criteria',
      (p) => void (p.steps[0].completionCriteria = 'At least five cited sources.'),
    ],
    ['step budget', (p) => void (p.steps[0].budgetCents = 250)],
    [
      'synthesis instructions',
      (p) => void (p.synthesis.instructions = 'Produce the final cited deliverable.'),
    ],
    ['synthesis budget', (p) => void (p.synthesis.budgetCents = 150)],
    ['planning budget', (p) => void (p.planningBudgetCents = 75)],
    ['partial-result policy', (p) => void (p.partialResultPolicy = 'best_effort')],
    ['limits costCents', (p) => void (p.limits.costCents = 2000)],
    ['limits depth', (p) => void (p.limits.depth = 1)],
    ['replay class', (p) => void (p.steps[1].replayClass = 'non_replayable')],
    ['side-effecting flag', (p) => void (p.steps[0].sideEffecting = true)],
    [
      'evidence requirements',
      (p) => void (p.steps[0].evidenceRequirements = { citationsRequired: false }),
    ],
    ['parent step key', (p) => void (p.steps[1].parentStepKey = 'research')],
    ['child ordinal', (p) => void (p.steps[0].childOrdinal = 2)],
    ['node kind', (p) => void (p.steps[0].nodeKind = 'child')],
    [
      'concrete executing agent',
      (p) => void (p.steps[0].routing = { kind: 'concreteAgent', executingAgentId: 'agent-1' }),
    ],
  ];

  for (const [label, mutate] of mutations) {
    it(`changes hash for material field: ${label}`, () => {
      const next = validatePlan(structuredClone(base));
      mutate(next);
      // Re-validate after mutation where the mutation may break invariants.
      const hash = planContentHash(next);
      expect(hash).not.toBe(baseHash);
    });
  }

  it('keeps the prior revision readable and unchanged', () => {
    const prior = validatePlan(structuredClone(base));
    const priorHash = planContentHash(prior);
    const next = validatePlan(structuredClone(base));
    next.objective = 'A different objective.';
    expect(planContentHash(prior)).toBe(priorHash);
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-034: Canonically equivalent content hashes identically
// ---------------------------------------------------------------------------

describe('VAL-PLAN-034: Canonically equivalent content hashes identically', () => {
  it('ignores object-key order', () => {
    const a = validatePlan(validPlanContent());
    // Reconstruct with top-level keys in reverse insertion order. canonicalHash
    // sorts object keys recursively, so any key ordering hashes identically.
    const keys = Object.keys(a as Record<string, unknown>).reverse();
    const reordered: Record<string, unknown> = {};
    for (const k of keys) {
      reordered[k] = (a as Record<string, unknown>)[k];
    }
    expect(planContentHash(validatePlan(reordered))).toBe(planContentHash(a));
  });

  it('normalizes Unicode NFC representations identically', () => {
    const a = validatePlan(validPlanContent());
    const b = validatePlan(structuredClone(a));
    // café decomposed (NFD) vs composed (NFC) — semantically identical.
    a.objective = 'Produce a cited market brief.\u00e9'; // é composed (NFC)
    b.objective = 'Produce a cited market brief.\u0065\u0301'; // e + combining acute (NFD)
    // Canonicalization NFC-normalizes both objectives to one byte sequence.
    expect(planContentHash(b)).toBe(planContentHash(a));
  });

  it('treats reordered set-semantic tool allowlists as equivalent', () => {
    const a = validatePlan(validPlanContent());
    const b = validatePlan(structuredClone(a));
    // Give step 0 two tools so a reorder is meaningful (not a trivial 1-element
    // list). Tool allowlists are sets; reordering is not a material change.
    a.steps[0].toolAllowlist = ['research.search', 'research.extract'];
    b.steps[0].toolAllowlist = ['research.extract', 'research.search'];
    expect(planContentHash(b)).toBe(planContentHash(a));
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-035: Array order changes the plan hash
// ---------------------------------------------------------------------------

describe('VAL-PLAN-035: Array order changes the plan hash', () => {
  it('changing step array order produces a different hash', () => {
    const a = validatePlan(validPlanContent());
    const b = validatePlan(structuredClone(a));
    [b.steps[0], b.steps[1]] = [b.steps[1], b.steps[0]];
    expect(planContentHash(b)).not.toBe(planContentHash(a));
  });

  it('changing ordered dependency array order produces a different hash', () => {
    const a = validatePlan({
      ...validPlanContent(),
      steps: [
        validPlanContent().steps[0],
        {
          ...validPlanContent().steps[1],
          dependencies: ['research'],
        },
        {
          ...validPlanContent().steps[0],
          stepKey: 'extra',
          title: 'Extra step',
          dependencies: ['research', 'draft'],
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
          expectedOutputs: ['extraOut'],
          inputBindings: [],
        },
      ],
    });
    const b = validatePlan(structuredClone(a));
    b.steps[2].dependencies = ['draft', 'research'];
    expect(planContentHash(b)).not.toBe(planContentHash(a));
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-036: Invalid canonical values are rejected
// ---------------------------------------------------------------------------

describe('VAL-PLAN-036: Invalid canonical values are rejected', () => {
  it('rejects undefined-equivalent omissions where required', () => {
    const raw = validPlanContent();
    delete (raw.steps[0] as Partial<PlanContent['steps'][number]>).stepKey;
    expectInvalidPlan(raw);
  });

  it('rejects NaN in a numeric limit', () => {
    const raw = validPlanContent();
    (raw.limits as { costCents: number }).costCents = NaN;
    expect(() => parsePlanContent(raw)).toThrow();
  });

  it('rejects Infinity in a numeric limit', () => {
    const raw = validPlanContent();
    (raw.limits as { totalTokens: number }).totalTokens = Infinity;
    expect(() => parsePlanContent(raw)).toThrow();
  });

  it('rejects duplicate step keys', () => {
    const raw = validPlanContent();
    raw.steps[1].stepKey = 'research';
    expect(() => validatePlanGraph(validatePlan(raw))).toThrow();
  });

  it('rejects non-integer money/token/byte limits', () => {
    const raw = validPlanContent();
    raw.limits.outputBytes = 1024.7;
    expect(() => parsePlanContent(raw)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-112: All decision-relevant plan fields are hash bound
// ---------------------------------------------------------------------------

describe('VAL-PLAN-112: All decision-relevant plan fields are hash bound', () => {
  const base = validatePlan(validPlanContent());
  const baseCanonical = canonicalPlanContent(base);

  it('canonical content contains every authority field', () => {
    expect(baseCanonical).not.toHaveProperty('presentationMetadata');
    expect(baseCanonical).toHaveProperty('schemaVersion');
    expect(baseCanonical).toHaveProperty('objective');
    expect(baseCanonical).toHaveProperty('steps');
    expect(baseCanonical).toHaveProperty('synthesis');
    expect(baseCanonical).toHaveProperty('planningBudgetCents');
    expect(baseCanonical).toHaveProperty('partialResultPolicy');
    expect(baseCanonical).toHaveProperty('limits');
  });

  it('a step canonical entry contains every step authority field', () => {
    const step = (baseCanonical.steps as unknown[])[0] as Record<string, unknown>;
    for (const field of [
      'stepKey',
      'parentStepKey',
      'childOrdinal',
      'nodeKind',
      'title',
      'description',
      'dependencies',
      'inputBindings',
      'routing',
      'toolAllowlist',
      'replayClass',
      'sideEffecting',
      'expectedOutputs',
      'evidenceRequirements',
      'completionCriteria',
      'budgetCents',
      'limits',
    ]) {
      expect(step).toHaveProperty(field);
    }
  });

  it('presentation metadata changes do not change the hash', () => {
    const a = validatePlan(validPlanContent());
    const baseHash = planContentHash(a);
    const b = validatePlan(structuredClone(a));
    b.presentationMetadata = {
      cardTitle: 'A totally different card title',
      summary: 'A totally different summary.',
    };
    expect(planContentHash(b)).toBe(baseHash);
  });

  it('presentation metadata is excluded from the executor field manifest', () => {
    const executorFields = PLAN_EXECUTOR_FIELD_MANIFEST.authorityFields;
    // No presentation field appears in the authority field list the executor
    // consumes, proving excluded metadata has no execution effect.
    for (const field of PRESENTATION_METADATA_FIELDS) {
      expect(executorFields).not.toContain(field);
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-113: Only a closed executable plan graph is approvable
// ---------------------------------------------------------------------------

describe('VAL-PLAN-113: Only a closed executable plan graph is approvable', () => {
  it('rejects zero executable steps', () => {
    const raw = validPlanContent();
    raw.steps = [];
    expect(() => validatePlan(raw)).toThrow();
  });

  it('rejects a self-dependency edge', () => {
    const raw = validPlanContent();
    raw.steps[0].dependencies = ['research'];
    expect(() => validatePlanGraph(validatePlan(raw))).toThrow();
  });

  it('rejects an unknown dependency edge', () => {
    const raw = validPlanContent();
    raw.steps[1].dependencies = ['ghost'];
    expect(() => validatePlanGraph(validatePlan(raw))).toThrow();
  });

  it('rejects a duplicate dependency edge', () => {
    const raw = validPlanContent();
    raw.steps[1].dependencies = ['research', 'research'];
    expect(() => validatePlanGraph(validatePlan(raw))).toThrow();
  });

  it('rejects a cyclic dependency graph', () => {
    const raw = validPlanContent();
    // research -> draft -> research forms a cycle.
    raw.steps[0].dependencies = ['draft'];
    raw.steps[1].dependencies = ['research'];
    expect(() => validatePlanGraph(validatePlan(raw))).toThrow();
  });

  it('rejects impossible routing (neither requirements nor concrete agent)', () => {
    const raw = validPlanContent();
    (raw.steps[0] as { routing: unknown }).routing = {
      kind: 'requirements',
      routingRequirements: null,
    };
    expect(() => validatePlan(raw)).toThrow();
  });

  it('rejects synthesis references to undeclared outputs', () => {
    const raw = validPlanContent();
    raw.synthesis.declaredInputs = [
      { kind: 'stepOutput', stepKey: 'draft', output: 'nonexistent' },
    ];
    expect(() => validatePlanGraph(validatePlan(raw))).toThrow();
  });

  it('rejects input bindings to undeclared outputs', () => {
    const raw = validPlanContent();
    raw.steps[1].inputBindings = [
      { name: 'sources', source: { kind: 'stepOutput', stepKey: 'research', output: 'missing' } },
    ];
    expect(() => validatePlanGraph(validatePlan(raw))).toThrow();
  });

  it('rejects totals that omit enforced planning/synthesis costs', () => {
    const raw = validPlanContent();
    // steps(200+300) + synthesis(100) + planning(50) = 650, but ceiling 600.
    raw.limits.costCents = 600;
    expect(() => validatePlanGraph(validatePlan(raw))).toThrow();
  });

  it('accepts one valid control graph', () => {
    const plan = validatePlan(validPlanContent());
    expect(plan.steps).toHaveLength(2);
    expect(planContentHash(plan)).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-126: Approval budget arithmetic is reproducible
// ---------------------------------------------------------------------------

describe('VAL-PLAN-126: Approval budget arithmetic is reproducible', () => {
  it('computes residual as rootReserved minus settled and in-flight planning', () => {
    const plan = validatePlan(validPlanContent()); // steps 500 + synthesis 100 = 600 envelope
    const result = validateApprovalBudgetArithmetic({
      rootReserved: 1000,
      settledPlanning: 30,
      inFlightPlanning: 20,
      plan,
    });
    expect(result.residualCents).toBe(950);
    expect(result.executionEnvelopeCents).toBe(600);
    expect(result.ok).toBe(true);
  });

  it('requires sum(step) + synthesis <= residual', () => {
    const plan = validatePlan(validPlanContent()); // envelope 600
    const result = validateApprovalBudgetArithmetic({
      rootReserved: 650,
      settledPlanning: 50, // planningBudgetCents already consumed
      inFlightPlanning: 10,
      plan,
    });
    // residual = 650 - 50 - 10 = 590 < 600 envelope
    expect(result.residualCents).toBe(590);
    expect(result.ok).toBe(false);
  });

  it('never double-counts planningBudgetCents in the execution envelope', () => {
    const plan = validatePlan(validPlanContent());
    // planningBudgetCents (50) is reporting authority already consumed; it is
    // not added to the execution envelope the approval earmarks.
    const result = validateApprovalBudgetArithmetic({
      rootReserved: 1000,
      settledPlanning: 50,
      inFlightPlanning: 0,
      plan,
    });
    expect(result.executionEnvelopeCents).toBe(600); // steps + synthesis only
    expect(result.ok).toBe(true);
  });

  it('reproduces identical arithmetic for identical inputs', () => {
    const plan = validatePlan(validPlanContent());
    const a = validateApprovalBudgetArithmetic({
      rootReserved: 1000,
      settledPlanning: 30,
      inFlightPlanning: 20,
      plan,
    });
    const b = validateApprovalBudgetArithmetic({
      rootReserved: 1000,
      settledPlanning: 30,
      inFlightPlanning: 20,
      plan,
    });
    expect(a).toEqual(b);
  });
});
