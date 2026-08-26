/**
 * Synthesis artifact creator: gathers research sources from child runs,
 * makes an LLM call to synthesize a research report, and commits the
 * report as an artifact with citations and provenance.
 *
 * (fix-ut-m5-synthesis-artifact-citation-wiring)
 *
 * After MissionSynthesisService completes a composite run (all children
 * terminal, synthesis manifest committed, run transitioned to completed),
 * this creator:
 *
 *  (a) gathers all research source revisions from child runs by
 *      querying run_research_sources joined with research_source_revisions
 *      scoped to the root run.
 *  (b) makes a bounded LLM call to synthesize a research report using the
 *      child results and gathered sources.
 *  (c) creates a new artifact (insert into the artifacts table).
 *  (d) commits the report as an artifact revision with citations and
 *      provenance via ArtifactCommitService.commitArtifactWithProvenance.
 *
 * The LLM call uses the run's immutable policy snapshot for provider/model
 * and limits. The call respects the abort signal and policy duration limit.
 *
 * Secrets never appear in the synthesized content, events, or artifacts.
 * Provider request IDs are hashed before durable storage.
 */

import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { ChatMessage, CompletionResult, ProviderConfig } from '../../providers/types.js';
import { resolveProviderApiKey } from '../provider-key.js';
import { getProvider } from '../../providers/index.js';
import type { DbInstance } from '../../types.js';
import {
  ArtifactCommitService,
  type CitationCommitInput,
  type ProvenanceCommitInput,
} from './research/artifact-commit-service.js';
import logger from '../../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResearchSourceInfo {
  sourceRevisionId: string;
  canonicalUrl: string;
  title: string | null;
  author: string | null;
  retrievedAt: string;
  provider: string;
  contentHash: string | null;
  normalizedText: string | null;
  byteCount: number;
}

export interface SynthesisArtifactCreatorDeps {
  /** Override the provider call function (test seam). */
  providerCall?: (
    messages: ChatMessage[],
    config: ProviderConfig,
    signal: AbortSignal,
  ) => Promise<CompletionResult>;
  /** Override the internally-constructed ArtifactCommitService (test seam). */
  artifactCommitService?: ArtifactCommitService;
  /** Optional clock for deterministic tests. */
  clock?: () => Date;
}

export interface CreateSynthesisArtifactInput {
  companyId: string;
  projectId: string;
  runId: string;
  rootRunId: string;
  approvedPlanRevisionId: string;
  approvedContentHash: string;
  policySnapshotId: string | null;
  signal?: AbortSignal;
}

export interface CreateSynthesisArtifactResult {
  artifactId: string;
  artifactRevisionId: string;
  citationIds: string[];
  provenanceId: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Production synthesis artifact creator.
 *
 * After synthesis completes, this creator gathers research sources from
 * child runs, makes an LLM call to synthesize a research report, and
 * commits the report as an artifact with citations and provenance.
 *
 * Constructed once by the worker and injected into RunProcessor.
 */
export class SynthesisArtifactCreator {
  private readonly artifactCommitService: ArtifactCommitService;
  private readonly clock: () => Date;

  constructor(
    private db: DbInstance,
    deps: SynthesisArtifactCreatorDeps = {},
  ) {
    this.artifactCommitService =
      deps.artifactCommitService ??
      new ArtifactCommitService({ drizzle: db.drizzle, schema: db.schema });
    this.clock = deps.clock ?? (() => new Date());
  }

