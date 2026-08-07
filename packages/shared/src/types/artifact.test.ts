import { describe, expect, it } from 'vitest';
import {
  DocumentContentSchema,
  SheetContentSchema,
  ArtifactTypeSchema,
  validateArtifactContent,
} from './artifact.js';

// ---------------------------------------------------------------------------
// DocumentContentSchema
// ---------------------------------------------------------------------------

describe('DocumentContentSchema', () => {
  it('accepts markdown format with string body', () => {
    const result = DocumentContentSchema.safeParse({ format: 'markdown', body: '# Hello' });
    expect(result.success).toBe(true);
  });

  it('accepts markdown format with empty body', () => {
    const result = DocumentContentSchema.safeParse({ format: 'markdown', body: '' });
    expect(result.success).toBe(true);
  });

  it('accepts delta format with block array body', () => {
    const result = DocumentContentSchema.safeParse({
      format: 'delta',
      body: [{ insert: 'Hello' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing format', () => {
    const result = DocumentContentSchema.safeParse({ body: 'text' });
    expect(result.success).toBe(false);
  });

  it('rejects unknown format value', () => {
    const result = DocumentContentSchema.safeParse({ format: 'bogus', body: 'text' });
    expect(result.success).toBe(false);
  });

  it('rejects markdown format with non-string body', () => {
    const result = DocumentContentSchema.safeParse({ format: 'markdown', body: 123 });
    expect(result.success).toBe(false);
  });

  it('rejects delta format with non-array body', () => {
    const result = DocumentContentSchema.safeParse({ format: 'delta', body: 'text' });
    expect(result.success).toBe(false);
  });

  it('rejects missing body', () => {
    const result = DocumentContentSchema.safeParse({ format: 'markdown' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SheetContentSchema
// ---------------------------------------------------------------------------

describe('SheetContentSchema', () => {
  it('accepts a minimal valid sheet (1 column, 1 row, 1 cell)', () => {
    const result = SheetContentSchema.safeParse({
      columns: [{ id: 'c1', key: 'name' }],
      rows: [{ id: 'r1', cells: { name: { value: 'Alice' } } }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts empty columns and rows', () => {
    const result = SheetContentSchema.safeParse({ columns: [], rows: [] });
    expect(result.success).toBe(true);
  });

  it('accepts a cell with numeric value', () => {
    const result = SheetContentSchema.safeParse({
      columns: [{ id: 'c1', key: 'qty' }],
      rows: [{ id: 'r1', cells: { qty: { value: 42 } } }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a cell with boolean value', () => {
    const result = SheetContentSchema.safeParse({
      columns: [{ id: 'c1', key: 'flag' }],
      rows: [{ id: 'r1', cells: { flag: { value: true } } }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a cell with null value', () => {
    const result = SheetContentSchema.safeParse({
      columns: [{ id: 'c1', key: 'opt' }],
      rows: [{ id: 'r1', cells: { opt: { value: null } } }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a cell with a formula', () => {
    const result = SheetContentSchema.safeParse({
      columns: [{ id: 'c1', key: 'total' }],
      rows: [{ id: 'r1', cells: { total: { value: 10, formula: '=SUM(A1:A3)' } } }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a column with optional width', () => {
    const result = SheetContentSchema.safeParse({
      columns: [{ id: 'c1', key: 'name', width: 120 }],
      rows: [],
    });
    expect(result.success).toBe(true);
  });

  it('rejects columns missing id', () => {
    const result = SheetContentSchema.safeParse({
      columns: [{ key: 'name' }],
      rows: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects columns missing key', () => {
    const result = SheetContentSchema.safeParse({
      columns: [{ id: 'c1' }],
      rows: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects rows missing id', () => {
    const result = SheetContentSchema.safeParse({
      columns: [{ id: 'c1', key: 'name' }],
      rows: [{ cells: { name: { value: 'Alice' } } }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects rows missing cells', () => {
    const result = SheetContentSchema.safeParse({
      columns: [{ id: 'c1', key: 'name' }],
      rows: [{ id: 'r1' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a cell referencing an unknown column key', () => {
    const result = SheetContentSchema.safeParse({
      columns: [{ id: 'c1', key: 'name' }],
      rows: [{ id: 'r1', cells: { unknown: { value: 'x' } } }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing columns field entirely', () => {
    const result = SheetContentSchema.safeParse({ rows: [] });
    expect(result.success).toBe(false);
  });

  it('rejects missing rows field entirely', () => {
    const result = SheetContentSchema.safeParse({ columns: [] });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ArtifactTypeSchema
// ---------------------------------------------------------------------------

describe('ArtifactTypeSchema', () => {
  it('accepts all 9 artifact types', () => {
    const types = [
      'document', 'sheet', 'board', 'slide_deck', 'timeline',
      'gallery', 'dashboard', 'app', 'code',
    ];
    for (const type of types) {
      expect(ArtifactTypeSchema.safeParse(type).success).toBe(true);
    }
  });

  it('rejects an unknown type', () => {
    expect(ArtifactTypeSchema.safeParse('bogus_type').success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateArtifactContent
// ---------------------------------------------------------------------------

describe('validateArtifactContent', () => {
  it('validates document content against the document schema', () => {
    const result = validateArtifactContent('document', { format: 'markdown', body: '# Hi' });
    expect(result.success).toBe(true);
  });

  it('validates sheet content against the sheet schema', () => {
    const result = validateArtifactContent('sheet', {
      columns: [{ id: 'c1', key: 'name' }],
      rows: [{ id: 'r1', cells: { name: { value: 'Alice' } } }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid document content', () => {
    const result = validateArtifactContent('document', { format: 'bogus' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid sheet content', () => {
    const result = validateArtifactContent('sheet', { notAColumnField: 1 });
    expect(result.success).toBe(false);
  });

  it('rejects content for an unknown type', () => {
    const result = validateArtifactContent('bogus' as never, { foo: 1 });
    expect(result.success).toBe(false);
  });
});
