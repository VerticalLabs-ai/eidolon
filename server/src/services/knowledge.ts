// ---------------------------------------------------------------------------
// Knowledge Base Service -- Text chunking & keyword search for RAG
// ---------------------------------------------------------------------------

import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DbInstance } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KnowledgeDocument {
  id: string;
  companyId: string;
  title: string;
  content: string;
  contentType: string;
  source: string | null;
  sourceUrl: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  chunkCount: number;
  embeddingStatus: string;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface KnowledgeChunk {
  id: string;
  documentId: string;
  companyId: string;
  chunkIndex: number;
  content: string;
  tokenCount: number;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface SearchResult {
  chunk: KnowledgeChunk;
  score: number;
  documentTitle: string;
  documentId: string;
}

// ---------------------------------------------------------------------------
// Text Chunking
// ---------------------------------------------------------------------------

/**
 * Split text into overlapping chunks suitable for RAG retrieval.
 * Strategy: split by paragraphs, then combine until maxChunkSize is reached.
 * Overlap ensures context continuity between adjacent chunks.
 */
export function chunkText(text: string, maxChunkSize = 1500, overlap = 200): string[] {
  if (!text || text.trim().length === 0) return [];
  if (text.length <= maxChunkSize) return [text.trim()];

  // Split by double newlines (paragraphs) or single newlines as fallback
  const paragraphs = text.split(/\n\n+/).filter((p) => p.trim().length > 0);

  const chunks: string[] = [];
  let currentChunk = '';

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();

    // If a single paragraph exceeds maxChunkSize, split by sentences
    if (trimmed.length > maxChunkSize) {
      // Flush current chunk first
      if (currentChunk.trim().length > 0) {
        chunks.push(currentChunk.trim());
        // Carry overlap from end of current chunk
        currentChunk = currentChunk.trim().slice(-overlap);
      }

      // Split long paragraph by sentences
      const sentences = trimmed.match(/[^.!?]+[.!?]+\s*/g) || [trimmed];
      for (const sentence of sentences) {
        if ((currentChunk + sentence).length > maxChunkSize && currentChunk.trim().length > 0) {
          chunks.push(currentChunk.trim());
          currentChunk = currentChunk.trim().slice(-overlap) + ' ' + sentence;
        } else {
          currentChunk += sentence;
        }
      }
      continue;
    }

    // Check if adding this paragraph would exceed the limit
    const candidate = currentChunk.length > 0
      ? currentChunk + '\n\n' + trimmed
      : trimmed;

    if (candidate.length > maxChunkSize && currentChunk.trim().length > 0) {
      chunks.push(currentChunk.trim());
      // Start next chunk with overlap from end of previous
      const overlapText = currentChunk.trim().slice(-overlap);
      currentChunk = overlapText + '\n\n' + trimmed;
    } else {
      currentChunk = candidate;
    }
  }

  // Don't forget the last chunk
  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

/**
 * Estimate token count (rough approximation: ~4 chars per token).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Keyword Search (TF-IDF style, no embeddings needed)
// ---------------------------------------------------------------------------

/**
 * Tokenize text into lowercase keywords, removing stop words.
 */
function tokenize(text: string): string[] {
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
    'before', 'after', 'above', 'below', 'between', 'and', 'but', 'or',
    'not', 'no', 'nor', 'if', 'then', 'else', 'when', 'up', 'out',
    'this', 'that', 'these', 'those', 'it', 'its', 'he', 'she', 'they',
    'we', 'you', 'i', 'me', 'my', 'your', 'his', 'her', 'our', 'their',
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stopWords.has(w));
}

/**
 * Simple keyword-based search with TF-IDF style scoring.
 * No embeddings needed -- fast and effective for knowledge retrieval.
 */
export function searchKnowledge(
  chunks: Array<{ content: string; id: string; documentId: string }>,
  query: string,
  topK = 5,
): Array<{ chunk: (typeof chunks)[0]; score: number }> {
  if (!query.trim() || chunks.length === 0) return [];

  const queryTokens = tokenize(query);
  const queryLower = query.toLowerCase();

  if (queryTokens.length === 0) return [];

  const scored = chunks.map((chunk) => {
    const contentLower = chunk.content.toLowerCase();
    const contentTokens = tokenize(chunk.content);
    const totalWords = contentTokens.length || 1;

    // Term frequency scoring
    let tfScore = 0;
    for (const qt of queryTokens) {
      const count = contentTokens.filter((ct) => ct === qt).length;
      tfScore += count / totalWords;
    }

    // Exact phrase match boost (significant bonus)
    let phraseBoost = 0;
    if (queryLower.length > 3 && contentLower.includes(queryLower)) {
      phraseBoost = 2.0;
    }

    // Partial phrase boost (2+ word sequences)
    if (queryTokens.length >= 2) {
      for (let i = 0; i < queryTokens.length - 1; i++) {
        const bigram = queryTokens[i] + ' ' + queryTokens[i + 1];
        if (contentLower.includes(bigram)) {
          phraseBoost += 0.5;
        }
      }
    }

    // Coverage bonus: what fraction of query terms appear in the chunk
    const uniqueMatches = new Set(queryTokens.filter((qt) => contentTokens.includes(qt)));
    const coverageBonus = uniqueMatches.size / queryTokens.length;

    const score = tfScore + phraseBoost + coverageBonus * 0.5;

    return { chunk, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ---------------------------------------------------------------------------
// KnowledgeService
// ---------------------------------------------------------------------------

export class KnowledgeService {
  constructor(private db: DbInstance) {}

  /**
   * Add a document to the company knowledge base.
   * Automatically chunks the content and stores each chunk.
   */
  async addDocument(
    companyId: string,
    data: {
      title: string;
      content: string;
      contentType?: string;
      source?: string;
      sourceUrl?: string;
      tags?: string[];
      createdBy?: string;
    },
  ): Promise<KnowledgeDocument> {
    const { knowledgeDocuments, knowledgeChunks } = this.db.schema;
    const now = new Date();
    const docId = randomUUID();

    // Chunk the content
    const textChunks = chunkText(data.content);

    // Insert document
    const [doc] = await this.db.drizzle
      .insert(knowledgeDocuments)
      .values({
        id: docId,
        companyId,
        title: data.title,
        content: data.content,
        contentType: data.contentType ?? 'markdown',
        source: data.source ?? 'manual',
        sourceUrl: data.sourceUrl ?? null,
        tags: data.tags ?? [],
        metadata: {},
        chunkCount: textChunks.length,
        embeddingStatus: 'completed',
        createdBy: data.createdBy ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    // Insert chunks
    if (textChunks.length > 0) {
      await this.db.drizzle.insert(knowledgeChunks).values(
        textChunks.map((chunkContent, index) => ({
          id: randomUUID(),
          documentId: docId,
          companyId,
          chunkIndex: index,
          content: chunkContent,
          tokenCount: estimateTokens(chunkContent),
          metadata: {},
          createdAt: now,
        })),
      );
    }

    return doc as unknown as KnowledgeDocument;
  }

  /**
   * Update a document's content and re-chunk.
   */
  async updateDocument(
    documentId: string,
    companyId: string,
    data: { title?: string; content?: string; tags?: string[] },
  ): Promise<KnowledgeDocument> {
    const { knowledgeDocuments, knowledgeChunks } = this.db.schema;

    const [existing] = await this.db.drizzle
      .select()
      .from(knowledgeDocuments)
      .where(
        and(
          eq(knowledgeDocuments.id, documentId),
          eq(knowledgeDocuments.companyId, companyId),
        ),
      )
      .limit(1);

    if (!existing) {
      throw new Error(`Document ${documentId} not found`);
    }

    const now = new Date();
    const updates: Record<string, unknown> = { updatedAt: now };

    if (data.title !== undefined) updates.title = data.title;
    if (data.tags !== undefined) updates.tags = data.tags;

    // If content changed, re-chunk
    if (data.content !== undefined) {
      updates.content = data.content;

      // Delete old chunks
      await this.db.drizzle
        .delete(knowledgeChunks)
        .where(eq(knowledgeChunks.documentId, documentId));

      // Create new chunks
      const textChunks = chunkText(data.content);
      updates.chunkCount = textChunks.length;

      if (textChunks.length > 0) {
        await this.db.drizzle.insert(knowledgeChunks).values(
          textChunks.map((chunkContent, index) => ({
            id: randomUUID(),
            documentId,
            companyId,
            chunkIndex: index,
            content: chunkContent,
            tokenCount: estimateTokens(chunkContent),
            metadata: {},
            createdAt: now,
          })),
        );
      }
    }

    const [updated] = await this.db.drizzle
      .update(knowledgeDocuments)
      .set(updates)
      .where(eq(knowledgeDocuments.id, documentId))
      .returning();

    return updated as unknown as KnowledgeDocument;
  }

  /**
   * Search the company's knowledge base using keyword search.
   */
  async searchCompanyKnowledge(
    companyId: string,
    query: string,
    topK = 5,
  ): Promise<SearchResult[]> {
    const { knowledgeChunks, knowledgeDocuments } = this.db.schema;

    // Load all chunks for this company
    const chunks = await this.db.drizzle
      .select({
        id: knowledgeChunks.id,
        documentId: knowledgeChunks.documentId,
        companyId: knowledgeChunks.companyId,
        chunkIndex: knowledgeChunks.chunkIndex,
        content: knowledgeChunks.content,
        tokenCount: knowledgeChunks.tokenCount,
        metadata: knowledgeChunks.metadata,
        createdAt: knowledgeChunks.createdAt,
      })
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.companyId, companyId));

    if (chunks.length === 0) return [];

    // Run keyword search
    const results = searchKnowledge(
      chunks.map((c) => ({
        content: c.content,
        id: c.id,
        documentId: c.documentId,
      })),
      query,
      topK,
    );

    // Load document titles for the matched chunks
    const docIds = [...new Set(results.map((r) => r.chunk.documentId))];
    const docs = docIds.length > 0
      ? await this.db.drizzle
          .select({ id: knowledgeDocuments.id, title: knowledgeDocuments.title })
          .from(knowledgeDocuments)
          .where(eq(knowledgeDocuments.companyId, companyId))
      : [];

    const docTitleMap = new Map(docs.map((d) => [d.id, d.title]));

    return results.map((r) => {
      const fullChunk = chunks.find((c) => c.id === r.chunk.id)!;
      return {
        chunk: fullChunk as unknown as KnowledgeChunk,
        score: r.score,
        documentTitle: docTitleMap.get(r.chunk.documentId) ?? 'Unknown',
        documentId: r.chunk.documentId,
      };
    });
  }

  /**
   * Build relevant context from knowledge base for an agent executing a task.
   */
  async getContextForAgent(
    companyId: string,
    _agentId: string,
    taskDescription: string,
  ): Promise<string> {
    const results = await this.searchCompanyKnowledge(companyId, taskDescription, 5);

    if (results.length === 0) return '';

    const contextParts: string[] = ['## Company Knowledge\n'];

    for (const result of results) {
      contextParts.push(
        `### From "${result.documentTitle}" (relevance: ${(result.score * 100).toFixed(0)}%)\n` +
        result.chunk.content + '\n',
      );
    }

    return contextParts.join('\n');
  }

  /**
   * Delete a document and all its chunks (cascade).
   */
  async deleteDocument(documentId: string, companyId: string): Promise<void> {
    const { knowledgeDocuments, knowledgeChunks } = this.db.schema;

    // Delete chunks first (in case CASCADE isn't working with raw SQL tables)
    await this.db.drizzle
      .delete(knowledgeChunks)
      .where(eq(knowledgeChunks.documentId, documentId));

    await this.db.drizzle
      .delete(knowledgeDocuments)
      .where(
        and(
          eq(knowledgeDocuments.id, documentId),
          eq(knowledgeDocuments.companyId, companyId),
        ),
      );
  }

  /**
   * List all documents for a company.
   */
  async listDocuments(companyId: string): Promise<KnowledgeDocument[]> {
    const { knowledgeDocuments } = this.db.schema;

    const rows = await this.db.drizzle
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.companyId, companyId))
      .orderBy(knowledgeDocuments.createdAt);

    return rows as unknown as KnowledgeDocument[];
  }

  /**
   * Get a single document with its chunks.
   */
  async getDocument(documentId: string, companyId: string) {
    const { knowledgeDocuments, knowledgeChunks } = this.db.schema;

    const [doc] = await this.db.drizzle
      .select()
      .from(knowledgeDocuments)
      .where(
        and(
          eq(knowledgeDocuments.id, documentId),
          eq(knowledgeDocuments.companyId, companyId),
        ),
      )
      .limit(1);

    if (!doc) return null;

    const chunks = await this.db.drizzle
      .select()
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.documentId, documentId))
      .orderBy(knowledgeChunks.chunkIndex);

    return { ...doc, chunks };
  }
}