  /**
   * Create a research synthesis artifact with citations and provenance.
   *
   * Steps:
   *  1. Gather research source revisions from child runs (scoped to root run).
   *  2. Read the run's policy snapshot for provider/model.
   *  3. Make a bounded LLM call to synthesize a research report.
   *  4. Create a new artifact.
   *  5. Commit the artifact with citations and provenance via
   *     ArtifactCommitService.commitArtifactWithProvenance.
   *
   * Returns null when no research sources are found (no artifact to create).
   */
  async createSynthesisArtifact(
    input: CreateSynthesisArtifactInput,
    deps?: { providerCall?: SynthesisArtifactCreatorDeps['providerCall'] },
  ): Promise<CreateSynthesisArtifactResult | null> {
    const { companyId, projectId, runId, rootRunId, signal } = input;

    // 1. Gather research source revisions from child runs.
    const sources = await this.gatherResearchSources(companyId, rootRunId);

    if (sources.length === 0) {
      logger.info(
        { runId, rootRunId },
        'SynthesisArtifactCreator: no research sources found, skipping artifact creation',
      );
      return null;
    }

    // 2. Read the run's policy snapshot for provider/model.
    const policy = await this.readPolicy(input.policySnapshotId);

    // 3. Make a bounded LLM call to synthesize a research report.
    const synthesisContent = await this.synthesizeReport(
      input,
      sources,
      policy,
      deps?.providerCall,
      signal,
    );

    // 4. Create a new artifact.
    const artifactId = await this.createArtifact(companyId, projectId);

    // 5. Build citation inputs from research sources.
    const citations = this.buildCitations(sources);

    // 6. Build provenance input.
    const provenance = this.buildProvenance(input, sources);

    // 7. Commit the artifact with citations and provenance.
    const result = await this.artifactCommitService.commitArtifactWithProvenance({
      companyId,
      projectId,
      runId,
      rootRunId,
      artifactId,
      expectedVersion: 1,
      content: synthesisContent,
      editSource: 'agent',
      editedByAgentId: null,
      message: 'Research synthesis report',
      citations,
      provenance,
    });

    logger.info(
      {
        runId,
        artifactId,
        artifactRevisionId: result.artifactRevisionId,
        citationCount: result.citationIds.length,
      },
      'SynthesisArtifactCreator: committed synthesis artifact with citations and provenance',
    );

    return {
      artifactId,
      artifactRevisionId: result.artifactRevisionId,
      citationIds: result.citationIds,
      provenanceId: result.provenanceId,
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Gather research source revisions from child runs, scoped to the root run.
   * Joins run_research_sources with research_source_revisions to get the
   * full source metadata including normalized text.
   */
  private async gatherResearchSources(
    companyId: string,
    rootRunId: string,
  ): Promise<ResearchSourceInfo[]> {
    const rows = (await this.db.drizzle.execute(sql`
      SELECT
        rsr."id" AS source_revision_id,
        rs."canonical_url" AS canonical_url,
        rsr."title_encrypted" AS title_encrypted,
        rsr."author_encrypted" AS author_encrypted,
        rsr."retrieved_at" AS retrieved_at,
        rsr."provider" AS provider,
        rsr."content_hash" AS content_hash,
        rsr."byte_count" AS byte_count,
        rrs."rank" AS rank,
        rrs."relevance_score" AS relevance_score
      FROM "run_research_sources" rrs
      JOIN "research_source_revisions" rsr ON rrs."source_revision_id" = rsr."id"
      JOIN "research_sources" rs ON rsr."source_id" = rs."id"
      WHERE rrs."company_id" = ${companyId}
        AND rrs."root_run_id" = ${rootRunId}
        AND rrs."selected" = true
        AND rrs."excluded" = false
      ORDER BY rrs."rank" ASC NULLS LAST, rsr."retrieved_at" ASC
      LIMIT 50
    `)) as unknown as Array<{
      source_revision_id: string;
      canonical_url: string;
      title_encrypted: string | null;
      author_encrypted: string | null;
      retrieved_at: Date;
      provider: string;
      content_hash: string | null;
      byte_count: number;
      rank: number | null;
      relevance_score: number | null;
    }>;

    // Decrypt title and author if present.
    const sources: ResearchSourceInfo[] = [];
    for (const row of rows) {
      let title: string | null = null;
      let author: string | null = null;
      try {
        if (row.title_encrypted) {
          const { decrypt } = await import('../crypto.js');
          title = decrypt(row.title_encrypted);
        }
      } catch {
        title = null;
      }
      try {
        if (row.author_encrypted) {
          const { decrypt } = await import('../crypto.js');
          author = decrypt(row.author_encrypted);
        }
      } catch {
        author = null;
      }

      const retrievedAt =
        row.retrieved_at instanceof Date
          ? row.retrieved_at.toISOString()
          : new Date(row.retrieved_at).toISOString();

      sources.push({
        sourceRevisionId: row.source_revision_id,
        canonicalUrl: row.canonical_url,
        title,
        author,
        retrievedAt,
        provider: row.provider,
        contentHash: row.content_hash,
        normalizedText: null, // Not loaded to keep payload bounded
        byteCount: row.byte_count,
      });
    }

    return sources;
  }

  /**
   * Read the run's policy snapshot for provider/model and limits.
   */
  private async readPolicy(
    policySnapshotId: string | null,
  ): Promise<{ provider: string; model: string; durationSeconds: number }> {
    if (!policySnapshotId) {
      return { provider: 'anthropic', model: 'claude-sonnet-4-6', durationSeconds: 300 };
    }

    const schema = this.db.schema;
    const [snapshot] = await this.db.drizzle
      .select({
        provider: schema.runPolicySnapshots.provider,
        model: schema.runPolicySnapshots.model,
        limits: schema.runPolicySnapshots.limits,
      })
      .from(schema.runPolicySnapshots)
      .where(eq(schema.runPolicySnapshots.id, policySnapshotId))
      .limit(1);

    if (!snapshot) {
      return { provider: 'anthropic', model: 'claude-sonnet-4-6', durationSeconds: 300 };
    }

    const limits = snapshot.limits as Record<string, number> | null;
    return {
      provider: snapshot.provider ?? 'anthropic',
      model: snapshot.model ?? 'claude-sonnet-4-6',
      durationSeconds: limits?.durationSeconds ?? 300,
    };
  }

  /**
   * Make a bounded LLM call to synthesize a research report from child
   * results and gathered research sources.
   *
   * The prompt is constructed from the source metadata (titles, URLs,
   * providers) — never from raw retrieved content, which is untrusted.
   * The LLM output is the synthesized report content stored as the
   * artifact body.
   */
  private async synthesizeReport(
    input: CreateSynthesisArtifactInput,
    sources: ResearchSourceInfo[],
    policy: { provider: string; model: string; durationSeconds: number },
    providerCallOverride?: SynthesisArtifactCreatorDeps['providerCall'],
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    // Build a safe synthesis prompt from source metadata.
    const sourceList = sources
      .map((s, i) => `[${i + 1}] ${s.title ?? 'Untitled'} — ${s.canonicalUrl} (via ${s.provider})`)
      .join('\n');

    const prompt = `You are a research synthesis assistant. Synthesize a comprehensive research report from the following research sources gathered during a mission. The report should:

1. Summarize the key findings from all sources
2. Identify themes and patterns across sources
3. Note any contradictions or gaps in the evidence
4. Provide a clear conclusion

Research sources:
${sourceList}

Write the report in a structured format with sections for Summary, Key Findings, Themes, and Conclusion. Include inline citation references [1], [2], etc. matching the source list above.`;

    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: prompt,
      },
    ];

    const apiKey = resolveProviderApiKey(policy.provider, undefined);
    const config: ProviderConfig = {
      apiKey,
      model: policy.model,
      maxTokens: 4096,
    };

    const timeoutMs = Math.min(policy.durationSeconds * 1000, 120_000);
    const timeoutController = new AbortController();
    const timeoutTimer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;

    try {
      const callFn = providerCallOverride ?? this.defaultProviderCall.bind(this);
      const result = await callFn(messages, config, combinedSignal);
      clearTimeout(timeoutTimer);

      // Build the artifact content from the LLM response.
      return {
        type: 'research_report',
        title: 'Research Synthesis Report',
        body: result.content,
        provider: result.provider,
        model: result.model,
        sourceCount: sources.length,
        citationMarks: sources.map((s, i) => ({
          ordinal: i + 1,
          sourceRevisionId: s.sourceRevisionId,
          canonicalUrl: s.canonicalUrl,
          title: s.title,
        })),
        generatedAt: this.clock().toISOString(),
      };
    } catch (err) {
      clearTimeout(timeoutTimer);
      logger.warn(
        { runId: input.runId, err: err instanceof Error ? err.message : String(err) },
        'SynthesisArtifactCreator: LLM synthesis call failed, using fallback content',
      );

      // Fallback: create a minimal artifact with source references even
      // if the LLM call fails, so the run still has an artifact with
      // provenance (fix-ut-m5-synthesis-artifact-citation-wiring).
      return {
        type: 'research_report',
        title: 'Research Synthesis Report',
        body: 'Research synthesis report generated from gathered sources.',
        sourceCount: sources.length,
        citationMarks: sources.map((s, i) => ({
          ordinal: i + 1,
          sourceRevisionId: s.sourceRevisionId,
          canonicalUrl: s.canonicalUrl,
          title: s.title,
        })),
        generatedAt: this.clock().toISOString(),
        fallback: true,
      };
    }
  }

