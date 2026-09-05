import { z } from 'zod';
import { PLATFORM_HARD_CAPS } from './modes.js';

/**
 * Closed, bounded, and inert Zod schemas for custom Mission mode profiles.
 *
 * (VAL-MODEQ-152) Custom profiles use:
 * - slug `[a-z0-9][a-z0-9-]{0,63}`
 * - name 1–100 Unicode code points
 * - description at most 1,000 Unicode code points
 * - private instructions at most 20,000 code points
 * - config depth 8 and canonical size 65,536 bytes
 * - at most 100 tools and 100 domains
 * - finite nonnegative integer limits
 *
 * Unknown authority-bearing fields, unsafe controls/bidi, invalid values,
 * and oversized payloads are rejected. Selector responses omit private
 * instructions/secrets and render names/descriptions as inert text.
 */

/** Count Unicode code points (not UTF-16 code units). */
function codepointCount(s: string): number {
  return [...s].length;
}

/** Refine: string length in Unicode code points within [min, max]. */
function codepointRange(min: number, max: number) {
  return (s: string) => {
    const n = codepointCount(s);
    return n >= min && n <= max;
  };
}

/**
 * Reject Unicode control characters and BiDi override/embedding controls
 * that could cause deceptive rendering or injection. Specifically rejects:
 * - C0 controls except TAB/LF/CR (U+0000–U+0008, U+000B, U+000C, U+000E–U+001F)
 * - C1 controls (U+007F–U+009F)
 * - BiDi controls: LRE, RLE, LRO, RLO, PDF, LRI, RLI, FSI, PDI
 * - Zero-width joiners/invisible marks used for spoofing: ZWSP, ZWNJ (allowed
 *   in some writing systems but flagged here for safety), ZWJ (needed for
 *   emoji but disallowed in authority-bearing text)
 *
 * We allow TAB (U+0009), LF (U+000A), CR (U+000D) in instructions/description
 * since those are legitimate formatting characters.
 */
/* eslint-disable no-control-regex, no-misleading-character-class */
const UNSAFE_CODEPOINT_RE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u200B\u200C\u200D\uFEFF]/;
/* eslint-enable no-control-regex, no-misleading-character-class */

function rejectUnsafeControls(s: string): boolean {
  return !UNSAFE_CODEPOINT_RE.test(s);
}

/** Slug: [a-z0-9][a-z0-9-]{0,63} — lowercase alphanumeric + hyphens. */
export const ProfileSlug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'Slug must match [a-z0-9][a-z0-9-]{0,63}')
  .refine((s) => !s.startsWith('-') && !s.endsWith('-'), 'Slug must not start or end with hyphen')
  .refine((s) => !s.includes('--'), 'Slug must not contain consecutive hyphens');

/** Name: 1–100 Unicode code points, no unsafe controls. */
export const ProfileName = z
  .string()
  .refine(codepointRange(1, 100), 'Name must be 1–100 Unicode code points')
  .refine(rejectUnsafeControls, 'Name must not contain control or BiDi override characters');

/** Description: 0–1,000 Unicode code points, no unsafe controls. */
export const ProfileDescription = z
  .string()
  .refine(codepointRange(0, 1000), 'Description must be at most 1,000 Unicode code points')
  .refine(rejectUnsafeControls, 'Description must not contain control or BiDi override characters')
  .optional();

/** Private instructions: 0–20,000 Unicode code points, no unsafe BiDi controls. */
export const ProfileInstructions = z
  .string()
  .refine(codepointRange(0, 20_000), 'Instructions must be at most 20,000 Unicode code points')
  .refine(rejectUnsafeControls, 'Instructions must not contain control or BiDi override characters')
  .optional();

/** Finite nonnegative integer for limits. */
const FiniteNonNegInt = z
  .number()
  .int('Limit must be an integer')
  .nonnegative('Limit must be nonnegative')
  .finite('Limit must be finite');

/**
 * Profile limits. All optional; omitted limits inherit from the built-in
 * defaults and are narrowed by platform/company/agent policy at resolution.
 * Values may only lower the effective limit, never raise it.
 *
 * (VAL-MODEQ-020) Profile administration rejects any declared limit that
 * exceeds the corresponding platform hard cap with a 400 VALIDATION_ERROR.
 * This is a fail-closed admin-time guard: a profile must never be persisted
 * with authority broader than the platform allows. Start-time resolution
 * remains deny-biased (min wins) as defense-in-depth, but administration
 * is the first gate. Fields without a platform hard cap (e.g. `steps`) are
 * not capped here.
 */
