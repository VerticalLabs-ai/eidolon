import { describe, expect, it } from 'vitest';
import {
  validateEvidenceDocument,
  canonicalizeEvidenceDocument,
  isCitationBearingArtifactType,
  EVIDENCE_DOCUMENT_SCHEMA_VERSION,
  type EvidenceDocumentV1,
  type EvidenceBlock,
  type TextSpan,
} from '../services/mission/research/evidence-document-schema.js';

/**
 * VAL-RES-114: Evidence artifacts use one closed schema and scoped read API.
 *
 * Phase 1 citation-bearing content is `EvidenceDocumentV1`: ordered heading,
 * paragraph, list, table, quote, and code blocks containing text spans and
 * inline citation marks `{citationId}` only; scripts, raw HTML, embeds,
 * style, unknown nodes/marks, and dangling IDs are rejected. Canonical
 * serialization preserves block/span order with sorted object keys.
 * Unsupported artifact types cannot receive inline citations.
 */

const CITE = 'cit-1';

function doc(blocks: EvidenceBlock[]): EvidenceDocumentV1 {
  return {
    schemaVersion: EVIDENCE_DOCUMENT_SCHEMA_VERSION,
    blocks,
  };
}

describe('VAL-RES-114: EvidenceDocumentV1 closed schema', () => {
  describe('supported block types', () => {
    it('accepts a document with heading, paragraph, list, table, quote, code blocks', () => {
      const d = doc([
        { type: 'heading', level: 1, spans: [{ type: 'text', text: 'Title' }] },
        {
          type: 'paragraph',
          spans: [
            { type: 'text', text: 'Body ' },
            { type: 'citation', citationId: CITE },
          ],
        },
        { type: 'list', ordered: false, items: [[{ type: 'text', text: 'item' }]] },
        {
          type: 'table',
          rows: [[{ type: 'text', text: 'A' }], [{ type: 'text', text: 'B' }]],
        },
        { type: 'quote', spans: [{ type: 'text', text: 'quoted' }] },
        { type: 'code', language: 'ts', text: 'const x = 1;' },
      ]);
      const r = validateEvidenceDocument(d);
      expect(r.valid).toBe(true);
      expect(r.errors).toEqual([]);
    });

    it('rejects an unknown block type', () => {
      const r = validateEvidenceDocument(
        doc([{ type: 'video', spans: [] } as unknown as EvidenceBlock]),
      );
      expect(r.valid).toBe(false);
      expect(r.errors.join(' ')).toMatch(/unknown.*block.*type|unsupported.*block/i);
    });

    it('rejects a block missing its type', () => {
      const r = validateEvidenceDocument(doc([{} as unknown as EvidenceBlock]));
      expect(r.valid).toBe(false);
    });
  });

  describe('text spans and citation marks', () => {
    it('accepts text and citation spans in reading order', () => {
      const r = validateEvidenceDocument(
        doc([
          {
            type: 'paragraph',
            spans: [
              { type: 'text', text: 'Claim ' },
              { type: 'citation', citationId: CITE },
              { type: 'text', text: ' continues.' },
            ],
          },
        ]),
      );
      expect(r.valid).toBe(true);
    });

    it('rejects an unknown span/mark type', () => {
      const r = validateEvidenceDocument(
        doc([
          {
            type: 'paragraph',
            spans: [{ type: 'link', href: 'https://evil' } as unknown as TextSpan],
          },
        ]),
      );
      expect(r.valid).toBe(false);
      expect(r.errors.join(' ')).toMatch(/unknown.*span|unsupported.*mark|span.*type/i);
    });

    it('rejects a citation mark missing its citationId', () => {
      const r = validateEvidenceDocument(
        doc([
          {
            type: 'paragraph',
            spans: [{ type: 'citation' } as unknown as TextSpan],
          },
        ]),
      );
      expect(r.valid).toBe(false);
      expect(r.errors.join(' ')).toMatch(/citationId|citation.*id/i);
    });

    it('rejects a citation mark with an empty citationId', () => {
      const r = validateEvidenceDocument(
        doc([
          {
            type: 'paragraph',
            spans: [{ type: 'citation', citationId: '' }],
          },
        ]),
      );
      expect(r.valid).toBe(false);
    });
  });

  describe('rejected hostile content', () => {
    it('rejects a block carrying a script/html/style/embed payload', () => {
      const r = validateEvidenceDocument(
        doc([
          {
            type: 'paragraph',
            spans: [{ type: 'text', text: 'ok' }],
            html: '<script>alert(1)</script>',
          } as unknown as EvidenceBlock,
        ]),
      );
      expect(r.valid).toBe(false);
      expect(r.errors.join(' ')).toMatch(/html|script|embed|style|unexpected/i);
    });

    it('rejects a text span carrying extra dangerous attributes', () => {
      const r = validateEvidenceDocument(
        doc([
          {
            type: 'paragraph',
            spans: [{ type: 'text', text: 'ok', onClick: 'evil()' } as unknown as TextSpan],
          },
        ]),
      );
      expect(r.valid).toBe(false);
    });
  });

  describe('dangling citation IDs', () => {
    it('rejects a citation mark referencing an id not in the declared set', () => {
      const r = validateEvidenceDocument(
        doc([
          { type: 'heading', level: 1, spans: [{ type: 'text', text: 'T' }] },
          {
            type: 'paragraph',
            spans: [{ type: 'citation', citationId: 'missing' }],
          },
        ]),
        { declaredCitationIds: new Set([CITE]) },
      );
      expect(r.valid).toBe(false);
      expect(r.errors.join(' ')).toMatch(/dangling|declared|unknown.*citation/i);
    });

    it('accepts when all citation marks reference declared ids', () => {
      const r = validateEvidenceDocument(
        doc([
          {
            type: 'paragraph',
            spans: [{ type: 'citation', citationId: CITE }],
          },
        ]),
        { declaredCitationIds: new Set([CITE]) },
      );
      expect(r.valid).toBe(true);
    });
  });

  describe('schema version', () => {
    it('rejects a document with the wrong schemaVersion', () => {
      const r = validateEvidenceDocument({
        schemaVersion: 999,
        blocks: [{ type: 'paragraph', spans: [{ type: 'text', text: 'x' }] }],
      } as unknown as EvidenceDocumentV1);
      expect(r.valid).toBe(false);
      expect(r.errors.join(' ')).toMatch(/schemaVersion|version/i);
    });
  });

  describe('canonical serialization', () => {
    it('preserves block and span order while sorting object keys', () => {
      const d = doc([
        {
          type: 'paragraph',
          spans: [
            { type: 'text', text: 'b' },
            { type: 'citation', citationId: CITE },
          ],
        },
        { type: 'code', language: 'ts', text: 'x' },
      ]);
      const canon = canonicalizeEvidenceDocument(d);
      // Keys are sorted within each object, but arrays preserve order.
      const parsed = JSON.parse(canon) as { blocks: Array<Record<string, unknown>> };
      expect(parsed.blocks[0].spans).toBeInstanceOf(Array);
      const spans0 = parsed.blocks[0].spans as unknown[];
      expect(spans0[0]).toMatchObject({ type: 'text', text: 'b' });
      expect(spans0[1]).toMatchObject({ type: 'citation', citationId: CITE });
      expect(parsed.blocks[1]).toMatchObject({ type: 'code', text: 'x' });
      // Deterministic: same input → same bytes.
      expect(canonicalizeEvidenceDocument(d)).toBe(canon);
    });

    it('produces stable bytes regardless of input key insertion order', () => {
      const a: EvidenceDocumentV1 = {
        schemaVersion: EVIDENCE_DOCUMENT_SCHEMA_VERSION,
        blocks: [{ type: 'code', language: 'ts', text: 'x' }],
      };
      const b: EvidenceDocumentV1 = {
        blocks: [{ type: 'code', text: 'x', language: 'ts' }],
        schemaVersion: EVIDENCE_DOCUMENT_SCHEMA_VERSION,
      };
      expect(canonicalizeEvidenceDocument(a)).toBe(canonicalizeEvidenceDocument(b));
    });
  });

  describe('citation-bearing artifact types', () => {
    it('reports document as citation-bearing', () => {
      expect(isCitationBearingArtifactType('document')).toBe(true);
    });

    it('reports sheet/board/slide_deck/timeline/gallery/dashboard/app/code as non-citation-bearing', () => {
      for (const t of [
        'sheet',
        'board',
        'slide_deck',
        'timeline',
        'gallery',
        'dashboard',
        'app',
        'code',
      ]) {
        expect(isCitationBearingArtifactType(t as never)).toBe(false);
      }
    });

    it('rejects an unknown artifact type string', () => {
      expect(isCitationBearingArtifactType('notebook' as never)).toBe(false);
    });
  });
});