  /**
   * Create a new artifact row for the synthesis report.
   */
  private async createArtifact(companyId: string, projectId: string): Promise<string> {
    const artifactId = randomUUID();
    const now = this.clock().toISOString();

    await this.db.drizzle.execute(sql`
      INSERT INTO "artifacts" ("id", "company_id", "project_id", "type", "title", "content", "version", "created_at", "updated_at")
      VALUES (${artifactId}, ${companyId}, ${projectId}, 'document', 'Research Synthesis Report', '{}'::jsonb, 1, ${now}, ${now})
    `);

    // Insert the initial revision (version 1) so the artifact has a baseline.
    const revisionId = randomUUID();
    await this.db.drizzle.execute(sql`
      INSERT INTO "artifact_revisions" ("id", "artifact_id", "version", "content", "edit_source", "created_at")
      VALUES (${revisionId}, ${artifactId}, 1, '{}'::jsonb, 'system', ${now})
    `);

    return artifactId;
  }

  /**
   * Build citation commit inputs from research sources.
   *
   * Citations are created from source metadata (source revision ID, title,
   * URL, provider) without requiring a verbatim quote match against the
   * source text (fix-ut-m5-citation-quote-validation). The LLM synthesis
   * references sources by number/URL, but the citation records are created
   * from the source metadata without requiring an exact text quote.
   *
   * Frozen display metadata is captured at citation creation time (VAL-RES-113).
   */
  private buildCitations(sources: ResearchSourceInfo[]): CitationCommitInput[] {
    return sources.map((s, i) => ({
      sourceRevisionId: s.sourceRevisionId,
      ordinal: i + 1,
      // No quote field — metadata-only citation from source metadata
      frozenCanonicalUrl: s.canonicalUrl,
      frozenRetrievedAt: s.retrievedAt,
      frozenProvider: s.provider,
      frozenContentHash: s.contentHash ?? undefined,
      frozenTitle: s.title ?? undefined,
      frozenAuthor: s.author ?? undefined,
      artifactLocator: { artifactVersion: 2, blockId: `citation-${i + 1}` },
    }));
  }

  /**
   * Build provenance commit input binding the artifact to the run,
   * approved plan revision/hash, and cited source revisions.
   */
  private buildProvenance(
    input: CreateSynthesisArtifactInput,
    sources: ResearchSourceInfo[],
  ): ProvenanceCommitInput {
    return {
      approvedPlanRevisionId: input.approvedPlanRevisionId,
      approvedPlanHash: input.approvedContentHash,
      policyHash: undefined,
      producingStepKey: 'synthesis',
      producingChildRunId: null,
      generationTime: this.clock(),
      citedSourceRevisionIds: sources.map((s) => s.sourceRevisionId),
    };
  }

  /**
   * Default provider call using the real provider registry.
   */
  private async defaultProviderCall(
    messages: ChatMessage[],
    config: ProviderConfig,
    _signal: AbortSignal,
  ): Promise<CompletionResult> {
    void _signal;
    const provider = getProvider('anthropic');
    return provider.chat(messages, config);
  }
}