const PROFILE_LIMIT_CAPS: ReadonlyArray<readonly [string, number]> = [
  ['durationSeconds', PLATFORM_HARD_CAPS.durationSeconds],
  ['providerCalls', PLATFORM_HARD_CAPS.providerCalls],
  ['totalTokens', PLATFORM_HARD_CAPS.totalTokens],
  ['outputBytes', PLATFORM_HARD_CAPS.outputBytes],
  ['costCents', PLATFORM_HARD_CAPS.costCents],
  ['depth', PLATFORM_HARD_CAPS.depth],
  ['fanOut', PLATFORM_HARD_CAPS.fanOut],
  ['descendants', PLATFORM_HARD_CAPS.descendants],
];

export const ProfileLimits = z
  .object({
    steps: FiniteNonNegInt.optional(),
    durationSeconds: FiniteNonNegInt.optional(),
    providerCalls: FiniteNonNegInt.optional(),
    totalTokens: FiniteNonNegInt.optional(),
    outputBytes: FiniteNonNegInt.optional(),
    costCents: FiniteNonNegInt.optional(),
    depth: FiniteNonNegInt.optional(),
    fanOut: FiniteNonNegInt.optional(),
    descendants: FiniteNonNegInt.optional(),
  })
  .strict()
  .superRefine((limits, ctx) => {
    for (const [field, cap] of PROFILE_LIMIT_CAPS) {
      const value = limits[field as keyof typeof limits];
      if (value !== undefined && value > cap) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `Limit ${field}=${value} exceeds platform hard cap ${cap}`,
        });
      }
    }
  });

/** Planning strategy. */
const PlanningStrategy = z.enum(['never', 'when_complex', 'always']).optional();

/** Approval strategy. */
const ApprovalStrategy = z.enum(['never', 'when_complex', 'always']).optional();

/** Research access. */
const ResearchAccess = z.enum(['off', 'allowed', 'required']).optional();

/** Partial result policy. */
const PartialResultPolicy = z.enum(['require_all', 'best_effort']).optional();

/** Tool allowlist: at most 100 exact qualified tool names. */
const ToolAllowlist = z
  .array(z.string().min(1).max(200))
  .max(100, 'At most 100 tools allowed')
  .optional();

/** Domain allowlist: at most 100 exact domain names. */
const DomainAllowlist = z
  .array(z.string().min(1).max(253))
  .max(100, 'At most 100 domains allowed')
  .optional();

/**
 * Required capabilities the initiating agent must possess. Used at start to
 * verify the agent is eligible before policy resolution.
 */
const RequiredCapabilities = z
  .array(z.string().min(1).max(100))
  .max(50, 'At most 50 required capabilities allowed')
  .optional();

/**
 * Required provider/model for the custom profile. At start, the initiating
 * agent's provider/model must match if specified.
 */
const RequiredProvider = z.string().min(1).max(50).optional();
const RequiredModel = z.string().min(1).max(100).optional();

/**
 * The closed config object. `.strict()` rejects unknown fields so no
 * authority-bearing field can be smuggled in. Depth and canonical size
 * are checked after parsing.
 */
export const ProfileConfig = z
  .object({
    planning: PlanningStrategy,
    approval: ApprovalStrategy,
    research: ResearchAccess,
    partialResultPolicy: PartialResultPolicy,
    limits: ProfileLimits.optional(),
    toolAllowlist: ToolAllowlist,
    domainAllowlist: DomainAllowlist,
    requiredCapabilities: RequiredCapabilities,
    requiredProvider: RequiredProvider,
    requiredModel: RequiredModel,
  })
  .strict();

/**
 * Measure the nesting depth of a JSON value. Primitive = 0,
 * array/object containing only primitives = 1, etc.
 */
function jsonDepth(value: unknown, seen = new Set<unknown>()): number {
  if (value === null || typeof value !== 'object') {
    return 0;
  }
  if (seen.has(value)) {
    return 0; // cycle guard
  }
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return 1;
    }
    return 1 + Math.max(...value.map((v) => jsonDepth(v, seen)));
  }
  const values = Object.values(value as Record<string, unknown>);
  if (values.length === 0) {
    return 1;
  }
  return 1 + Math.max(...values.map((v) => jsonDepth(v, seen)));
}

