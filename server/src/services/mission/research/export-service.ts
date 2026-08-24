/**
 * Exact-revision citation exports: Markdown and sanitized HTML.
 *
 * (VAL-RES-039, VAL-RES-040, VAL-RES-101, VAL-RES-102)
 *
 * Renders a pinned `EvidenceDocumentV1` revision together with its bound
 * citation set into a deterministic Markdown document or a sanitized,
 * inert HTML document. Output preserves stable citation ordinals, source
 * labels (frozen title/author), canonical HTTPS links, and the bound source
 * list, and never floats to a newer revision — the caller supplies the
 * exact revision content and citation rows.
 *
 * Excluded from every format (VAL-RES-040):
 *  - credentials and secrets;
 *  - raw provider payload/HTML;
 *  - hidden prompts;
 *  - restricted content beyond the citation quote;
 *  - diagnostics (provider request id hashes, policy hashes, etc.);
 *  - unnecessary internal IDs (citation row IDs, source revision IDs, run
 *    IDs, artifact revision IDs).
 *
 * HTML is inert (VAL-RES-102, VAL-RES-040): no `<script>`, `<style>`,
 * `<iframe>`, `<embed>`, `<object>`, form controls, event-handler
 * attributes, `javascript:` URLs, or credential URLs. All text is escaped;
 * the only attribute emitted is `href` on anchor tags, restricted to the
 * canonical HTTPS source URL.
 *
 * This module is pure: it contains no side effects and no persistence. It
 * is the single source of truth for export rendering and sanitization.
 */

import {
  EVIDENCE_DOCUMENT_SCHEMA_VERSION,
  type EvidenceDocumentV1,
  type EvidenceBlock,
  type TextSpan,
} from './evidence-document-schema.js';

// ---------------------------------------------------------------------------
// Export citation view
// ---------------------------------------------------------------------------

/**
 * A citation prepared for export. `citationId` is used only to map inline
 * citation marks to ordinals; it never appears in the rendered output
 * (VAL-RES-040: exclude unnecessary internal IDs).
 */
export interface ExportCitation {
  citationId: string;
  ordinal: number;
  quote: string;
  frozenTitle?: string;
  frozenAuthor?: string;
  canonicalUrl: string;
  frozenRetrievedAt: string;
  frozenProvider: string;
  section?: string;
}

export interface ExportOptions {
  title: string;
  version: number;
}

// ---------------------------------------------------------------------------
// Filename (VAL-RES-101: <sanitized-title>-v<version>.<ext>)
// ---------------------------------------------------------------------------

/**
 * Sanitize an artifact title into a safe filename slug: lowercase, collapse
 * non-alphanumeric runs into single hyphens, trim leading/trailing hyphens.
 * Falls back to `artifact` when the result is empty.
 */
export function sanitizeTitleForFilename(title: string): string {
  const slug = title
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'artifact';
}

/**
 * Build the attachment filename for an export: `<sanitized-title>-v<version>.<ext>`.
 */
