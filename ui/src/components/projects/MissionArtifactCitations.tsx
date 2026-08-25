import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useArtifactRevisionCitations, useArtifactRevisionProvenance } from '@/lib/hooks';
import type { MissionCitationDetail, MissionProvenanceDetail } from '@/lib/api';
import { ExternalLink, ArrowLeft, X, AlertTriangle } from 'lucide-react';

/**
 * MissionArtifactCitations — exact inline citation, source-link, deep-link,
 * and provenance navigation.
 *
 * (feature m5-f14-citation-navigation-ui; VAL-RES-027, VAL-RES-028,
 *  VAL-RES-029, VAL-RES-030, VAL-RES-031, VAL-RES-037, VAL-RES-038,
 *  VAL-CROSS-040, VAL-CROSS-041, VAL-CROSS-047)
 *
 * Renders an `EvidenceDocumentV1` artifact revision with inline citation
 * marks as clickable, keyboard-accessible controls. Activating a mark
 * opens a provenance drawer bound to the EXACT viewed artifact revision,
 * showing citation key, source title/domain, exact quote, retrieval time,
 * provider/operation, source revision, artifact version, and producing
 * run/step. The drawer defaults to the viewed revision and shows a
 * newer-revision notice rather than substituting current provenance
 * (VAL-RES-031, VAL-CROSS-041). External source links use validated
 * canonical HTTPS with safe attributes (VAL-RES-029). Deep links focus the
 * exact citation, not the latest revision (VAL-RES-037).
 *
 * All quote/title/author/URL text is untrusted data and rendered inert —
 * never parsed as HTML, never concatenated into instructions. Citations
 * never float to newer content; the browser never invents citation or
 * provenance state.
 *
 * Accessibility:
 * - Inline marks are keyboard-accessible buttons with explicit aria-labels.
 * - The provenance drawer is a semantic dialog with focus management.
 * - Status is conveyed with text + icon, never color alone.
 * - External links announce they open a new context.
 * - The layout reflows at narrow mobile viewports.
 */

// ── External source URL validation (VAL-RES-029) ─────────────────────────

/**
 * Validate a canonical source URL for safe external linking. Rejects
 * non-HTTPS schemes, credentials, fragments, and non-443 ports.
 * (VAL-RES-029)
 */
export function validateExternalSourceUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') {return false;}
    if (u.username || u.password) {return false;}
    if (u.hash) {return false;}
    if (u.port && u.port !== '443') {return false;}
    return true;
  } catch {
    return false;
  }
}

/** Extract the domain from a canonical URL for display. */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// ── Inline citation mark (VAL-RES-027, VAL-RES-028) ───────────────────────

/**
 * A stable, keyboard-accessible inline citation mark. Renders the ordinal
 * in reading order. Pointer and keyboard (Enter/Space) activation opens the
 * provenance drawer without losing the artifact reading position
 * (VAL-RES-027, VAL-RES-028).
 */
export function MissionCitationMark({
  ordinal,
  citationId,
  onSelect,
  isTarget,
}: {
  ordinal: number;
  citationId: string;
  onSelect: (citationId: string) => void;
  isTarget?: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isTarget && ref.current) {
      ref.current.focus();
      if (typeof ref.current.scrollIntoView === 'function') {
        ref.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }, [isTarget]);

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onSelect(citationId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(citationId);
        }
      }}
      aria-label={`Citation ${ordinal}`}
      data-citation-target={isTarget ? 'true' : undefined}
      data-testid={`citation-mark-${citationId}`}
      className="inline-flex items-center align-baseline rounded px-0.5 text-xs font-medium text-accent bg-accent/10 hover:bg-accent/20 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none motion-reduce:transition-none transition-colors"
    >
      [{ordinal}]
    </button>
  );
}

// ── External source link (VAL-RES-029) ───────────────────────────────────

/**
 * A safe external source link. Uses validated canonical HTTPS, sets
 * `target="_blank"` and `rel="noopener noreferrer nofollow"`, and its
 * accessible name announces that it opens a new context (VAL-RES-029).
 * Unsafe URLs are rejected and render nothing.
 */