/** Canonical UTF-8 byte size of a JSON-serialized value. */
function canonicalByteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** Maximum config nesting depth. */
export const MAX_CONFIG_DEPTH = 8;

/** Maximum config canonical size in bytes. */
export const MAX_CONFIG_BYTES = 65_536;

/**
 * Validate a complete custom profile payload (create or update).
 * Returns the parsed, validated config or throws a ZodError.
 *
 * Performs the post-parse checks for config depth and canonical size
 * that Zod cannot express declaratively.
 */
export const CreateProfileBody = z
  .object({
    slug: ProfileSlug,
    name: ProfileName,
    description: ProfileDescription,
    config: ProfileConfig,
    enabled: z.boolean().optional().default(true),
  })
  .strict()
  .superRefine((val, ctx) => {
    const depth = jsonDepth(val.config);
    if (depth > MAX_CONFIG_DEPTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['config'],
        message: `Config nesting depth ${depth} exceeds maximum ${MAX_CONFIG_DEPTH}`,
      });
    }
    const size = canonicalByteSize(val.config);
    if (size > MAX_CONFIG_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['config'],
        message: `Config canonical size ${size} bytes exceeds maximum ${MAX_CONFIG_BYTES} bytes`,
      });
    }
  });

/**
 * PATCH body: all fields optional, but config is validated the same way.
 * The `enabled` field is the sole lifecycle control (disable/enable).
 */
export const UpdateProfileBody = z
  .object({
    name: ProfileName.optional(),
    description: ProfileDescription,
    config: ProfileConfig.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.config) {
      const depth = jsonDepth(val.config);
      if (depth > MAX_CONFIG_DEPTH) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['config'],
          message: `Config nesting depth ${depth} exceeds maximum ${MAX_CONFIG_DEPTH}`,
        });
      }
      const size = canonicalByteSize(val.config);
      if (size > MAX_CONFIG_BYTES) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['config'],
          message: `Config canonical size ${size} bytes exceeds maximum ${MAX_CONFIG_BYTES} bytes`,
        });
      }
    }
  });

/**
 * Public (selector-safe) profile representation. Omits private instructions
 * and secrets; renders name/description as inert text (the route handler
 * escapes HTML, but the schema ensures no BiDi/control characters survive
 * validation).
 */
export interface PublicModeProfile {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  enabled: boolean;
  version: number;
  config: {
    planning?: string;
    approval?: string;
    research?: string;
    partialResultPolicy?: string;
    limits?: Record<string, number>;
    toolAllowlist?: string[];
    domainAllowlist?: string[];
    requiredCapabilities?: string[];
    requiredProvider?: string;
    requiredModel?: string;
  };
  createdAt: string;
  updatedAt: string;
}

/**
 * Convert a mode_profiles row to a public representation that omits
 * private instructions/secrets. The config itself contains no secrets
 * (instructions are stored separately in the profile payload, not in
 * config), but we strip any internal-only fields here.
 */
export function toPublicProfile(row: {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  enabled: boolean;
  version: number;
  config: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}): PublicModeProfile {
  const config = (row.config ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    version: row.version,
    config: {
      planning: config.planning as string | undefined,
      approval: config.approval as string | undefined,
      research: config.research as string | undefined,
      partialResultPolicy: config.partialResultPolicy as string | undefined,
      limits: config.limits as Record<string, number> | undefined,
      toolAllowlist: config.toolAllowlist as string[] | undefined,
      domainAllowlist: config.domainAllowlist as string[] | undefined,
      requiredCapabilities: config.requiredCapabilities as string[] | undefined,
      requiredProvider: config.requiredProvider as string | undefined,
      requiredModel: config.requiredModel as string | undefined,
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** List query: bounded page with opaque keyset cursor. */
export const ListProfilesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: z.string().max(512).optional(),
  /** If true, include disabled profiles (admin only). */
  includeDisabled: z.coerce.boolean().optional(),
});

/** Parsed profile config type. */
export type ParsedProfileConfig = z.infer<typeof ProfileConfig>;
export type ParsedCreateProfileBody = z.infer<typeof CreateProfileBody>;
export type ParsedUpdateProfileBody = z.infer<typeof UpdateProfileBody>;
