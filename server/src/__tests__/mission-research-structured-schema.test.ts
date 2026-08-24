import { describe, expect, it } from 'vitest';
import {
  StructuredExtractSchemaV1,
  validateStructuredExtractSchema,
  STRUCTURED_EXTRACT_SCHEMA_BOUNDS,
  UNSAFE_SCHEMA_KEYS,
  type StructuredExtractSchemaValidationResult,
} from '../services/mission/research/structured-schema.js';

/**
 * VAL-RES-116: Structured extraction accepts a closed bounded schema subset.
 *
 * `StructuredExtractSchemaV1` is at most 32,768 canonical UTF-8 bytes, depth 6,
 * 100 total properties, 100 array items, 100 enum values, and 20,000 code
 * points per string. It supports object/array/string/number/integer/boolean/
 * null, properties, required, additionalProperties:false, bounded items/
 * min/max/enum, and no `$ref`, recursion, combinators, remote identifiers,
 * unsafe patterns, or keys `__proto__`, `prototype`, or `constructor`.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expectValid(result: StructuredExtractSchemaValidationResult): void {
  expect(result.valid).toBe(true);
  expect(result.errors).toEqual([]);
}

function expectInvalid(result: StructuredExtractSchemaValidationResult, hint?: string): void {
  expect(result.valid).toBe(false);
  expect(result.errors.length).toBeGreaterThan(0);
  if (result.valid && hint) {
    throw new Error(`Expected invalid (${hint}) but schema was valid`);
  }
}

/** A minimal valid object schema. */
function minimalValidSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      name: { type: 'string' },
      age: { type: 'integer', minimum: 0, maximum: 150 },
    },
    required: ['name'],
    additionalProperties: false,
  };
}

// ---------------------------------------------------------------------------
// Supported types
// ---------------------------------------------------------------------------