export function MissionSourceLink({ url, label }: { url: string; label: string }) {
  if (!validateExternalSourceUrl(url)) {
    return null;
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      aria-label={`${label} — opens in a new tab`}
      className="inline-flex items-center gap-1 text-xs text-accent underline hover:text-accent/80 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none rounded break-words"
      dir="ltr"
    >
      <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
      {label}
    </a>
  );
}

// ── Provenance drawer (VAL-RES-030, VAL-RES-031, VAL-CROSS-040, VAL-CROSS-047) ─

/**
 * The provenance drawer for a citation. Shows all required fields
 * (VAL-RES-030), defaults to the viewed revision (VAL-RES-031), shows a
 * newer-revision notice (VAL-CROSS-041), provides a return link to the
 * producing Mission (VAL-CROSS-040, VAL-CROSS-047), and an external source
 * link (VAL-RES-029). Closes on Escape and restores focus (VAL-RES-028).
 */
export function MissionProvenanceDrawer({
  open,
  citation,
  provenance,
  companyId,
  projectId,
  runId,
  onClose,
}: {
  open: boolean;
  citation: MissionCitationDetail | null;
  provenance: MissionProvenanceDetail | null;
  companyId: string;
  projectId: string;
  runId: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // Focus management: move focus to the drawer on open, restore on close.
  useEffect(() => {
    if (open && closeBtnRef.current) {
      closeBtnRef.current.focus();
    }
  }, [open]);

  // Close on Escape (VAL-RES-028).
  useEffect(() => {
    if (!open) {return;}
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open || !citation) {
    return null;
  }

  const domain = extractDomain(citation.canonicalUrl);
  const returnLinkPath = `/company/${companyId}/projects/${projectId}?tab=work&thread=&mission=${runId}`;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="provenance-drawer-title"
      className="fixed inset-y-0 right-0 z-50 w-full max-w-md overflow-y-auto border-l border-white/[0.08] bg-surface p-4 shadow-2xl"
      data-testid="provenance-drawer"
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 id="provenance-drawer-title" className="text-sm font-semibold text-text-primary">
          Provenance — Citation {citation.ordinal}
        </h3>
        <button
          ref={closeBtnRef}
          type="button"
          onClick={onClose}
          aria-label="Close provenance drawer"
          className="rounded-lg p-1 text-text-muted hover:text-text-primary hover:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {/* Newer-revision notice (VAL-RES-031, VAL-CROSS-041) */}
      {provenance?.newerArtifactVersionExists && (
        <div
          className="mb-3 rounded-lg border border-warning/20 bg-warning/[0.06] px-3 py-2"
          role="status"
          aria-live="polite"
          data-testid="newer-revision-notice"
        >
          <p className="text-xs text-warning flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />A newer revision exists.
            This provenance is bound to version {citation.artifactVersion}.
          </p>
        </div>
      )}

      {/* Provenance unavailable notice (graceful degradation) */}
      {!provenance && (
        <div
          className="mb-3 rounded-lg border border-warning/20 bg-warning/[0.04] px-3 py-2"
          role="status"
          aria-live="polite"
        >
          <p className="text-xs text-warning">Provenance unavailable for this revision.</p>
        </div>
      )}

      <dl className="space-y-2 text-xs">
        {/* Citation key/ordinal */}
        <div>
          <dt className="font-medium text-text-secondary">Citation key</dt>
          <dd className="text-text-primary">Key {citation.ordinal}</dd>
        </div>

        {/* Source title/domain */}
        {citation.frozenTitle && (
          <div>
            <dt className="font-medium text-text-secondary">Source title</dt>
            <dd className="text-text-primary break-words">{citation.frozenTitle}</dd>
          </div>
        )}
        <div>
          <dt className="font-medium text-text-secondary">Domain</dt>
          <dd className="text-text-primary break-all font-mono" dir="ltr">
            {domain}
          </dd>
        </div>

        {/* Exact quote (untrusted data, rendered inert) */}
        <div>
          <dt className="font-medium text-text-secondary">Exact quote</dt>
          <dd className="text-text-primary break-words">
            <blockquote className="border-l-2 border-white/[0.12] pl-2 italic">
              {citation.quote}
            </blockquote>
          </dd>
        </div>

        {/* Retrieval time */}
        <div>
          <dt className="font-medium text-text-secondary">Retrieved:</dt>
          <dd className="text-text-primary">
            <time dateTime={citation.frozenRetrievedAt}>
              {new Date(citation.frozenRetrievedAt).toLocaleString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </time>
          </dd>
        </div>

        {/* Provider/operation */}
        <div>
          <dt className="font-medium text-text-secondary">Provider</dt>
          <dd className="text-text-primary">
            {citation.frozenProvider}
            {citation.frozenOperation && (
              <span className="text-text-muted"> · {citation.frozenOperation}</span>
            )}
          </dd>
        </div>

        {/* Source revision */}
        <div>
          <dt className="font-medium text-text-secondary">Source revision</dt>
          <dd className="text-text-primary break-all font-mono" dir="ltr">
            {citation.sourceRevisionId}
          </dd>
        </div>

        {/* Artifact version */}
        <div>
          <dt className="font-medium text-text-secondary">Artifact version</dt>
          <dd className="text-text-primary">Version {citation.artifactVersion}</dd>
        </div>

        {/* Producing run/step (from provenance) */}
        {provenance && (
          <>
            <div>
              <dt className="font-medium text-text-secondary">Producing run</dt>
              <dd className="text-text-primary break-all font-mono" dir="ltr">
                {provenance.runId}
              </dd>
            </div>
            {provenance.producingStepKey && (
              <div>
                <dt className="font-medium text-text-secondary">Producing step</dt>
                <dd className="text-text-primary break-words">{provenance.producingStepKey}</dd>
              </div>
            )}
            {provenance.producingChildRunId && (
              <div>
                <dt className="font-medium text-text-secondary">Producing child</dt>
                <dd className="text-text-primary break-all font-mono" dir="ltr">
                  {provenance.producingChildRunId}
                </dd>
              </div>
            )}
          </>
        )}
      </dl>

      {/* External source link (VAL-RES-029, VAL-CROSS-040) */}
      <div className="mt-3">
        <MissionSourceLink url={citation.canonicalUrl} label="View source" />
      </div>

      {/* Return link to producing Mission (VAL-CROSS-040, VAL-CROSS-047) */}
      <div className="mt-3 border-t border-white/[0.06] pt-3">
        <Link
          to={returnLinkPath}
          className="inline-flex items-center gap-1.5 text-xs text-accent underline hover:text-accent/80 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none rounded"
          aria-label="Back to Mission"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Back to Mission
        </Link>
      </div>
    </div>
  );
}

// ── Evidence document rendering ───────────────────────────────────────────

/** A text span or inline citation mark within a block. */
type TextSpan = { type: 'text'; text: string } | { type: 'citation'; citationId: string };

/** Supported block types in an EvidenceDocumentV1. */
type EvidenceBlock =
  | { type: 'heading'; level: number; spans: TextSpan[] }
  | { type: 'paragraph'; spans: TextSpan[] }
  | { type: 'list'; ordered: boolean; items: TextSpan[][] }
  | { type: 'table'; rows: TextSpan[][] }
  | { type: 'quote'; spans: TextSpan[] }
  | { type: 'code'; language?: string; text: string };

/** The closed evidence document. */
interface EvidenceDocumentV1 {
  schemaVersion: number;
  blocks: EvidenceBlock[];
}

/** Render a sequence of text spans and citation marks. */
function renderSpans(
  spans: TextSpan[],
  citationMap: Map<string, MissionCitationDetail>,
  onSelectCitation: (id: string) => void,
  targetCitationId?: string,
): React.ReactNode[] {
  return spans.map((span, i) => {
    if (span.type === 'text') {
      return <span key={i}>{span.text}</span>;
    }
    const cite = citationMap.get(span.citationId);
    if (!cite) {
      // Dangling citation mark — render as inert text, no broken link.
      return (
        <span key={i} className="text-text-muted">
          [?]
        </span>
      );
    }
    return (
      <MissionCitationMark
        key={i}
        ordinal={cite.ordinal}
        citationId={cite.citationId}
        onSelect={onSelectCitation}
        isTarget={targetCitationId === cite.citationId}
      />
    );
  });
}

/** Render a single evidence document block. */
function renderBlock(
  block: EvidenceBlock,
  citationMap: Map<string, MissionCitationDetail>,
  onSelectCitation: (id: string) => void,
  targetCitationId?: string,
): React.ReactNode {
  switch (block.type) {
    case 'heading': {
      const level = Math.min(Math.max(block.level, 1), 6);
      const className = 'text-sm font-semibold text-text-primary mb-2 mt-3 break-words';
      const spans = renderSpans(block.spans, citationMap, onSelectCitation, targetCitationId);
      if (level === 1)
        {return (
          <h1 key={block.type} className={className}>
            {spans}
          </h1>
        );}
      if (level === 2)
        {return (
          <h2 key={block.type} className={className}>
            {spans}
          </h2>
        );}
      if (level === 3)
        {return (
          <h3 key={block.type} className={className}>
            {spans}
          </h3>
        );}
      if (level === 4)
        {return (
          <h4 key={block.type} className={className}>
            {spans}
          </h4>
        );}
      if (level === 5)
        {return (
          <h5 key={block.type} className={className}>
            {spans}
          </h5>
        );}
      return (
        <h6 key={block.type} className={className}>
          {spans}
        </h6>
      );
    }
    case 'paragraph':
      return (
        <p key={block.type} className="text-sm text-text-primary mb-2 break-words leading-relaxed">
          {renderSpans(block.spans, citationMap, onSelectCitation, targetCitationId)}
        </p>
      );
    case 'quote':
      return (
        <blockquote
          key={block.type}
          className="border-l-2 border-white/[0.12] pl-3 text-sm text-text-secondary mb-2 italic break-words"
        >
          {renderSpans(block.spans, citationMap, onSelectCitation, targetCitationId)}
        </blockquote>
      );
    case 'list':
      return block.ordered ? (
        <ol key={block.type} className="list-decimal pl-4 mb-2 space-y-0.5">
          {block.items.map((item, i) => (
            <li key={i} className="text-sm text-text-primary break-words">
              {renderSpans(item, citationMap, onSelectCitation, targetCitationId)}
            </li>
          ))}
        </ol>
      ) : (
        <ul key={block.type} className="list-disc pl-4 mb-2 space-y-0.5">
          {block.items.map((item, i) => (
            <li key={i} className="text-sm text-text-primary break-words">
              {renderSpans(item, citationMap, onSelectCitation, targetCitationId)}
            </li>
          ))}
        </ul>
      );
    case 'table':
      return (
        <div key={block.type} className="mb-2 overflow-x-auto">
          <table className="text-sm text-text-primary border-collapse">
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i} className="border-b border-white/[0.06]">
                  {row.map((cell, j) => (
                    <td key={j} className="px-2 py-1 break-words">
                      {renderSpans([cell], citationMap, onSelectCitation, targetCitationId)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'code':
      return (
        <pre
          key={block.type}
          className="mb-2 rounded-lg border border-white/[0.06] bg-black/20 p-3 text-xs text-text-primary overflow-x-auto"
          dir="ltr"
        >
          <code>{block.text}</code>
        </pre>
      );
    default:
      return null;
  }
}

// ── Main component ───────────────────────────────────────────────────────

/**
 * Render an artifact revision with inline citation marks, provenance
 * drawer, external source links, deep-link focus, and return navigation.
 *
 * The artifact content is an `EvidenceDocumentV1`. Citations are fetched
 * from the server and bound to the EXACT viewed artifact revision. The
 * browser never invents citation or provenance state; every field is
 * server-authoritative.
 */
export function MissionArtifactCitations({
  companyId,
  projectId,
  runId,
  artifactId,
  artifactVersion,
  content,
  targetCitationId,
}: {
  companyId: string;
  projectId: string;
  runId: string;
  artifactId: string;
  artifactVersion: number;
  /** EvidenceDocumentV1 content (decrypted from the artifact revision). */
  content: Record<string, unknown>;
  /** Optional citation ID to focus on mount (deep-link target, VAL-RES-037). */
  targetCitationId?: string;
}) {
  const citationsQuery = useArtifactRevisionCitations(
    companyId,
    projectId,
    artifactId,
    artifactVersion,
  );
  const provenanceQuery = useArtifactRevisionProvenance(
    companyId,
    projectId,
    artifactId,
    artifactVersion,
  );

  const [selectedCitationId, setSelectedCitationId] = useState<string | null>(null);

  const citations = (citationsQuery.data?.citations ?? []) as MissionCitationDetail[];
  const provenance = (provenanceQuery.data ?? null) as MissionProvenanceDetail | null;

  // Map citationId → citation detail for inline mark resolution.
  const citationMap = useMemo(() => {
    const m = new Map<string, MissionCitationDetail>();
    for (const c of citations) {
      m.set(c.citationId, c);
    }
    return m;
  }, [citations]);

  const selectedCitation = selectedCitationId
    ? (citationMap.get(selectedCitationId) ?? null)
    : null;

  const handleSelectCitation = (citationId: string) => {
    setSelectedCitationId(citationId);
  };

  const handleCloseDrawer = () => {
    setSelectedCitationId(null);
  };

  // Parse the content as an EvidenceDocumentV1.
  const doc = content as unknown as EvidenceDocumentV1;
  const blocks = Array.isArray(doc?.blocks) ? doc.blocks : [];

  return (
    <section
      id={`mission-artifact-${artifactId}-version-${artifactVersion}`}
      className="mb-3 w-full max-w-full break-words"
      aria-labelledby="artifact-citations-heading"
      data-testid="mission-artifact-citations"
    >
      <div className="flex items-center justify-between mb-2">
        <h4 id="artifact-citations-heading" className="text-xs font-medium text-text-secondary">
          Artifact — Version {artifactVersion}
        </h4>
        {citations.length > 0 && (
          <span className="text-xs text-text-muted tabular-nums">
            {citations.length} citation{citations.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {/* Newer-revision notice (VAL-RES-031, VAL-CROSS-041) — shown outside
          the drawer so the user sees it without opening a citation. */}
      {provenance?.newerArtifactVersionExists && (
        <div
          className="mb-2 rounded-lg border border-warning/20 bg-warning/[0.04] px-3 py-2"
          role="status"
          aria-live="polite"
          data-testid="artifact-newer-revision-notice"
        >
          <p className="text-xs text-warning flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />A newer revision exists.
            This view is bound to version {artifactVersion}.
          </p>
        </div>
      )}

      {/* Citation loading error (VAL-RES-028 graceful degradation) */}
      {citationsQuery.isError && !citationsQuery.data && (
        <div role="alert" className="mb-2 rounded-lg border border-error/20 bg-error/10 px-3 py-2">
          <p className="text-xs text-error">
            Could not load citations for this revision. The artifact content is still visible.
          </p>
        </div>
      )}

      {/* Render evidence document blocks with inline citation marks */}
      <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 w-full max-w-full break-words">
        {blocks.map((block, i) =>
          renderBlock(block, citationMap, handleSelectCitation, targetCitationId),
        )}
        {blocks.length === 0 && (
          <p className="text-xs text-text-muted">No content for this revision.</p>
        )}
      </div>

      {/* Return link to producing Mission (VAL-CROSS-047) — always visible */}
      <div className="mt-2 border-t border-white/[0.06] pt-2">
        <Link
          to={`/company/${companyId}/projects/${projectId}?tab=work&thread=&mission=${runId}`}
          className="inline-flex items-center gap-1.5 text-xs text-accent underline hover:text-accent/80 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none rounded"
          aria-label="Back to Mission"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Back to Mission
        </Link>
      </div>

      {/* Provenance drawer (VAL-RES-030, VAL-RES-031, VAL-CROSS-040, VAL-CROSS-047) */}
      <MissionProvenanceDrawer
        open={selectedCitation !== null}
        citation={selectedCitation}
        provenance={provenance}
        companyId={companyId}
        projectId={projectId}
        runId={runId}
        onClose={handleCloseDrawer}
      />
    </section>
  );
}
