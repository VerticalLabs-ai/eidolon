import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  buildExportFilename,
  exportToMarkdown,
  exportToHtml,
  type ExportCitation,
} from '../services/mission/research/export-service.js';
import {
  EVIDENCE_DOCUMENT_SCHEMA_VERSION,
  type EvidenceDocumentV1,
} from '../services/mission/research/evidence-document-schema.js';

/**
 * Exact-revision citation exports: Markdown and sanitized HTML.
 *
 * (VAL-RES-039, VAL-RES-040, VAL-RES-101, VAL-RES-102)
 *
 * The pure export renderer pins output to the exact supplied revision
 * content and citation set. It preserves stable citation ordinals, source
 * labels, canonical links, and bound source list, and excludes credentials,
 * raw payload/HTML, hidden prompts, restricted content beyond citation
 * quotes, diagnostics, and unnecessary internal IDs. HTML is inert: no
 * scripts, event attributes, active embeds, or credential URLs.
 */

// --- Fixtures ----------------------------------------------------------------

const doc: EvidenceDocumentV1 = {
  schemaVersion: EVIDENCE_DOCUMENT_SCHEMA_VERSION,
  blocks: [
    {
      type: 'heading',
      level: 1,
      spans: [{ type: 'text', text: 'Research Summary' }],
    },
    {
      type: 'paragraph',
      spans: [
        { type: 'text', text: 'The quick brown fox jumps over the lazy dog' },
        { type: 'citation', citationId: 'cite-a' },
        { type: 'text', text: '.' },
      ],
    },
    {
      type: 'quote',
      spans: [
        { type: 'text', text: 'A second cited claim' },
        { type: 'citation', citationId: 'cite-b' },
      ],
    },
    {
      type: 'code',
      language: 'ts',
      text: 'const x = 1;',
    },
  ],
};

const citations: ExportCitation[] = [
  {
    citationId: 'cite-a',
    ordinal: 1,
    quote: 'The quick brown fox jumps over the lazy dog.',
    frozenTitle: 'Canine Velocity',
    frozenAuthor: 'Jane Doe',
    canonicalUrl: 'https://example.com/canine',
    frozenRetrievedAt: '2026-08-24T12:00:00.000Z',
    frozenProvider: 'tavily',
  },
  {
    citationId: 'cite-b',
    ordinal: 2,
    quote: 'A second cited claim.',
    frozenTitle: 'Second Source',
    canonicalUrl: 'https://example.com/second',
    frozenRetrievedAt: '2026-08-24T12:30:00.000Z',
    frozenProvider: 'firecrawl',
  },
];

// --- Filename (VAL-RES-101: <sanitized-title>-v<version>.<ext>) -------------

describe('buildExportFilename', () => {
  it('sanitizes a title into a slug with version and extension', () => {
    expect(buildExportFilename('Canine Velocity!', 3, 'markdown')).toBe('canine-velocity-v3.md');
    expect(buildExportFilename('Canine Velocity!', 3, 'html')).toBe('canine-velocity-v3.html');
  });

  it('collapses non-alphanumeric runs into single hyphens and lowercases', () => {
    expect(buildExportFilename('  A   B/C--D  ', 1, 'markdown')).toBe('a-b-c-d-v1.md');
  });

  it('falls back to a default slug when the title is empty or non-alphanumeric', () => {
    expect(buildExportFilename('', 2, 'markdown')).toBe('artifact-v2.md');
    expect(buildExportFilename('!!!', 2, 'html')).toBe('artifact-v2.html');
  });
});

// --- Markdown export (VAL-RES-039, VAL-RES-101) -----------------------------

describe('exportToMarkdown', () => {
  const md = exportToMarkdown(doc, citations, { title: 'Canine Velocity', version: 3 });

  it('produces deterministic UTF-8 bytes for the exact revision', () => {
    const hash = createHash('sha256').update(md, 'utf8').digest('hex');
    // Re-rendering identical inputs produces identical bytes (stable export).
    expect(
      createHash('sha256')
        .update(exportToMarkdown(doc, citations, { title: 'Canine Velocity', version: 3 }), 'utf8')
        .digest('hex'),
    ).toBe(hash);
  });

  it('renders heading and paragraph text with inline citation ordinals', () => {
    expect(md).toContain('# Research Summary');
    expect(md).toContain('The quick brown fox jumps over the lazy dog[1].');
  });

  it('renders a quote block and a fenced code block', () => {
    expect(md).toContain('> A second cited claim[2]');
    expect(md).toContain('```ts\nconst x = 1;\n```');
  });

  it('preserves stable citation ordinals and source labels in a bound source list', () => {
    expect(md).toContain('## Sources');
    expect(md).toContain('1. Canine Velocity — Jane Doe');
    expect(md).toContain('https://example.com/canine');
    expect(md).toContain('2. Second Source');
    expect(md).toContain('https://example.com/second');
  });

  it('includes the exact citation quote', () => {
    expect(md).toContain('The quick brown fox jumps over the lazy dog.');
  });

  it('excludes internal IDs, credentials, diagnostics, and restricted internals', () => {
    // No citation row IDs, source revision IDs, run IDs, provider request
    // hashes, policy hashes, or provider metadata beyond the public label.
    expect(md).not.toContain('cite-a');
    expect(md).not.toContain('cite-b');
    expect(md).not.toContain('tavily');
    expect(md).not.toContain('firecrawl');
    expect(md).not.toContain('credential');
    expect(md).not.toContain('diagnostic');
  });
});

