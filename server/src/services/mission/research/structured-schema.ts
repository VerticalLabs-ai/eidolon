import { z } from 'zod';

/**
 * Closed, bounded `StructuredExtractSchemaV1` validation.
 *
 * (VAL-RES-116)
 *
 * This module owns the authoritative validation for structured-extraction
 * schemas sent to research providers (e.g. Firecrawl `/v2/extract`). A
 * schema must be a closed, bounded JSON Schema subset:
 *
 * Bounds:
 * - At most 32,768 canonical UTF-8 bytes (canonical JSON serialization).
 * - Nesting depth at most 6 (root object = depth 1).
 * - At most 100 total properties across the entire schema.
 * - At most 100 array items (`maxItems`).
 * - At most 100 enum values per enum.
 * - At most 20,000 Unicode code points per string (`maxLength`).
 *
 * Supported JSON Schema keywords:
 * - Types: object, array, string, number, integer, boolean, null.
 * - `properties`, `required`, `additionalProperties: false`.
 * - `items`, `minItems`, `maxItems` (for arrays).
 * - `minimum`, `maximum` (for numbers/integers).
 * - `enum` (for any type).
 * - `description` (display metadata, bounded).
 *
 * Forbidden:
 * - `$ref`, `$id`, `$schema`, `$comment` (remote identifiers / references).
 * - `definitions`, `$defs` (used with `$ref` for recursion).
 * - Combinators: `allOf`, `anyOf`, `oneOf`, `not`.
 * - `additionalProperties: true` (open schemas).
 * - Unsafe prototype-pollution keys: `__proto__`, `prototype`, `constructor`.
 *
 * Provider output is validated against the frozen schema before persistence.
 */

// ---------------------------------------------------------------------------
// Bounds constants
// ---------------------------------------------------------------------------

export const STRUCTURED_EXTRACT_SCHEMA_BOUNDS = {
  maxBytes: 32_768,
  maxDepth: 6,
  maxTotalProperties: 100,
  maxArrayItems: 100,
  maxEnumValues: 100,
  maxStringCodePoints: 20_000,
  maxDescriptionCodePoints: 1_000,
} as const;

/** Keys that cause prototype pollution or unsafe property access. */
export const UNSAFE_SCHEMA_KEYS = ['__proto__', 'prototype', 'constructor'] as const;

/** Supported JSON Schema type values. */
const SUPPORTED_TYPES = [
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
] as const;

/** Forbidden top-level/sub-schema keywords. */
const FORBIDDEN_KEYWORDS = [
  '$ref',
  '$id',
  '$schema',
  '$comment',
  'definitions',
  '$defs',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
] as const;

/** Allowed keywords on an object schema node (beyond shared ones). */
const ALLOWED_OBJECT_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'description',
  'enum',
]);

/** Allowed keywords on an array schema node. */
const ALLOWED_ARRAY_KEYWORDS = new Set([
  'type',
  'items',
  'minItems',
  'maxItems',
  'description',
  'enum',
]);

/** Allowed keywords on a scalar (string/number/integer/boolean/null) node. */
const ALLOWED_SCALAR_KEYWORDS = new Set([
  'type',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'description',
  'enum',
]);

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export interface StructuredExtractSchemaValidationResult {
  valid: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Count Unicode code points (not UTF-16 code units). */
function countCodePoints(s: string): number {
  return [...s].length;
}

/** Measure the canonical UTF-8 byte length of a JSON-serializable value. */
function measureJsonBytes(value: unknown): number {
  return Buffer.from(JSON.stringify(value), 'utf8').length;
}

/** Measure the nesting depth of a JSON Schema object. Scalars = 0, objects = 1 + max(children). */
function measureSchemaDepth(node: unknown): number {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    return 0;
  }
  const obj = node as Record<string, unknown>;
  const type = obj.type;
  let maxChildDepth = 0;
  if (type === 'object' && obj.properties && typeof obj.properties === 'object') {
    for (const child of Object.values(obj.properties as Record<string, unknown>)) {
      maxChildDepth = Math.max(maxChildDepth, measureSchemaDepth(child));
    }
  }
  if (type === 'array' && obj.items && typeof obj.items === 'object') {
    maxChildDepth = Math.max(maxChildDepth, measureSchemaDepth(obj.items));
  }
  return 1 + maxChildDepth;
}

// ---------------------------------------------------------------------------
// Recursive validation
// ---------------------------------------------------------------------------

interface ValidationContext {
  errors: string[];
  totalProperties: number;
  path: string;
}

function addError(ctx: ValidationContext, message: string): void {
  ctx.errors.push(`${ctx.path}: ${message}`);
}

/** Check for forbidden keywords on a schema node. */
function checkForbiddenKeywords(node: Record<string, unknown>, ctx: ValidationContext): void {
  for (const keyword of FORBIDDEN_KEYWORDS) {
    if (keyword in node) {
      addError(ctx, `forbidden keyword "${keyword}"`);
    }
  }
}

