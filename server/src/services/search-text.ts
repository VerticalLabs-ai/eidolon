// ---------------------------------------------------------------------------
// Search text extraction (M1 — Cross-Artifact Search)
// ---------------------------------------------------------------------------
//
// Artifact `content` is encrypted at rest, so a SQL `GENERATED` tsvector column
// over `content` would index ciphertext. The application layer instead
// decrypts the content (already done by the artifact service before calling
// here) and extracts a flat plaintext string per artifact type. That string
// feeds two app-maintained columns on `artifacts`:
//
//   • `search_text` — `${title} ${contentText}`, used by `ts_headline` to
//                     produce original-case context snippets.
//   • `search_tsv`  — `setweight(to_tsvector('english', title), 'A') ||
//                     setweight(to_tsvector('english', contentText), 'B')`,
//                     used for FTS matching + `ts_rank` ranking + GIN index.
//
// Extraction is per-type and mirrors the content Zod schemas in
// `packages/shared/src/types/artifact.ts`:
//   document   → content.body (markdown string or delta block text)
//   sheet     → content.rows[].cells[].value
//   board     → content.cards[].title
//   slide_deck→ content.slides[].blocks[].content (string fields)
//   timeline  → content.tasks[].title
//   gallery   → content.items[].caption
//   dashboard → content.widgets[].config (string fields)
//   app       → content.files[].content
//   code      → content.files[].content
// ---------------------------------------------------------------------------

import { sql } from 'drizzle-orm';
import { ArtifactTypeSchema } from '@eidolon/shared';
import type { z } from 'zod';

type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

/** Recursively collect string values from an unknown JSON-ish value. */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    if (value.trim().length > 0) out.push(value);
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    out.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStrings(v, out);
    }
  }
}

/** Extract a flat plaintext string from a document content body. */
function documentBodyText(body: unknown): string {
  if (typeof body === 'string') return body;
  if (Array.isArray(body)) {
    const out: string[] = [];
    collectStrings(body, out);
    return out.join(' ');
  }
  return '';
}

/**
 * Extract searchable plaintext from a DECRYPTED artifact content object.
 * Returns a space-joined string of the type's text-bearing fields. Returns
 * an empty string for unrecognized shapes (search degrades gracefully — the
 * title still indexes via the tsvector weight A).
 */
export function extractSearchText(type: ArtifactType, content: Record<string, unknown>): string {
  const parts: string[] = [];
  switch (type) {
    case 'document': {
      const body = content.body;
      parts.push(documentBodyText(body));
      break;
    }
    case 'sheet': {
      const rows = content.rows;
      if (Array.isArray(rows)) {
        for (const row of rows) {
          const cells = (row as Record<string, unknown>)?.cells;
          if (cells && typeof cells === 'object') {
            for (const cell of Object.values(cells as Record<string, unknown>)) {
              const value = (cell as Record<string, unknown> | null)?.value;
              if (typeof value === 'string' && value.trim().length > 0) parts.push(value);
              else if (typeof value === 'number' || typeof value === 'boolean') parts.push(String(value));
            }
          }
        }
      }
      break;
    }
    case 'board': {
      const cards = content.cards;
      if (Array.isArray(cards)) {
        for (const card of cards) {
          const title = (card as Record<string, unknown> | null)?.title;
          if (typeof title === 'string' && title.trim().length > 0) parts.push(title);
        }
      }
      break;
    }
    case 'slide_deck': {
      const slides = content.slides;
      if (Array.isArray(slides)) {
        for (const slide of slides) {
          const blocks = (slide as Record<string, unknown> | null)?.blocks;
          if (Array.isArray(blocks)) {
            for (const block of blocks) {
              const blockContent = (block as Record<string, unknown> | null)?.content;
              collectStrings(blockContent, parts);
            }
          }
        }
      }
      break;
    }
    case 'timeline': {
      const tasks = content.tasks;
      if (Array.isArray(tasks)) {
        for (const task of tasks) {
          const title = (task as Record<string, unknown> | null)?.title;
          if (typeof title === 'string' && title.trim().length > 0) parts.push(title);
        }
      }
      break;
    }
    case 'gallery': {
      const items = content.items;
      if (Array.isArray(items)) {
        for (const item of items) {
          const caption = (item as Record<string, unknown> | null)?.caption;
          if (typeof caption === 'string' && caption.trim().length > 0) parts.push(caption);
        }
      }
      break;
    }
    case 'dashboard': {
      const widgets = content.widgets;
      if (Array.isArray(widgets)) {
        for (const widget of widgets) {
          const config = (widget as Record<string, unknown> | null)?.config;
          collectStrings(config, parts);
        }
      }
      break;
    }
    case 'app':
    case 'code': {
      const files = content.files;
      if (Array.isArray(files)) {
        for (const file of files) {
          const fileContent = (file as Record<string, unknown> | null)?.content;
          if (typeof fileContent === 'string') parts.push(fileContent);
        }
      }
      break;
    }
    default: {
      // Unknown type: degrade gracefully, index nothing from content.
      break;
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Build the `search_text` column value (title + extracted content text).
 * Used for `ts_headline` snippet generation at query time.
 */
export function buildSearchText(title: string, contentText: string): string {
  return `${title}\n${contentText}`.replace(/\s+/g, ' ').trim();
}

/**
 * Drizzle SQL expression that builds the `search_tsv` tsvector from a title
 * (weight A) and extracted content text (weight B). The values are bound as
 * parameters (safe against injection). Used in INSERT/UPDATE `.values()` /
 * `.set()` for the `searchTsv` column.
 */
export function buildSearchTsvSql(title: string, contentText: string) {
  return sql`setweight(to_tsvector('english', ${title}), 'A') || setweight(to_tsvector('english', ${contentText}), 'B')`;
}