export function buildExportFilename(
  title: string,
  version: number,
  format: 'markdown' | 'html',
): string {
  const slug = sanitizeTitleForFilename(title);
  const ext = format === 'markdown' ? 'md' : 'html';
  return `${slug}-v${version}.${ext}`;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Map citationId → ordinal for inline mark resolution. */
function ordinalMap(citations: ExportCitation[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of citations) {
    m.set(c.citationId, c.ordinal);
  }
  return m;
}

/**
 * Coerce an unknown content value into a safe `EvidenceDocumentV1`-shaped
 * object for rendering. If the value is not a valid evidence document
 * (e.g., a non-document artifact type with no blocks), an empty-block
 * document is returned so the renderer never crashes and the bound source
 * list still renders. Only the closed block/span shapes are iterated;
 * unknown keys are ignored.
 */
function normalizeDoc(doc: unknown): EvidenceDocumentV1 {
  if (doc && typeof doc === 'object' && Array.isArray((doc as { blocks?: unknown }).blocks)) {
    return {
      schemaVersion: EVIDENCE_DOCUMENT_SCHEMA_VERSION,
      blocks: (doc as { blocks: EvidenceBlock[] }).blocks,
    };
  }
  return { schemaVersion: EVIDENCE_DOCUMENT_SCHEMA_VERSION, blocks: [] };
}

/** Format an ISO retrieved-at timestamp as a stable `YYYY-MM-DD` date. */
function formatDate(iso: string): string {
  // The frozen retrieved-at is a full ISO timestamp. Render only the date
  // portion for the public source list (no time/zone internals).
  const datePart = iso.split('T')[0] ?? iso;
  return datePart;
}

/** Build the public source label: "Title — Author" or whichever exists. */
function sourceLabel(c: ExportCitation): string {
  const parts: string[] = [];
  if (c.frozenTitle) {
    parts.push(c.frozenTitle);
  }
  if (c.frozenAuthor) {
    parts.push(c.frozenAuthor);
  }
  return parts.join(' — ');
}

// ---------------------------------------------------------------------------
// Markdown export
// ---------------------------------------------------------------------------

/**
 * Render the exact revision as a deterministic Markdown document with
 * inline citation ordinals and a bound source list.
 */
export function exportToMarkdown(
  doc: EvidenceDocumentV1 | Record<string, unknown>,
  citations: ExportCitation[],
  options: ExportOptions,
): string {
  const evidence = normalizeDoc(doc);
  const ordinals = ordinalMap(citations);
  const lines: string[] = [];

  // Revision-identity header (VAL-RES-039): bind the export to the exact
  // requested revision so the document is self-identifying and never floats
  // to latest. Rendered as an inert HTML comment so it does not alter the
  // visible document structure. Strip `>` so a `-->` sequence in the title
  // cannot close the comment early and inject markdown.
  const safeTitle = options.title.replace(/>/g, '');
  lines.push(`<!-- Exported revision v${options.version}: ${safeTitle} -->`);
  lines.push('');

  for (const block of evidence.blocks) {
    lines.push(renderMarkdownBlock(block, ordinals));
    lines.push('');
  }

  // Bound source list (stable ordinals, source labels, canonical links,
  // and the exact citation quote).
  const sorted = [...citations].sort((a, b) => a.ordinal - b.ordinal);
  if (sorted.length > 0) {
    lines.push('## Sources');
    lines.push('');
    for (const c of sorted) {
      const label = sourceLabel(c);
      const head = label.length > 0 ? `${c.ordinal}. ${label}` : `${c.ordinal}. Source`;
      lines.push(head);
      lines.push(`   ${c.canonicalUrl}`);
      lines.push(`   Retrieved ${formatDate(c.frozenRetrievedAt)}.`);
      lines.push(`   > ${c.quote}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

function renderMarkdownBlock(block: EvidenceBlock, ordinals: Map<string, number>): string {
  switch (block.type) {
    case 'heading': {
      const prefix = '#'.repeat(Math.min(Math.max(block.level, 1), 6));
      return `${prefix} ${renderMarkdownSpans(block.spans, ordinals)}`;
    }
    case 'paragraph':
      return renderMarkdownSpans(block.spans, ordinals);
    case 'quote':
      return `> ${renderMarkdownSpans(block.spans, ordinals)}`;
    case 'code': {
      const lang = block.language ?? '';
      return '```' + lang + '\n' + block.text + '\n```';
    }
    case 'list': {
      return block.items
        .map((item, i) => {
          const prefix = block.ordered ? `${i + 1}. ` : '- ';
          return prefix + renderMarkdownSpans(item, ordinals);
        })
        .join('\n');
    }
    case 'table': {
      // Minimal markdown table: header row + separator + body rows. Each
      // row is an array of single-span cells; each cell is rendered as
      // inline text.
      const rows = block.rows;
      if (rows.length === 0) {
        return '';
      }
      const header = rows[0].map((cell) => renderMarkdownSpans([cell], ordinals)).join(' | ');
      const separator = rows[0].map(() => '---').join(' | ');
      const body = rows
        .slice(1)
        .map((row) => row.map((cell) => renderMarkdownSpans([cell], ordinals)).join(' | '))
        .join('\n');
      return [header, separator, body].filter(Boolean).join('\n');
    }
  }
}

function renderMarkdownSpans(spans: TextSpan[], ordinals: Map<string, number>): string {
  return spans
    .map((span) => {
      if (span.type === 'text') {
        return span.text;
      }
      const ordinal = ordinals.get(span.citationId);
      return ordinal !== undefined ? `[${ordinal}]` : '';
    })
    .join('');
}

// ---------------------------------------------------------------------------
// HTML export (sanitized, inert)
// ---------------------------------------------------------------------------

/** Escape HTML-special characters in text content. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render the exact revision as a sanitized, inert HTML document with inline
 * citation marks as superscript anchors and a bound source list.
 */
export function exportToHtml(
  doc: EvidenceDocumentV1 | Record<string, unknown>,
  citations: ExportCitation[],
  options: ExportOptions,
): string {
  const evidence = normalizeDoc(doc);
  const ordinals = ordinalMap(citations);
  const body: string[] = [];

  for (const block of evidence.blocks) {
    body.push(renderHtmlBlock(block, ordinals));
  }

  const sorted = [...citations].sort((a, b) => a.ordinal - b.ordinal);
  if (sorted.length > 0) {
    body.push('<h2>Sources</h2>');
    body.push('<ol>');
    for (const c of sorted) {
      const label = sourceLabel(c);
      const labelHtml = label.length > 0 ? escapeHtml(label) : 'Source';
      const url = safeHref(c.canonicalUrl);
      const link =
        url !== null
          ? `<a href="${url}">${escapeHtml(c.canonicalUrl)}</a>`
          : escapeHtml(c.canonicalUrl);
      body.push(
        `<li id="cite-${c.ordinal}">${labelHtml}<br>${link}<br>Retrieved ${escapeHtml(formatDate(c.frozenRetrievedAt))}.<br><blockquote>${escapeHtml(c.quote)}</blockquote></li>`,
      );
    }
    body.push('</ol>');
  }

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(options.title)}</title>`,
    '</head>',
    '<body>',
    ...body,
    '</body>',
    '</html>',
  ].join('\n');
}

/**
 * Validate that an href is an absolute HTTPS URL with no credentials or
 * fragment. Returns the escaped href or null when the URL is not safe to
 * emit (VAL-RES-102, VAL-RES-040).
 */
function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') {
      return null;
    }
    if (u.username || u.password) {
      return null;
    }
    if (u.hash) {
      // Strip fragment for export links (defensive).
      u.hash = '';
    }
    return escapeHtml(u.toString());
  } catch {
    return null;
  }
}