/** Check for unsafe property keys in an object's `properties`. */
function checkUnsafeKeys(properties: Record<string, unknown>, ctx: ValidationContext): void {
  for (const key of Object.keys(properties)) {
    if ((UNSAFE_SCHEMA_KEYS as readonly string[]).includes(key)) {
      addError(ctx, `unsafe property key "${key}"`);
    }
  }
}

/** Validate shared keywords (enum, description) on any schema node. */
function validateSharedKeywords(obj: Record<string, unknown>, ctx: ValidationContext): void {
  // Validate `enum`.
  if ('enum' in obj) {
    const enumVal = obj.enum;
    if (!Array.isArray(enumVal)) {
      addError(ctx, 'enum must be an array');
    } else if (enumVal.length > STRUCTURED_EXTRACT_SCHEMA_BOUNDS.maxEnumValues) {
      addError(
        ctx,
        `enum has ${enumVal.length} values, exceeding max ${STRUCTURED_EXTRACT_SCHEMA_BOUNDS.maxEnumValues}`,
      );
    }
  }

  // Validate `description` code point bound.
  if ('description' in obj) {
    const desc = obj.description;
    if (typeof desc === 'string') {
      const cp = countCodePoints(desc);
      if (cp > STRUCTURED_EXTRACT_SCHEMA_BOUNDS.maxDescriptionCodePoints) {
        addError(
          ctx,
          `description exceeds ${STRUCTURED_EXTRACT_SCHEMA_BOUNDS.maxDescriptionCodePoints} code points (${cp})`,
        );
      }
    } else if (desc !== undefined) {
      addError(ctx, 'description must be a string');
    }
  }
}

/** Validate a single schema node recursively. */
function validateNode(node: unknown, ctx: ValidationContext, depth: number): void {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    addError(ctx, 'schema node must be a JSON object');
    return;
  }

  const obj = node as Record<string, unknown>;

  // Check forbidden keywords.
  checkForbiddenKeywords(obj, ctx);

  // Every schema node must have a `type`.
  const type = obj.type;
  if (typeof type !== 'string' || !(SUPPORTED_TYPES as readonly string[]).includes(type)) {
    addError(ctx, `unsupported or missing type "${String(type)}"`);
    return;
  }

  // Check allowed keywords for this type.
  const allowedKeywords =
    type === 'object'
      ? ALLOWED_OBJECT_KEYWORDS
      : type === 'array'
        ? ALLOWED_ARRAY_KEYWORDS
        : ALLOWED_SCALAR_KEYWORDS;

  for (const key of Object.keys(obj)) {
    if (!allowedKeywords.has(key)) {
      addError(ctx, `unexpected keyword "${key}" for type "${type}"`);
    }
  }

  // Validate `additionalProperties` must be false if present.
  if (type === 'object' && 'additionalProperties' in obj) {
    if (obj.additionalProperties !== false) {
      addError(ctx, 'additionalProperties must be false');
    }
  }

  // Validate shared keywords (enum, description).
  validateSharedKeywords(obj, ctx);

  // Type-specific validation.
  if (type === 'object') {
    validateObjectNode(obj, ctx, depth);
  } else if (type === 'array') {
    validateArrayNode(obj, ctx, depth);
  } else {
    validateScalarNode(obj, ctx);
  }
}

function validateObjectNode(
  obj: Record<string, unknown>,
  ctx: ValidationContext,
  depth: number,
): void {
  const properties = obj.properties;
  if (properties === undefined || properties === null) {
    // An object with no properties is valid (empty object schema).
    return;
  }
  if (typeof properties !== 'object' || Array.isArray(properties)) {
    addError(ctx, 'properties must be an object');
    return;
  }

  const props = properties as Record<string, unknown>;
  checkUnsafeKeys(props, ctx);

  const propCount = Object.keys(props).length;
  ctx.totalProperties += propCount;
  if (ctx.totalProperties > STRUCTURED_EXTRACT_SCHEMA_BOUNDS.maxTotalProperties) {
    addError(
      ctx,
      `total properties ${ctx.totalProperties} exceed max ${STRUCTURED_EXTRACT_SCHEMA_BOUNDS.maxTotalProperties}`,
    );
  }

  // Validate `required` references valid properties.
  if ('required' in obj) {
    const required = obj.required;
    if (!Array.isArray(required)) {
      addError(ctx, 'required must be an array');
    } else {
      for (const req of required) {
        if (typeof req !== 'string' || !(req in props)) {
          addError(ctx, `required references unknown property "${String(req)}"`);
        }
      }
    }
  }

  // Recurse into child properties.
  for (const [key, child] of Object.entries(props)) {
    const childCtx: ValidationContext = {
      errors: ctx.errors,
      totalProperties: ctx.totalProperties,
      path: `${ctx.path}.properties["${key}"]`,
    };
    validateNode(child, childCtx, depth + 1);
    ctx.totalProperties = childCtx.totalProperties;
  }
}