// --- HTML export (VAL-RES-039, VAL-RES-040, VAL-RES-102) --------------------

describe('exportToHtml', () => {
  const html = exportToHtml(doc, citations, { title: 'Canine Velocity', version: 3 });

  it('wraps content in a minimal inert HTML document', () => {
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html');
    expect(html).toContain('<title>Canine Velocity</title>');
  });

  it('renders headings, paragraphs, and citation marks as superscript anchors', () => {
    expect(html).toContain('<h1>Research Summary</h1>');
    expect(html).toContain(
      'The quick brown fox jumps over the lazy dog<sup><a href="#cite-1">1</a></sup>.',
    );
  });

  it('renders a bound source list with stable ordinals and canonical links', () => {
    expect(html).toContain('<h2>Sources</h2>');
    expect(html).toContain('id="cite-1"');
    expect(html).toContain('id="cite-2"');
    expect(html).toContain('href="https://example.com/canine"');
    expect(html).toContain('Canine Velocity');
    expect(html).toContain('Jane Doe');
  });

  it('contains no script, event attribute, active embed, or style tag', () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/<iframe/i);
    expect(html).not.toMatch(/<embed/i);
    expect(html).not.toMatch(/<object/i);
    expect(html).not.toMatch(/on\w+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
  });

  it('escapes untrusted text so raw HTML in content cannot break out', () => {
    const hostile: EvidenceDocumentV1 = {
      schemaVersion: EVIDENCE_DOCUMENT_SCHEMA_VERSION,
      blocks: [
        {
          type: 'paragraph',
          spans: [{ type: 'text', text: '<script>alert(1)</script><img src=x onerror=alert(1)>' }],
        },
      ],
    };
    const out = exportToHtml(hostile, [], { title: 'T', version: 1 });
    // Raw tags are escaped — no unescaped <script> or <img> element exists.
    expect(out).not.toMatch(/<script>/i);
    expect(out).not.toMatch(/<img[\s>]/i);
    // The literal markup is rendered as inert escaped text.
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('&lt;img');
  });

  it('excludes internal IDs, credentials, and provider internals', () => {
    expect(html).not.toContain('cite-a');
    expect(html).not.toContain('cite-b');
    expect(html).not.toContain('tavily');
    expect(html).not.toContain('firecrawl');
  });
});

// --- Exact-revision pinning (VAL-RES-039: never floats to latest) -----------

describe('exact-revision pinning', () => {
  it('output is unchanged when a newer citation set is supplied elsewhere', () => {
    const v3 = exportToMarkdown(doc, citations, { title: 'Canine Velocity', version: 3 });
    // A "newer edit" would supply a different doc/citation set for v4; the
    // v3 export must remain bound to the v3 inputs.
    const newerDoc: EvidenceDocumentV1 = {
      schemaVersion: EVIDENCE_DOCUMENT_SCHEMA_VERSION,
      blocks: [{ type: 'heading', level: 1, spans: [{ type: 'text', text: 'Updated' }] }],
    };
    const newerCitations: ExportCitation[] = [
      {
        citationId: 'cite-c',
        ordinal: 1,
        quote: 'New quote.',
        frozenTitle: 'New',
        canonicalUrl: 'https://example.com/new',
        frozenRetrievedAt: '2026-08-25T00:00:00.000Z',
        frozenProvider: 'tavily',
      },
    ];
    const v4 = exportToMarkdown(newerDoc, newerCitations, { title: 'Canine Velocity', version: 4 });
    // Re-exporting v3 with the original v3 inputs is byte-identical.
    expect(exportToMarkdown(doc, citations, { title: 'Canine Velocity', version: 3 })).toBe(v3);
    expect(v4).not.toBe(v3);
  });
});
