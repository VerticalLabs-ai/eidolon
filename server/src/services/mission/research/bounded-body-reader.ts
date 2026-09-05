/**
 * Bounded streaming response body reader (VAL-RES-057, VAL-RES-093).
 *
 * Streams and counts decoded response bytes rather than calling an
 * unbounded body reader. Aborts immediately when a declared or streamed
 * decoded body exceeds its cap. Handles chunked transfer without
 * `Content-Length` and compressed/decompressed payloads (the
 * `ReadableStream` exposed by `Response.body` yields already-decoded bytes).
 *
 * A header-then-stall response is bounded by the operation deadline:
 * callers pass the deadline `AbortSignal`; when it aborts, the reader
 * cancels the stream and rejects, persisting no partial body.
 */

import { type ResearchOperation, ResearchProviderError } from './spi.js';
import type { ResearchProviderName } from './origins.js';

// ---------------------------------------------------------------------------
// Cap
// ---------------------------------------------------------------------------

/** Maximum decoded provider response body size, in UTF-8 bytes (5 MiB). */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/**
 * Read a provider response body as a UTF-8 string, aborting at `maxBytes`
 * decoded bytes (default 5 MiB). When `signal` aborts (deadline/caller
 * cancellation), the stream is cancelled and the call rejects.
 *
 * @throws ResearchProviderError('MALFORMED_RESPONSE') when the decoded body
 *   exceeds the cap (no partial body is returned).
 * @throws ResearchProviderError('PROVIDER_TIMEOUT') when `signal` aborts
 *   before the body completes.
 * @throws ResearchProviderError('CANCELLED') when `signal` is the caller
 *   cancellation signal (not a deadline) — distinguished by the caller.
 */
export async function readBoundedResponseBody(
  response: Response,
  operation: ResearchOperation,
  provider: ResearchProviderName,
  maxBytes: number = MAX_RESPONSE_BYTES,
  signal?: AbortSignal,
): Promise<string> {
  // Fast path: declared Content-Length over the cap → abort before streaming.
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number.parseInt(contentLength, 10) > maxBytes) {
    throw new ResearchProviderError(
      'MALFORMED_RESPONSE',
      `${provider} response exceeds maximum size`,
      provider,
      operation,
    );
  }

  const body = response.body;
  if (body === null) {
    // No body — treat as empty.
    return '';
  }

  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  const chunks: string[] = [];
  let totalBytes = 0;
  let aborted = false;

  // If a deadline/caller signal aborts, cancel the reader so any pending
  // read() rejects and we stop accumulating.
  const onAbort = () => {
    aborted = true;
    reader.cancel().catch(() => {
      /* reader may already be closed */
    });
  };
  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value === undefined) {
        continue;
      }
      totalBytes += value.byteLength;
      // Abort at the cap before accumulating the oversized chunk.
      if (totalBytes > maxBytes) {
        // Cancel the stream so we do not keep draining a large/chunked body.
        await reader.cancel().catch(() => {
          /* ignore */
        });
        throw new ResearchProviderError(
          'MALFORMED_RESPONSE',
          `${provider} response exceeds maximum size`,
          provider,
          operation,
        );
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }

    // If the deadline/caller signal aborted mid-stream, the cancel resolves
    // the pending read() as `done`; treat that as a timeout, not a complete
    // body, so no partial body is persisted (VAL-RES-093).
    if (aborted) {
      throw new ResearchProviderError(
        'PROVIDER_TIMEOUT',
        `${provider} response streaming aborted by deadline`,
        provider,
        operation,
      );
    }

    // Flush the decoder.
    chunks.push(decoder.decode());
    return chunks.join('');
  } catch (err) {
    if (err instanceof ResearchProviderError) {
      throw err;
    }
    // A cancelled read surfaces as a TypeError in undici; if we aborted,
    // convert to a timeout/cancellation error.
    if (aborted) {
      throw new ResearchProviderError(
        'PROVIDER_TIMEOUT',
        `${provider} response streaming aborted`,
        provider,
        operation,
      );
    }
    throw new ResearchProviderError(
      'MALFORMED_RESPONSE',
      `Failed to read ${provider} response body`,
      provider,
      operation,
    );
  } finally {
    if (signal) {
      signal.removeEventListener('abort', onAbort);
    }
    try {
      reader.releaseLock();
    } catch {
      /* reader may already be released/cancelled */
    }
  }
}
