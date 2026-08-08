import { describe, expect, it } from 'vitest';
import {
  DocumentContentSchema,
  SheetContentSchema,
  BoardContentSchema,
  SlideDeckContentSchema,
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
// BoardContentSchema
// ---------------------------------------------------------------------------

describe('BoardContentSchema', () => {
  it('accepts a minimal valid board (1 column, 1 card)', () => {
    const result = BoardContentSchema.safeParse({
      columns: [{ id: 'col1', title: 'Todo' }],
      cards: [{ id: 'card1', columnId: 'col1', title: 'First card', order: 0 }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts empty columns and cards', () => {
    const result = BoardContentSchema.safeParse({ columns: [], cards: [] });
    expect(result.success).toBe(true);
  });

  it('accepts multiple columns with cards spread across them', () => {
    const result = BoardContentSchema.safeParse({
      columns: [
        { id: 'col1', title: 'Todo' },
        { id: 'col2', title: 'Doing' },
        { id: 'col3', title: 'Done' },
      ],
      cards: [
        { id: 'card1', columnId: 'col1', title: 'A', order: 0 },
        { id: 'card2', columnId: 'col2', title: 'B', order: 0 },
        { id: 'card3', columnId: 'col2', title: 'C', order: 1 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a card with an optional payload', () => {
    const result = BoardContentSchema.safeParse({
      columns: [{ id: 'col1', title: 'Todo' }],
      cards: [
        {
          id: 'card1',
          columnId: 'col1',
          title: 'A',
          order: 0,
          payload: { description: 'details', priority: 3 },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a column with an empty title', () => {
    const result = BoardContentSchema.safeParse({
      columns: [{ id: 'col1', title: '' }],
      cards: [],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a card referencing an unknown column id', () => {
    const result = BoardContentSchema.safeParse({
      columns: [{ id: 'col1', title: 'Todo' }],
      cards: [{ id: 'card1', columnId: 'nope', title: 'Orphan', order: 0 }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects any card when there are no columns', () => {
    const result = BoardContentSchema.safeParse({
      columns: [],
      cards: [{ id: 'card1', columnId: 'col1', title: 'Orphan', order: 0 }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate column ids', () => {
    const result = BoardContentSchema.safeParse({
      columns: [
        { id: 'col1', title: 'Todo' },
        { id: 'col1', title: 'Doing' },
      ],
      cards: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate card ids', () => {
    const result = BoardContentSchema.safeParse({
      columns: [{ id: 'col1', title: 'Todo' }],
      cards: [
        { id: 'card1', columnId: 'col1', title: 'A', order: 0 },
        { id: 'card1', columnId: 'col1', title: 'B', order: 1 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a column missing id', () => {
    const result = BoardContentSchema.safeParse({
      columns: [{ title: 'Todo' }],
      cards: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a column with an empty id', () => {
    const result = BoardContentSchema.safeParse({
      columns: [{ id: '', title: 'Todo' }],
      cards: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a column missing title', () => {
    const result = BoardContentSchema.safeParse({
      columns: [{ id: 'col1' }],
      cards: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a card missing id', () => {
    const result = BoardContentSchema.safeParse({
      columns: [{ id: 'col1', title: 'Todo' }],
      cards: [{ columnId: 'col1', title: 'A', order: 0 }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a card missing columnId', () => {
    const result = BoardContentSchema.safeParse({
      columns: [{ id: 'col1', title: 'Todo' }],
      cards: [{ id: 'card1', title: 'A', order: 0 }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a card missing title', () => {
    const result = BoardContentSchema.safeParse({
      columns: [{ id: 'col1', title: 'Todo' }],
      cards: [{ id: 'card1', columnId: 'col1', order: 0 }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a card missing order', () => {
    const result = BoardContentSchema.safeParse({
      columns: [{ id: 'col1', title: 'Todo' }],
      cards: [{ id: 'card1', columnId: 'col1', title: 'A' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a card with a non-numeric order', () => {
    const result = BoardContentSchema.safeParse({
      columns: [{ id: 'col1', title: 'Todo' }],
      cards: [{ id: 'card1', columnId: 'col1', title: 'A', order: '0' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a card with a non-finite order', () => {
    const result = BoardContentSchema.safeParse({
      columns: [{ id: 'col1', title: 'Todo' }],
      cards: [{ id: 'card1', columnId: 'col1', title: 'A', order: Number.NaN }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing columns field entirely', () => {
    const result = BoardContentSchema.safeParse({ cards: [] });
    expect(result.success).toBe(false);
  });

  it('rejects missing cards field entirely', () => {
    const result = BoardContentSchema.safeParse({ columns: [] });
    expect(result.success).toBe(false);
  });

  it('rejects columns that are not an array', () => {
    const result = BoardContentSchema.safeParse({ columns: {}, cards: [] });
    expect(result.success).toBe(false);
  });

  it('rejects cards that are not an array', () => {
    const result = BoardContentSchema.safeParse({ columns: [], cards: {} });
    expect(result.success).toBe(false);
  });

  it('preserves every card and column on a successful parse', () => {
    const content = {
      columns: [
        { id: 'col1', title: 'Todo' },
        { id: 'col2', title: 'Done' },
      ],
      cards: [
        { id: 'card1', columnId: 'col1', title: 'A', order: 0 },
        { id: 'card2', columnId: 'col2', title: 'B', order: 0 },
      ],
    };
    const result = BoardContentSchema.safeParse(content);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.columns).toHaveLength(2);
      expect(result.data.cards).toHaveLength(2);
      expect(result.data).toEqual(content);
    }
  });
});

// ---------------------------------------------------------------------------
// SlideDeckContentSchema
// ---------------------------------------------------------------------------

describe('SlideDeckContentSchema', () => {
  it('accepts a minimal valid deck (1 slide with layout + blocks)', () => {
    const result = SlideDeckContentSchema.safeParse({
      slides: [
        { id: 's1', layout: 'title', blocks: [{ type: 'text', content: { text: 'Hello' } }] },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty slides array', () => {
    const result = SlideDeckContentSchema.safeParse({ slides: [] });
    expect(result.success).toBe(true);
  });

  it('accepts a slide with no blocks', () => {
    const result = SlideDeckContentSchema.safeParse({
      slides: [{ id: 's1', layout: 'blank', blocks: [] }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts multiple slides with different layouts and blocks', () => {
    const result = SlideDeckContentSchema.safeParse({
      slides: [
        { id: 's1', layout: 'title', blocks: [{ type: 'heading', content: { text: 'Title' } }] },
        { id: 's2', layout: 'content', blocks: [{ type: 'text', content: { text: 'Body' } }, { type: 'image', content: { url: 'https://example.com/x.png' } }] },
        { id: 's3', layout: 'split', blocks: [{ type: 'list', content: { items: ['a', 'b'] } }] },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing slides field entirely', () => {
    const result = SlideDeckContentSchema.safeParse({ notSlides: [] });
    expect(result.success).toBe(false);
  });

  it('rejects slides that are not an array', () => {
    const result = SlideDeckContentSchema.safeParse({ slides: {} });
    expect(result.success).toBe(false);
  });

  it('rejects a slide missing id', () => {
    const result = SlideDeckContentSchema.safeParse({
      slides: [{ layout: 'title', blocks: [] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a slide with an empty id', () => {
    const result = SlideDeckContentSchema.safeParse({
      slides: [{ id: '', layout: 'title', blocks: [] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a slide missing layout', () => {
    const result = SlideDeckContentSchema.safeParse({
      slides: [{ id: 's1', blocks: [] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a slide with an empty layout', () => {
    const result = SlideDeckContentSchema.safeParse({
      slides: [{ id: 's1', layout: '', blocks: [] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a slide missing blocks', () => {
    const result = SlideDeckContentSchema.safeParse({
      slides: [{ id: 's1', layout: 'title' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-array blocks', () => {
    const result = SlideDeckContentSchema.safeParse({
      slides: [{ id: 's1', layout: 'title', blocks: 'nope' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a block missing type', () => {
    const result = SlideDeckContentSchema.safeParse({
      slides: [{ id: 's1', layout: 'title', blocks: [{ content: { text: 'x' } }] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a block with an empty type', () => {
    const result = SlideDeckContentSchema.safeParse({
      slides: [{ id: 's1', layout: 'title', blocks: [{ type: '', content: {} }] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a block missing content', () => {
    const result = SlideDeckContentSchema.safeParse({
      slides: [{ id: 's1', layout: 'title', blocks: [{ type: 'text' }] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate slide ids', () => {
    const result = SlideDeckContentSchema.safeParse({
      slides: [
        { id: 's1', layout: 'title', blocks: [] },
        { id: 's1', layout: 'content', blocks: [] },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects document content under the slide_deck type', () => {
    const result = SlideDeckContentSchema.safeParse({ format: 'markdown', body: '# nope' });
    expect(result.success).toBe(false);
  });

  it('preserves every slide and block on a successful parse', () => {
    const content = {
      slides: [
        { id: 's1', layout: 'title', blocks: [{ type: 'heading', content: { text: 'Hi' } }] },
        { id: 's2', layout: 'content', blocks: [{ type: 'text', content: { text: 'World' } }] },
      ],
    };
    const result = SlideDeckContentSchema.safeParse(content);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.slides).toHaveLength(2);
      expect(result.data).toEqual(content);
    }
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

  it('validates board content against the board schema', () => {
    const result = validateArtifactContent('board', {
      columns: [{ id: 'col1', title: 'Todo' }],
      cards: [{ id: 'card1', columnId: 'col1', title: 'A', order: 0 }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects board content with an orphan card', () => {
    const result = validateArtifactContent('board', {
      columns: [{ id: 'col1', title: 'Todo' }],
      cards: [{ id: 'card1', columnId: 'missing', title: 'A', order: 0 }],
    });
    expect(result.success).toBe(false);
  });

  it('validates slide_deck content against the slide_deck schema', () => {
    const result = validateArtifactContent('slide_deck', {
      slides: [{ id: 's1', layout: 'title', blocks: [{ type: 'text', content: { text: 'Hi' } }] }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects slide_deck content with duplicate slide ids', () => {
    const result = validateArtifactContent('slide_deck', {
      slides: [
        { id: 's1', layout: 'title', blocks: [] },
        { id: 's1', layout: 'content', blocks: [] },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid slide_deck content (missing slides)', () => {
    const result = validateArtifactContent('slide_deck', { foo: 1 });
    expect(result.success).toBe(false);
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