function renderHtmlBlock(block: EvidenceBlock, ordinals: Map<string, number>): string {
  switch (block.type) {
    case 'heading': {
      const level = Math.min(Math.max(block.level, 1), 6);
      return `<h${level}>${renderHtmlSpans(block.spans, ordinals)}</h${level}>`;
    }
    case 'paragraph':
      return `<p>${renderHtmlSpans(block.spans, ordinals)}</p>`;
    case 'quote':
      return `<blockquote>${renderHtmlSpans(block.spans, ordinals)}</blockquote>`;
    case 'code':
      return `<pre><code>${escapeHtml(block.text)}</code></pre>`;
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      const items = block.items
        .map((item) => `<li>${renderHtmlSpans(item, ordinals)}</li>`)
        .join('');
      return `<${tag}>${items}</${tag}>`;
    }
    case 'table': {
      const rows = block.rows;
      if (rows.length === 0) {
        return '<table></table>';
      }
      const headerCells = rows[0]
        .map((cell) => `<th>${renderHtmlSpans([cell], ordinals)}</th>`)
        .join('');
      const bodyRows = rows
        .slice(1)
        .map(
          (row) =>
            `<tr>${row.map((cell) => `<td>${renderHtmlSpans([cell], ordinals)}</td>`).join('')}</tr>`,
        )
        .join('');
      return `<table><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table>`;
    }
  }
}

function renderHtmlSpans(spans: TextSpan[], ordinals: Map<string, number>): string {
  return spans
    .map((span) => {
      if (span.type === 'text') {
        return escapeHtml(span.text);
      }
      const ordinal = ordinals.get(span.citationId);
      if (ordinal === undefined) {
        return '';
      }
      return `<sup><a href="#cite-${ordinal}">${ordinal}</a></sup>`;
    })
    .join('');
}
