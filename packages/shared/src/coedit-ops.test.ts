import { describe, expect, it } from 'vitest';
import {
  isCoEditableType,
  COEDITABLE_TYPES,
  applyOp,
  diffContent,
} from './coedit-ops.js';

// ---------------------------------------------------------------------------
// isCoEditableType / COEDITABLE_TYPES
// ---------------------------------------------------------------------------

describe('isCoEditableType', () => {
  it('returns true for document, sheet, board (op-based co-editable)', () => {
    expect(isCoEditableType('document')).toBe(true);
    expect(isCoEditableType('sheet')).toBe(true);
    expect(isCoEditableType('board')).toBe(true);
  });

  it('returns false for M5 types (gallery, dashboard, app)', () => {
    expect(isCoEditableType('gallery')).toBe(false);
    expect(isCoEditableType('dashboard')).toBe(false);
    expect(isCoEditableType('app')).toBe(false);
  });

  it('returns false for other non-co-editable types', () => {
    expect(isCoEditableType('slide_deck')).toBe(false);
    expect(isCoEditableType('timeline')).toBe(false);
    expect(isCoEditableType('code')).toBe(false);
  });

  it('returns false for unknown types', () => {
    expect(isCoEditableType('bogus')).toBe(false);
    expect(isCoEditableType('')).toBe(false);
  });

  it('COEDITABLE_TYPES contains exactly document, sheet, board', () => {
    expect([...COEDITABLE_TYPES]).toEqual(['document', 'sheet', 'board']);
  });
});

// ---------------------------------------------------------------------------
// diffContent returns empty ops for non-co-editable types
// (documents the root cause that mergeExternalUpdate guards against)
// ---------------------------------------------------------------------------

describe('diffContent — non-co-editable types', () => {
  it('returns empty ops for gallery (no handler)', () => {
    const base = { items: [{ id: 'g1', type: 'image', url: 'https://example.com/a.png' }] };
    const target = { items: [{ id: 'g1', type: 'image', url: 'https://example.com/a.png', caption: 'cap' }, { id: 'g2', type: 'video', url: 'https://example.com/b.mp4' }] };
    expect(diffContent('gallery', base, target)).toEqual([]);
  });

  it('returns empty ops for dashboard (no handler)', () => {
    const base = { dataSources: [], widgets: [] };
    const target = { dataSources: [{ id: 'ds1', type: 'manual_json', config: { data: 1 } }], widgets: [{ id: 'w1', type: 'metric', dataSourceId: 'ds1', config: {} }] };
    expect(diffContent('dashboard', base, target)).toEqual([]);
  });

  it('returns empty ops for app (no handler)', () => {
    const base = { definition: { name: 'demo' }, files: [{ path: 'index.html', content: '<h1>Hi</h1>' }] };
    const target = { definition: { name: 'demo2' }, files: [{ path: 'index.html', content: '<h1>Updated</h1>' }, { path: 'style.css', content: 'body{}' }] };
    expect(diffContent('app', base, target)).toEqual([]);
  });

  it('applyOp is a no-op for non-co-editable types (returns content unchanged)', () => {
    const content = { items: [{ id: 'g1', type: 'image', url: 'u' }] };
    const op = { kind: 'doc.insert', position: 0, text: 'x', opId: 'o1' } as never;
    expect(applyOp('gallery', content, op)).toBe(content);
  });
});