describe('VAL-RES-116: supported JSON Schema types', () => {
  it('accepts object, array, string, number, integer, boolean, null', () => {
    const types = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
    for (const type of types) {
      const schema: Record<string, unknown> =
        type === 'array'
          ? { type: 'array', items: { type: 'string' }, maxItems: 10 }
          : type === 'object'
            ? minimalValidSchema()
            : { type };
      expectValid(validateStructuredExtractSchema(schema));
    }
  });

  it('rejects unsupported types', () => {
    const unsupported = ['any', 'object|string', 'enum'];
    for (const type of unsupported) {
      expectInvalid(validateStructuredExtractSchema({ type }), `type=${type}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Supported keywords
// ---------------------------------------------------------------------------

describe('VAL-RES-116: supported keywords', () => {
  it('accepts properties, required, additionalProperties:false', () => {
    expectValid(validateStructuredExtractSchema(minimalValidSchema()));
  });

  it('rejects additionalProperties:true', () => {
    expectInvalid(
      validateStructuredExtractSchema({
        type: 'object',
        properties: { a: { type: 'string' } },
        additionalProperties: true,
      }),
      'additionalProperties true',
    );
  });

  it('accepts bounded items, minItems, maxItems for arrays', () => {
    expectValid(
      validateStructuredExtractSchema({
        type: 'array',
        items: { type: 'string' },
        minItems: 0,
        maxItems: 10,
      }),
    );
  });

  it('accepts minimum, maximum for numbers', () => {
    expectValid(
      validateStructuredExtractSchema({
        type: 'integer',
        minimum: 0,
        maximum: 100,
      }),
    );
  });

  it('accepts enum with bounded values', () => {
    expectValid(
      validateStructuredExtractSchema({
        type: 'string',
        enum: ['a', 'b', 'c'],
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Forbidden features
// ---------------------------------------------------------------------------

describe('VAL-RES-116: forbidden features are rejected', () => {
  it('rejects $ref', () => {
    expectInvalid(validateStructuredExtractSchema({ $ref: '#/definitions/foo' }), '$ref');
  });

  it('rejects combinators (allOf, anyOf, oneOf, not)', () => {
    for (const combinator of ['allOf', 'anyOf', 'oneOf', 'not']) {
      const schema: Record<string, unknown> = {
        type: 'object',
        properties: { a: { type: 'string' } },
        [combinator]: [{ type: 'string' }],
      };
      expectInvalid(validateStructuredExtractSchema(schema), combinator);
    }
  });

  it('rejects $id, $schema, $comment (remote identifiers / metadata)', () => {
    for (const key of ['$id', '$schema', '$comment']) {
      const schema: Record<string, unknown> = {
        type: 'object',
        properties: { a: { type: 'string' } },
        [key]: 'https://example.com/schema',
      };
      expectInvalid(validateStructuredExtractSchema(schema), key);
    }
  });

  it('rejects definitions/$defs (used with $ref for recursion)', () => {
    expectInvalid(
      validateStructuredExtractSchema({
        type: 'object',
        properties: { a: { type: 'string' } },
        definitions: { foo: { type: 'string' } },
      }),
      'definitions',
    );
    expectInvalid(
      validateStructuredExtractSchema({
        type: 'object',
        properties: { a: { type: 'string' } },
        $defs: { foo: { type: 'string' } },
      }),
      '$defs',
    );
  });
});

// ---------------------------------------------------------------------------
// Unsafe keys
// ---------------------------------------------------------------------------

describe('VAL-RES-116: unsafe prototype-pollution keys are rejected', () => {
  it('rejects __proto__, prototype, constructor at any depth', () => {
    for (const key of UNSAFE_SCHEMA_KEYS) {
      const schema: Record<string, unknown> = {
        type: 'object',
        properties: {
          [key]: { type: 'string' },
        },
      };
      expectInvalid(validateStructuredExtractSchema(schema), `property key ${key}`);
    }
  });

  it('rejects unsafe keys in nested properties', () => {
    // Use JSON.parse so __proto__ is an own property (as it would be from
    // an HTTP request body). Object literal __proto__ sets the prototype,
    // not an own enumerable property.
    const schema = JSON.parse(
      '{"type":"object","properties":{"nested":{"type":"object","properties":{"__proto__":{"type":"string"}}}}}',
    );
    expectInvalid(validateStructuredExtractSchema(schema), 'nested __proto__');
  });
});

// ---------------------------------------------------------------------------
// Depth bound
// ---------------------------------------------------------------------------

describe('VAL-RES-116: depth bound (max 6)', () => {
  it('accepts schema at exactly depth 6', () => {
    // depth 1: root object
    // depth 2: properties.a object
    // depth 3: properties.b object
    // depth 4: properties.c object
    // depth 5: properties.d object
    // depth 6: properties.e object (leaf with string property)
    const schema: Record<string, unknown> = {
      type: 'object',
      properties: {
        a: {
          type: 'object',
          properties: {
            b: {
              type: 'object',
              properties: {
                c: {
                  type: 'object',
                  properties: {
                    d: {
                      type: 'object',
                      properties: {
                        e: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    expectValid(validateStructuredExtractSchema(schema));
  });

  it('rejects schema at depth 7 (one over)', () => {
    const schema: Record<string, unknown> = {
      type: 'object',
      properties: {
        a: {
          type: 'object',
          properties: {
            b: {
              type: 'object',
              properties: {
                c: {
                  type: 'object',
                  properties: {
                    d: {
                      type: 'object',
                      properties: {
                        e: {
                          type: 'object',
                          properties: {
                            f: { type: 'string' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    expectInvalid(validateStructuredExtractSchema(schema), 'depth 7');
  });
});

// ---------------------------------------------------------------------------
// Property count bound
// ---------------------------------------------------------------------------

describe('VAL-RES-116: property count bound (max 100 total)', () => {
  it('accepts schema with exactly 100 total properties', () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      properties[`prop${i}`] = { type: 'string' };
    }
    expectValid(
      validateStructuredExtractSchema({
        type: 'object',
        properties,
        additionalProperties: false,
      }),
    );
  });

  it('rejects schema with 101 total properties', () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 101; i++) {
      properties[`prop${i}`] = { type: 'string' };
    }
    expectInvalid(
      validateStructuredExtractSchema({
        type: 'object',
        properties,
        additionalProperties: false,
      }),
      '101 properties',
    );
  });

  it('counts nested properties toward the total', () => {
    // 50 top-level + 51 nested = 101 total
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      properties[`top${i}`] = { type: 'string' };
    }
    const nestedProps: Record<string, unknown> = {};
    for (let i = 0; i < 51; i++) {
      nestedProps[`nested${i}`] = { type: 'string' };
    }
    properties['nested'] = {
      type: 'object',
      properties: nestedProps,
    };
    expectInvalid(
      validateStructuredExtractSchema({
        type: 'object',
        properties,
        additionalProperties: false,
      }),
      'nested 101 total',
    );
  });
});

// ---------------------------------------------------------------------------
// Array items bound
// ---------------------------------------------------------------------------

describe('VAL-RES-116: array items bound (max 100)', () => {
  it('accepts array with exactly 100 maxItems', () => {
    expectValid(
      validateStructuredExtractSchema({
        type: 'array',
        items: { type: 'string' },
        maxItems: 100,
      }),
    );
  });

  it('rejects array with 101 maxItems', () => {
    expectInvalid(
      validateStructuredExtractSchema({
        type: 'array',
        items: { type: 'string' },
        maxItems: 101,
      }),
      '101 maxItems',
    );
  });
});

// ---------------------------------------------------------------------------
// Enum values bound
// ---------------------------------------------------------------------------

describe('VAL-RES-116: enum values bound (max 100)', () => {
  it('accepts enum with exactly 100 values', () => {
    const enumValues: string[] = [];
    for (let i = 0; i < 100; i++) {
      enumValues.push(`val${i}`);
    }
    expectValid(
      validateStructuredExtractSchema({
        type: 'string',
        enum: enumValues,
      }),
    );
  });

  it('rejects enum with 101 values', () => {
    const enumValues: string[] = [];
    for (let i = 0; i < 101; i++) {
      enumValues.push(`val${i}`);
    }
    expectInvalid(
      validateStructuredExtractSchema({
        type: 'string',
        enum: enumValues,
      }),
      '101 enum values',
    );
  });
});

// ---------------------------------------------------------------------------
// String code point bound
// ---------------------------------------------------------------------------

describe('VAL-RES-116: string code point bound (max 20,000 per string)', () => {
  it('accepts a string field with maxLength at exactly 20,000', () => {
    expectValid(
      validateStructuredExtractSchema({
        type: 'string',
        maxLength: 20_000,
      }),
    );
  });

  it('rejects a string field with maxLength 20,001', () => {
    expectInvalid(
      validateStructuredExtractSchema({
        type: 'string',
        maxLength: 20_001,
      }),
      'maxLength 20001',
    );
  });
});

// ---------------------------------------------------------------------------
// Byte bound
// ---------------------------------------------------------------------------

describe('VAL-RES-116: canonical UTF-8 byte bound (max 32,768)', () => {
  it('accepts a schema at exactly 32,768 canonical UTF-8 bytes', () => {
    // Build a schema with many properties and descriptions to hit exactly
    // 32768 bytes. We use 80 properties, each with a description padded to
    // a calculated length. The description is bounded to 1000 code points.
    const properties: Record<string, unknown> = {};
    // First, create 80 base properties without descriptions.
    for (let i = 0; i < 80; i++) {
      properties[`p${String(i).padStart(3, '0')}`] = { type: 'string' };
    }
    const base = {
      type: 'object' as const,
      properties,
      additionalProperties: false,
    };
    const baseBytes = Buffer.from(JSON.stringify(base), 'utf8').length;
    const remaining = STRUCTURED_EXTRACT_SCHEMA_BOUNDS.maxBytes - baseBytes;
    // Distribute remaining bytes across descriptions. Each description adds
    // ,"description":"..." to a property. Overhead per property = 18 bytes.
    // With 80 properties, overhead = 80*18 = 1440. Pad chars = remaining - 1440.
    const totalPadChars = remaining - 80 * 18;
    expect(totalPadChars).toBeGreaterThan(0);
    const padPerProp = Math.floor(totalPadChars / 80);
    const extra = totalPadChars - padPerProp * 80;
    let idx = 0;
    for (const key of Object.keys(properties)) {
      const pad = padPerProp + (idx < extra ? 1 : 0);
      (properties[key] as Record<string, unknown>).description = 'x'.repeat(pad);
      idx++;
    }
    // Fine-tune: adjust the last property's description to hit exact bytes.
    const currentBytes = Buffer.from(JSON.stringify(base), 'utf8').length;
    const diff = STRUCTURED_EXTRACT_SCHEMA_BOUNDS.maxBytes - currentBytes;
    if (diff !== 0) {
      const lastKey = Object.keys(properties).pop()!;
      const lastProp = properties[lastKey] as Record<string, unknown>;
      const currentDesc = lastProp.description as string;
      lastProp.description = currentDesc + 'x'.repeat(Math.max(0, diff));
    }
    const finalBytes = Buffer.from(JSON.stringify(base), 'utf8').length;
    expect(finalBytes).toBe(STRUCTURED_EXTRACT_SCHEMA_BOUNDS.maxBytes);
    expectValid(validateStructuredExtractSchema(base));
  });

  it('rejects a schema exceeding 32,768 canonical UTF-8 bytes', () => {
    // Build a schema that exceeds the byte limit.
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      properties[`property_with_long_name_${String(i).padStart(3, '0')}`] = {
        type: 'string',
        description: 'x'.repeat(300),
      };
    }
    const schema = {
      type: 'object',
      properties,
      additionalProperties: false,
    };
    const bytes = Buffer.from(JSON.stringify(schema), 'utf8').length;
    expect(bytes).toBeGreaterThan(STRUCTURED_EXTRACT_SCHEMA_BOUNDS.maxBytes);
    expectInvalid(validateStructuredExtractSchema(schema), 'over byte limit');
  });
});

// ---------------------------------------------------------------------------
// Zod schema export
// ---------------------------------------------------------------------------

describe('VAL-RES-116: StructuredExtractSchemaV1 Zod schema', () => {
  it('parses a valid schema', () => {
    const result = StructuredExtractSchemaV1.safeParse(minimalValidSchema());
    expect(result.success).toBe(true);
  });

  it('rejects an invalid schema', () => {
    const result = StructuredExtractSchemaV1.safeParse({ $ref: '#/foo' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Recursion detection
// ---------------------------------------------------------------------------

describe('VAL-RES-116: recursion is rejected', () => {
  it('rejects a self-referencing schema via $ref', () => {
    expectInvalid(validateStructuredExtractSchema({ $ref: '#' }), 'self-referencing $ref');
  });
});