function validateArrayNode(
  obj: Record<string, unknown>,
  ctx: ValidationContext,
  depth: number,
): void {
  // Validate `items`.
  if ('items' in obj) {
    const items = obj.items;
    if (items === undefined || items === null) {
      // No items constraint — valid.
    } else if (typeof items !== 'object' || Array.isArray(items)) {
      addError(ctx, 'items must be a schema object');
    } else {
      const childCtx: ValidationContext = {
        errors: ctx.errors,
        totalProperties: ctx.totalProperties,
        path: `${ctx.path}.items`,
      };
      validateNode(items, childCtx, depth + 1);
      ctx.totalProperties = childCtx.totalProperties;
    }
  }

  // Validate `maxItems`.
  if ('maxItems' in obj) {
    const maxItems = obj.maxItems;
    if (typeof maxItems !== 'number' || !Number.isInteger(maxItems) || maxItems < 0) {
      addError(ctx, 'maxItems must be a non-negative integer');
    } else if (maxItems > STRUCTURED_EXTRACT_SCHEMA_BOUNDS.maxArrayItems) {
      addError(
        ctx,
        `maxItems ${maxItems} exceeds max ${STRUCTURED_EXTRACT_SCHEMA_BOUNDS.maxArrayItems}`,
      );
    }
  }

  // Validate `minItems`.
  if ('minItems' in obj) {
    const minItems = obj.minItems;
    if (typeof minItems !== 'number' || !Number.isInteger(minItems) || minItems < 0) {
      addError(ctx, 'minItems must be a non-negative integer');
    }
  }
}

function validateScalarNode(obj: Record<string, unknown>, ctx: ValidationContext): void {
  const type = obj.type as string;

  // String-specific bounds.
  if (type === 'string') {
    if ('maxLength' in obj) {
      const maxLength = obj.maxLength;
      if (typeof maxLength !== 'number' || !Number.isInteger(maxLength) || maxLength < 0) {
        addError(ctx, 'maxLength must be a non-negative integer');
      } else if (maxLength > STRUCTURED_EXTRACT_SCHEMA_BOUNDS.maxStringCodePoints) {
        addError(
          ctx,
          `maxLength ${maxLength} exceeds max ${STRUCTURED_EXTRACT_SCHEMA_BOUNDS.maxStringCodePoints} code points`,
        );
      }
    }
    if ('minLength' in obj) {
      const minLength = obj.minLength;
      if (typeof minLength !== 'number' || !Number.isInteger(minLength) || minLength < 0) {
        addError(ctx, 'minLength must be a non-negative integer');
      }
    }
  }

  // Number/integer bounds.
  if (type === 'number' || type === 'integer') {
    if ('minimum' in obj) {
      const minimum = obj.minimum;
      if (typeof minimum !== 'number' || !Number.isFinite(minimum)) {
        addError(ctx, 'minimum must be a finite number');
      }
    }
    if ('maximum' in obj) {
      const maximum = obj.maximum;
      if (typeof maximum !== 'number' || !Number.isFinite(maximum)) {
        addError(ctx, 'maximum must be a finite number');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a structured-extraction schema against `StructuredExtractSchemaV1`.
 *
 * Returns `{ valid: true, errors: [] }` when the schema is a closed, bounded
 * subset. Returns `{ valid: false, errors: [...] }` with specific error
 * messages when any bound or forbidden feature is detected.
 */
export function validateStructuredExtractSchema(
  schema: unknown,
): StructuredExtractSchemaValidationResult {
  const errors: string[] = [];

  // 1. Must be a plain object.
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return { valid: false, errors: ['schema must be a JSON object'] };
  }

  // 2. Byte bound.
  const bytes = measureJsonBytes(schema);
  if (bytes > STRUCTURED_EXTRACT_SCHEMA_BOUNDS.maxBytes) {
    errors.push(
      `schema is ${bytes} canonical UTF-8 bytes, exceeding max ${STRUCTURED_EXTRACT_SCHEMA_BOUNDS.maxBytes}`,
    );
  }

  // 3. Depth bound.
  const depth = measureSchemaDepth(schema);
  if (depth > STRUCTURED_EXTRACT_SCHEMA_BOUNDS.maxDepth) {
    errors.push(`schema depth ${depth} exceeds max ${STRUCTURED_EXTRACT_SCHEMA_BOUNDS.maxDepth}`);
  }

  // 4. Recursive keyword/type/bound validation.
  const ctx: ValidationContext = {
    errors,
    totalProperties: 0,
    path: 'root',
  };
  validateNode(schema, ctx, 1);

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Zod schema (for use at trust boundaries that prefer Zod)
// ---------------------------------------------------------------------------

/**
 * A Zod schema that accepts any plain object and then validates it through
 * `validateStructuredExtractSchema`. This lets callers use Zod's `.safeParse`
 * at trust boundaries while the actual closed-subset enforcement happens in
 * the deterministic manual validator.
 */
export const StructuredExtractSchemaV1 = z
  .record(z.string(), z.unknown())
  .superRefine((val, ctx) => {
    const result = validateStructuredExtractSchema(val);
    if (!result.valid) {
      for (const error of result.errors) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: error,
          path: [],
        });
      }
    }
  });
